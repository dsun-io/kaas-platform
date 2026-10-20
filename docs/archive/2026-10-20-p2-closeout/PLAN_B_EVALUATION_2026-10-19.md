# 方案 B · 阶段一评估报告（2026-10-19 · 只取证未实施）

> ✅ **状态更新（2026-10-19 · 全部已确认）**：**结论 B-可行 已被采纳为决策 3**；
> §7 的三项修正**均已由用户确认**（冷启动线 ≤2,950ms / 本地双入口形态 / 测试处置 27% 重写）——
> 本文 §7 中的"待确认"表述以本行为准。权威口径（含三环境矩阵、10 条硬规则）：
> **[README.md](../README.md)（主交接文档）§3 / §9**。
> **结论：B-可行**（附 3 项条件性修正，见 §7；~~其中"相对冷启动验收线"待用户确认后方可用于实施~~）。
> 三线并行取证：eval-routes（路由/运行时）、eval-infra（基建/CI/基线）、auditor-plans（测试/成本）、
> poc-sqlalchemy（wrangler dev 实测）、lead（生产冷启动实测）。全部只读/本地实测，未改任何产品代码。
> 分支：`feat/plan-b-single-worker`（约束 7：独立分支 + PR，不直推 main）。

---

## 1. Q1 · 1200 条单测对 SQLAlchemy 的依赖深度 → **成本：中**

- 资产盘点：`backend/orchestrator/tests/` 94 文件 / 静态 1,301 个 `def test_`（`-m unit` 收集 1,200）；
  `backend/worker/tests/` 23 文件 / 287 + 5 integration。
- fixture 级取证（`tests/conftest.py` 639 行单文件）：
  - **内存 SQLite：无**（tests 下 0 命中）；db 用例全走真 PG `postgresql+asyncpg://…@localhost`（conftest:19-42），TCP 不通即 skip。
  - **隔离 = savepoint 事务回滚**（conftest:426-448 `join_transaction_mode="create_savepoint"` + teardown rollback），无每用例 TRUNCATE。
  - **psycopg2 时机依赖 ≈ 0**：tests 下 `psycopg2|isolation_level|AUTOCOMMIT` 0 命中；psycopg2 仅用于首跑 `alembic upgrade head` 建 schema（conftest:400-412），不参与断言。
  - marker 错位：`-m unit` 1,200 中 **87 条实际碰 DB**（11 个文件）；`-m db` 静态 288。
- 迁移成本：需重写 **≈350–380 条（27%）**，全部因 ORM 造数/断言（AsyncSession+ORM model），非驱动层；
  新建 fixture 3 件（真 PG 生命周期可**直接复用** `backend/worker/tests/integration/conftest.py` 的 pgserver/PG_BIN 方案；asyncpg 事务回滚 fixture；SQL 化种子装载器）。
  **估 3–5 人日，必须与阶段二 S3 同批做**（共用 queries/ 造数，分开做返工）。
- 结论：**中**（形态机械、供给链零新建）。硬设计点：kaas_common/db.py 必须暴露**事务包裹执行**（裸 asyncpg 语句级 autocommit 无法复刻 savepoint 回滚语义）。

## 2. Q2 · orchestrator 是否有 worker 没有的运行时业务逻辑 → **无不可替代项**

- **口径修正**：文档"28,981 vs 22,993 行"是错觉——worker 侧混入 ~10,124 非空行 kaas_common 镜像、orchestrator 侧剔了 alembic/tests。**可比净差：orchestrator app/ 29,060 非空行 ≈ worker src 12,906 的 2.25×**（+16,154 行）。
- 行数分类账（分母 app/ 33,764 总行）：真实业务 **86.4%**（api 15,100 + services 11,027 + repositories 1,438 + domain 801 + schemas 501 + jobs 319）、ORM/迁移基座 8.4%、本地开发便利仅 **5.1%**（middleware/core/settings）。迁移 alembic 8,456 行、测试 20,356 行单独计。
- 11 条缺失路由逐条定性（含前端调用佐证）：4 条 admin 类 = 本地专用（0 前端调用或 worker 已有等价物 `GET /admin/audit-log`）；2 条 health = 编排探针；`oss/presign` = worker 以 R2 直传 + 共享 SigV4 存在；**`attribute-proposals` ×3 = 真实业务且有前端活页面**（`admin/spec-proposals/page.tsx:53,64,83`，生产当前 404 —— **与 B 无关的既存缺口**，无论 B 与否都该修）；`comtrade` = 无调度实现、前端 0 调用（allowlist:30"本地定时器调度"的说法**与代码不符**）。
- jobs/apscheduler 盘点（319 行，仅 uvicorn lifespan 启动）：2 个定时任务**生产从未执行过**。删壳损失：① 15 分钟 replied→询盘自动扫描（生产已手动对等，补 CF Cron 成本低-中）；② 每日 events 归档（生产 246 行无人归档，中期债，成本中）。
- 结论：**删除 orchestrator 壳不会导致生产现有业务能力丢失**；需要的是 2 项本地自动化的 CF Cron 重建（可选排期）+ 3 条 attribute-proposals 缺口的补齐（B 实施中顺带解决）。

## 3. Q3 · wrangler dev 本地跑 worker + 本地 PG → **可行但不适合日常开发**

实测（plan-b worktree，pgserver PG16 @127.0.0.1:5432 + `pywrangler dev`）：
- 连通性 ✅：`/health` 200；bootstrap-admin（INSERT）/login（SELECT）/auth/me 200；补建缺表后 fx-rates/subscriptions/bundles 200 ⇒ **asyncpg 连接/参数化/事务全通**。
- 迭代体验 ❌：dev 冷启动（首个 /health 200）**37.98s / 37.70s**；改 `src/*.py` 热重载后首个请求 **32.9s / 72s** 才恢复；对照 uvicorn --reload：冷启动 **2.72s**、重载 **21ms**（≈14× / 30× 差距）。日志可观测性 ✅（访问日志/traceback/print 均可见）。
- **顺带挖出与 B 独立的必修项**：空库快径只 `metadata.create_all`，worker 需要的表缺失（`fx_rates` 依赖 env.py 补 import——该修复在 P1 分支未合 main；`subscriptions`/`shipments` **根本无模型**）⇒ **新空库必 500**。B 的 schema 完备性必须加门禁（对账 worker 全部查询涉及的表）。
- 结论：wrangler dev 可作**部署前真实 runtime 冒烟门禁**；日常开发形态**不建议**用它。见 §7 修正案：同一份 app 代码 + 双入口（uvicorn dev 壳 / Worker 壳）。

## 4. Q4 · 冷启动基线与相对验收线 → **基线 2,680 ms，原 <1s 线不可达**

实测（生产 `kaas`，`wrangler versions upload`，不接管流量；n=5 全有效样本）：

| 样本 | 2663 | 2658 | 2856 | 2989 | 2680 |
|---|---|---|---|---|---|
| **中位** | **2680 ms**（均值 2,769；包体 11,588.84 KiB / gzip 2,934.96 KiB 与文档基线完全吻合） |

- 与既有记录的关系：DEPLOY.md ~2.8s ✓ 一致；POC 探针 2059ms 偏低合理（探针包体 10.8 MiB）。
- **原验收线"<1 秒"比实测基线低约 4 倍，对任何方案物理不可达**——确认不可沿用。
- **建议相对线（待用户确认）**：`≤ 基线 2,680ms + 10%`（≈**2,950ms**）或 `≤ +500ms`（3,180ms）。
  对 B：worker 运行时依赖不变（asyncpg-only，B 只增路由/查询代码，量小），+10% **可达**；
  对 A′：同样可达。二者无差别。
- 透明披露：测量在生产 Worker 产生 5 个**未部署**版本记录（不接流量，随版本策略过期）。

## 5. 阶段三 10 项 · 现状对照（**2026-10-20 更新**）

> 本节原为 2026-10-19 评估时点；**下表「现状」列已按 2026-10-20 最新口径重写**。
> 结论：**10 项中 8 项已完成，2 项待用户外部动作**（冷启动测量需一次批准的上传；PR 预览需
> Neon/CF 凭据与资源，已裁决全量做）。执行账本见 [MASTER_EXEC_PLAN §S1–S6](archive/2026-10-20-closeout/MASTER_EXEC_PLAN_2026-10-19.md)。

| # | 项 | 2026-10-20 现状 |
|---|---|---|
| 1 | 空库 upgrade head | ✅ 已完成：空库 `alembic upgrade head` → **102 表**（`kaas_local` 实测，head `202610190020`）；`alembic check` 零漂移；表级+**列级** schema 门禁在 CI |
| 2 | downgrade | ✅ 审计+实测完成：`drop_table` 精确 3 个；修复 2 个真 bug（004 重建/002 IF EXISTS）；CI 加「最新迁移可逆」；**全链 base 不支持**（历史断点）→ 回滚用 Neon PITR/分支 |
| 3 | 全部现有测试通过 | ✅ worker **954+5**、orchestrator **222**（原 1,220 → 处置见 S4_TEST_MIGRATION）、前端 **455** + e2e **23+4skip** |
| 4 | queries/ 真 PG 测试 | ✅ worker `tests/integration` 5 条（注册/建客户/报价写路径），CI `worker-db-tests` 跑真 PG |
| 5 | 写路径 E2E | ✅ 真 PG 写入路径 5 条 + 前端 real-backend e2e 模式可跑（生产只读冒烟 200） |
| 6 | 冷启动 | ⬜ **门禁已建**（`check-worker-bundle.py` 校验 `coldstart-baseline.json` ≤2,950ms）；基线待一次**经用户批准**的 upload 后测量（U-E4） |
| 7 | 包体积 | ✅ 门禁已建（`pywrangler deploy --dry-run` 统计，64MiB 硬限/15MiB 目标；CI 跑）；本地因 uv pyodide 探针损坏 SKIP，CI 真实执行 |
| 8 | 静态门禁 | ✅ 依赖断言 / 表级 schema / 列级漂移 / 包体积 / contracts(R0–R5) / sync-shared 全部接入 CI；route-parity 与 R6 已退役留档 |
| 9 | 依赖断言 | ✅ `check-runtime-deps.py`（146 文件 + worker pyproject，禁 sqlalchemy/alembic/greenlet/psycopg2） |
| 10 | PR 预览 | ⬜ 已裁决**全量做**；等用户提供 Neon API key / Cloudflare API token 与预览 R2/KV 资源（USER_ACTIONS §C S5 前置清单） |

## 6. 结论

**B-可行。** 一句话理由：orchestrator 无任何"删除后生产现有业务丢失"的运行时逻辑（Q2），asyncpg-only 运行时与空库 schema 问题均有明确工程解（Q1/Q3），唯一代价集中在测试重写（350–380 条、3–5 人日）与本地开发形态修正（§7）。

实施要点草案（未实施）：目录结构按任务书目标形态；**新增修正项**——① kaas_common/db.py 暴露事务包裹执行；② schema 完备性门禁（worker 查询涉表 vs alembic 产物对账）；③ 双入口（uvicorn dev 壳复用同一 app，wrangler dev 降级为部署前冒烟门禁）；④ 迁移执行位置改为 CI/独立 CLI（现 deploy.yml 无 alembic 步骤，属新建）；⑤ 2 个 jobs 用 CF Cron 重建（低-中成本，可排期）；⑥ attribute-proposals 3 条路由随 S3 补进 worker（修既存生产 404）。

## 7. 三项条件性修正（✅ 全部已确认 · 2026-10-19）

1. **相对冷启动验收线**：≤2,950ms（基线+10%）—— ✅ **已确认**。
2. **本地开发形态**：任务书原定"wrangler dev 跑同一个 worker"；实测迭代代价 14×/30× ⇒ 修正为"同一份 app 代码双入口：uvicorn 本地热重载 + wrangler dev 作部署前冒烟门禁"—— ✅ **已确认**。
3. **测试处置**：350–380 条（27%）随壳重写 + marker 错位 87 条归位，其余 ~1,085 条原样保留（前提：其 import 的 app.services/domain 在 B 后以新形态存活）——此为 B 成本主项，**✅ 已确认（按此执行）**。

## 8. 事实核对（任务书 6 条事实的确认/修正）

| 任务书事实 | 核对 |
|---|---|
| 1 双后端=一生产壳+一本地壳 | ✅ 确认（全仓仅 1 个生产 wrangler.jsonc；orchestrator 无任何 wrangler 配置、无部署 job） |
| 2 两侧技术栈与规模 | ✅ 确认（数字属实；但"6000 行差异"口径有误，见 §2 修正：净差 16,154 行） |
| 3 三道门禁查不了行为 | ✅ 确认（并新增证据：allowlist:30 的 comtrade"定时器调度"说法与代码不符——门禁登记理由本身也可能过期） |
| 4 两起行为漂移事故 | ✅ 确认（文档与 commit 均可溯） |
| 5 路线 A 已否决 | ✅ 确认（POC 文档 + 生产实测） |
| 6 冷启动线修正 | ✅ 确认并完成实测（§4：基线 2,680ms 中位；原线不可达） |

附注（评估中新发现的既存问题，独立于 B）：① 空库快径缺 worker 表（新环境必 500；`alembic/env.py` 模型 import 已随 `88132af` 补上，worker 独有/无模型表仍待 B 的 schema 完备性门禁）；② attribute-proposals 3 条生产 404；③ ~~DEPLOY.md 仍写 Neon/旧 Hyperdrive id，与生产实配（PPG/`1733fcd8…`）漂移~~ ——**随决策 1（回 Neon）失效**：DEPLOY.md 的 Neon 口径与 main 生产实配已一致，PPG 线整体废弃；④ 本机 uv 的 pyodide 解释器探针损坏（`uv python list` 警告，pywrangler sync 路径暂不可用，裸 wrangler 路径正常）。

## 9. 预估（供排期参考）

阶段二 S1–S6 ≈ 9–13 人日；阶段三 ≈ 5–8 人日；**全案 ≈14–21 人日**（不含观察期）。最大不确定点：① 测试重写处置（§7-3）；② 行为漂移真实面积（除缺失 11 外，S3 中逐路由核对时才能量化）。
