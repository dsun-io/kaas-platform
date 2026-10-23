# 交接文档 · 2026-10-19 检查点：P1 生产库迁 PPG（峰值时段暂停）

> ❌ **已废弃（2026-10-19 · 决策 1，已确认）**：**P1 迁库终止——放弃 Prisma Postgres，生产回
> Neon。** 生产 Hyperdrive 保持指向 Neon 生产分支（main 实配 `f53fed49…`，从未切换）；
> 本文描述的 PPG 建库/schema/数据迁移/Hyperdrive `1733fcd8…` 切换**全部作废，不得执行、不得合并
> （`feat/convergence-aprime` 分支中的 wrangler.jsonc PPG 切换与 `scripts/migrate-ppg/` 属该废弃线）**。
> PPg 放弃依据与当前权威口径见 [README.md](../README.md)（主交接文档）§2.1 / §9。以下保留为历史记录。

> ~~**状态：迁移进行到 70%，停在"schema 漂移未清零"这个检查点；生产仍跑 Neon，未切换、未部署。**~~
> 本文写给**另一台设备上的 DSH 会话**接手用：状态、证据、下一步顺序、权限获取方式、
> 已知风险全在这里。~~先读本文，再读 `docs/MASTER_EXEC_PLAN_2026-10-19.md` 了解全局。~~
> 分支：`feat/convergence-aprime`（worktree：`.agents/worktrees/feat/convergence-aprime`）。

---

## 0. 一句话状态

PPG（Prisma Postgres）库已创建、schema 已建（**114 表**）、**数据已全量复制且行数 100% 一致**
（108 表 + 2 张漂移表补拷）、Hyperdrive 新配置已建、`wrangler.jsonc` 已切 id——
**但 schema 的约束/索引/列属性仍有明显漂移（见 §3），所以不能切生产流量。**
生产 Worker 仍连 Neon（Hyperdrive `f53fed…`），一切照旧。

## 0.5 ⚠️ 必读：平行线交接（另一任务的产物，已合并进本分支——勿重做）

主线同时有一条平行线，其交接文档 **`docs/HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md`**
（入口指针挂在 `MASTER_EXEC_PLAN_2026-10-19.md` 顶部、`PROBLEM_STATUS` 交接摘要、
共享任务板 task-1）。**其全部内容已随 `git merge origin/main`（本分支 `5411f3d`）并入本分支**，
接手时务必先读，避免重复劳动：

| 他们已做完（勿重做） | 关键事实 |
|---|---|
| **生产注册 500**（`users.is_tenant_admin` 缺列） | 修复 `a8557c9`，已部署；worker 两处 INSERT 补默认值 |
| **500 被误报成 CORS** | `main.py` CORS 中间件兜底，已部署 |
| **注册页公司名称去重**（用户裁决） | 前端删框 + `company_name` 两端改可选 + mock/openapi 同步 |
| **定价页白屏**（worker `/pricing-data` 老实现 vs 前端矩阵） | 四端点按 orchestrator 重写（`4b152b4`）+ 6 条形状测试 |
| **CI `backend:test` db-tests 恒红修复** | `6c08900`（conftest `to_regclass` TRUNCATE / 公章口径 / 编号断言）；main 已 success |
| 环境坑清单（本机无 PG ⇒ db 测试全 skip 是假绿、pnpm 路径、匿名读 check-runs 配方、共享工作区用 worktree） | 见他们文档 §4 |

**他们留给我们的事项（已并入本方待办 §6）**：H-1 Frontend CI 红 → 已由批次 0 B0-1 完成 ✅；
H-2 用户复验注册/定价页 → 用户侧；**H-3 本分支 `3ada691` 等上的 CI 失败需本分支修绿再合** ⬅ 未完成；
H-4 db 测试本地可跑（可选，initdb 中文 Windows 问题）。

**合并后门禁实测（2026-10-19 14:1x）**：orchestrator `pytest -m unit` = **1200 passed**；
worker = **303 passed**（`not integration`）；`route-parity.py` = **PASS**。

## 1. 已完成（按时间顺序，均可从 commit 复现）

| # | 事项 | 证据 |
|---|---|---|
| 1 | **P0 POC 否决路线 A**：greenlet 无 wasm wheel ⇒ `sqlalchemy.ext.asyncio` ImportError；冷启动 +1854ms | `docs/POC_WORKER_SQLALCHEMY_2026-10-19.md`（main `cb25bd6`） |
| 2 | 方向转 **A′ + C 子集**；两个 POC Worker 已删除 | PROBLEM_STATUS 2026-10-19 条目 |
| 3 | **C 子集完成**：worker 真 PG 写入路径测试 5 条（注册/bootstrap-admin/客户/报价） | 分支 `3ada691`；`python -m pytest backend/worker` = 308 passed |
| 4 | `session.py` SSL 判定去 Neon 硬编码（通用化） | 分支 `a3860f6` |
| 5 | **空库建表根因修复**：`alembic/env.py` 补 import 5 个模型模块（此前空库只建 61 表，漏 `cust_contacts` 等） | 本文档同次提交（分支） |
| 6 | **PPG 库创建**：Prisma CLI 非交互 | project `kaas-platform` / db `kaas-prod` / PG17.2 / us-east-1 |
| 7 | **PPG schema**：快径建 93 模型表 + 补建 20 张 worker 独有/legacy 表 → **114 表** | 见 §3 校验输出 |
| 8 | **数据复制**：CSV 并发复制 108 表 + 2 张补拷；序列 setval 102 个 | 行数 0 不一致 |
| 9 | **Hyperdrive**：`kaas-ppg` = `1733fcd80736482e8ec6e7648ed52286`（直连 `db.prisma.io`）；`wrangler.jsonc` 已切 | 分支未合 main |

## 2. 当前环境与真实状态

```
生产（未变）：Worker kaas → Hyperdrive f53fed… → Neon PostgreSQL 18.6
迁库目标（已就绪 70%）：Worker kaas → Hyperdrive 1733fcd… → PPG 17.2 (us-east-1)
迁移中间态：PPG 已有 109 生产表 + 5 张「新命名」表（models 有、生产无）+ pg_stat_statements
```

- PPG 表数 114（= 109 生产表 + 5 张新命名表 + 无 alembic 差异），**生产缺的表一张不缺**；
- 行数校验：**108 张表全部一致（0 mismatch）**；2 张漂移表已补列并补拷（见 §3）；
- `alembic_version = 202610180010`（与生产一致）；
- 序列：102 个 `setval` 完成。

## 3. 阻塞项：schema 漂移（必须清零才能切）

2026-10-19 校验（`scripts/migrate-ppg/05_verify_ppg_vs_neon.py`）输出：

| 指标 | Neon(生产) | PPG | 结论 |
|---|---|---|---|
| 表 | 109 | 114 | PPG 多 5 张「新命名」表（`order_quote_refs` 等，models 有生产无）→ 属无害冗余 |
| 行数 | — | — | **0 不一致 ✅** |
| 约束 | **1015** | **190** | ❌ **缺 852 个**（create_all 只建了部分 PK/唯一；生产里的 check/fk 大量缺失） |
| 索引 | **313** | **281** | ❌ 缺 50 个 |
| 列属性差异 | — | — | 33 处（类型/`NOT NULL`/默认值，如 `trade_docs.status`、`tenant_products.cost_field`、`tax_archives.tax_values`、`*_items.sort_order`） |

原因：93 张模型表走 `create_all` 快径，得到的约束/索引远少于生产历史累积的 DDL；
补建的 20 张表已从生产目录精确复制（约束/索引齐全），漂移集中在**模型表**。

**下一步（按序）**：
1. 写 `02_align_schema.py`：从 Neon 目录读取「模型表」的全部约束/索引/列属性，
   对 PPG 做 diff → 生成 `ALTER TABLE … ADD CONSTRAINT/DROP+ADD COLUMN（带 USING 转换）`；
   类型/默认/`NOT NULL` 差异优先按「改 PPG 对齐生产」处理（PPG 无业务流量，安全）。
2. 复跑 `05_verify_ppg_vs_neon.py`，要求：约束/索引差 = 0（或逐条白名单化并写进本文）。
3. Worker 冒烟（**不切生产**）：`npx wrangler dev` + `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`
   指向 PPG 直连 → 登录/注册/建客户/报价 4 条写入路径。
4. 合并分支到 main（触发 CI 部署）→ 生产冒烟（DEPLOY.md §0.2：`/health` JSON、
   `/api/v1/*` 401、`/login` 200、注册、建客户、报价）→ 观察 30 分钟。
5. 回滚预案：把 `wrangler.jsonc` 的 hyperdrive id 改回 `f53fed49705043008737032e4bfa2b8e`
   重新部署即可（Neon 数据未动）。
6. 稳定 30 天后：Neon production 分支改名 `kaas-prod-neon-legacy` 保留，到期删除。

## 4. 权限 / 凭据获取（换设备必看）

> **`.env.local` 是 gitignored，不随仓库走。** 新设备需重新生成或从安全渠道拷贝。

### 4.1 Prisma（PPG）
- 账号：**user@example.com**（GitHub 登录），workspace `Personal workspace`
- 项目：`kaas-platform` = `proj_uwe01gaebpmbkxwiio388f8e`
- 数据库：`kaas-prod` = `db_xe7ypplcbxq3ysghz93k3n8u`（PG **17.2**，`us-east-1`，ready）
- 登录 CLI：`npx prisma@latest auth login`（浏览器 OAuth；本机已验证可用）
- **取新连接串**（每设备各自一份，只打印一次）：
  ```bash
  npx prisma@latest postgres connection create kaas-prod --name <设备名>
  # 输出形如 postgres://<user>:<pass>@pooled.db.prisma.io:5432/postgres?sslmode=require
  # ⚠️ Accelerate（pooled.db.prisma.io）已进入停用倒计时：把 host 换成 db.prisma.io 用直连
  ```
- 写入 `.env.local`：`DATABASE_URL_PPG=postgres://...@db.prisma.io:5432/postgres?sslmode=require`
- 无浏览器环境：设 `PRISMA_SERVICE_TOKEN`（Console 生成）

### 4.2 Cloudflare
- 账号：`user@example.com's Account`，ID **`766f8d7eb5a7d20e272673073ec8c3fd`**
- 登录：`pywrangler login`（OAuth，等价 `wrangler login`）
- Hyperdrive：**旧（Neon）`f53fed49705043008737032e4bfa2b8e`**；**新（PPG）`1733fcd80736482e8ec6e7648ed52286`**
- 重建命令（如配置丢失）：
  ```bash
  cd backend/worker
  pywrangler hyperdrive create kaas-ppg --connection-string="<PPG 直连 DSN>"
  ```

### 4.3 Neon（回滚用，勿删）
- 项目 `falling-salad-31662168`；生产/开发分支 DSN 在 `.env.local` 的 `DATABASE_URL`（带引号，读取要 strip 引号）

### 4.4 本机工具链（原设备实测，新设备可参考）
- 无 `pwsh`（只有 PowerShell 5.1）；`pnpm` 在
  `C:\Users\某某贸易公司\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs`
  （⚠️ 不是旧文档写的 `node\pnpm\bin\pnpm.mjs`）
- node：`...\dependencies\node\bin\node.exe`；npx：`C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js`
- orchestrator venv：`backend/orchestrator/.venv`（psycopg2/alembic 都在）；worker 测试用**系统 python**（含 pytest 9.1.1）
- **无 Docker / 无 WSL / 无 pg_dump**：迁移用「alembic 快径建表 + CSV COPY」而不是 pg_dump
- PPG 区域 us-east-1：**单条 DDL/COPY 往返约数秒**，批量操作要有耐心或并发（脚本已用 6 线程）

## 5. 迁移脚本（`scripts/migrate-ppg/`）

| 脚本 | 用途 |
|---|---|
| `01_reset_ppg_schema.py` | 清空 PPG public schema（**只在重建时用**） |
| `03_copy_data.py` | 并发 CSV 复制全部表 + setval + 行数校验（可重复执行） |
| `04_fix_schema_drift.py` | 补 `market_ports`/`trade_docs` 漂移列并补拷（已执行完） |
| `05_verify_ppg_vs_neon.py` | 全量校验：表/列/约束/索引/行数（**当前唯一判据**） |

> 02（补建 20 张非模型表的脚本）是一次性执行的，未保留；如需重建，依据：
> 表清单 = `information_schema` 中 Neon 有而 `Base.metadata` 无的表（20 张，见 §3 提及），
> 用 `pg_get_constraintdef` / `pg_indexes.indexdef` 从生产目录复制。

## 6. 全局待办总账（2026-10-19 检查点 · 共 19 项，已全量核对入档）

> 口径来源：双审计线（`MASTER_EXEC_PLAN`）+ 平行线交接 §6 + 本线新发现。
> 主链 4 + 批次 6 为 1 项 + 用户操作 4 项 + 平行线遗留 3 项 + 独立排期 7 项 = **19**。

**A. 主链（goal 内，按序执行）**
1. ⬅ **P1 收尾**：schema 对齐 → verify 清零 → worker 冒烟 → 合 main 部署 → 生产冒烟 → 观察 30 分钟（本文 §3 六步；**当前唯一阻塞**）
2. **P2 预览环境**：CF 预览部署（免费档已确认可用）+ Neon dev 预览库；空库建库必须走已修复的 `env.py`（否则缺表 500）
3. **P3**：A′（SQL/DDL 内核同源 + 两薄适配）+ C 子集 CI job 验证（真 PG 测试已交付 `3ada691`，CI job 未在真实 Actions 跑过）
4. **P4 观察期**：冷启动/5xx/延迟对比基线

**B. 批次 6（硬性排在 P3 之后）**
5. 技术栈安全债：Next 14.2→15.5+（2 critical RCE）/ CI Node 20→22 / ESLint 8→10 / TS→6（执行前重跑 `TECH_STACK_UPGRADE §1`）

**C. 批次 U（需用户动手，不阻塞开发）**
6. U-1 R2 `S3_ACCESS_KEY` 重建 32 位（dashboard）
7. U-2 生产 `product_tax_rates` 配置数据
8. U-3 仓库改回 private + Actions billing 确认
9. U-4 智能表格 21 行缺失输入补全

**D. 平行线遗留（来自 `HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md` §6）**
10. ⚠️ **H-3：本分支上的 CI 失败要修绿再合**——`backend:test` / `Frontend CI` / `prisma-deploy` 在 `3ada691`/`15997bd` 上有失败（功能分支状态，非 main）
11. H-2：用户复验定价页刷新与注册（修复已上线，等用户确认）
12. H-4：db 测试本地可跑（可选；绕过 initdb 中文 Windows UTF8 问题，或维持 CI 为唯一 db 门禁）

**E. 独立排期/暂缓（等拍板，见 `MASTER_EXEC_PLAN §5`）**
13. I-1 「流失」迁订单阶段（业务设计先行）
14. I-2 单证加固 P1/P2（5 项口径待用户拍板，`UNCERTAIN.md`）
15. I-3 文件存储收尾 3 项（真实 DB 用例/公章视觉 QA/排序过滤测试）
16. I-4 PDF 归档尾巴（端到端一次/定时调度/已变更标识）
17. I-5 Cloudflare agent 接入
18. I-6 单证指纹批量对账定时调度（暂缓）
19. I-7 P3 暂缓五项（触发条件制，维持暂缓）

**已完结不再跟进**：批次 0 全部（B0-1~6、D0-1~4）、P0 POC、C 子集本体、
QUOTE/TAX/BATCH_QUOTE/PDF_ARCHIVAL/SHEET_CALC 等历史方案（`MASTER_EXEC_PLAN §7`）。

## 7. 风险登记

| # | 风险 | 现状/缓解 |
|---|---|---|
| R1 | PPG 免费档 20 万 ops/月 | 迁移期 COPY/DDL 已消耗部分额度；上线后按真实流量评估 |
| R2 | Accelerate 停用 | 一律用 `db.prisma.io` 直连（Hyperdrive 池化） |
| R3 | us-east-1 延迟 | Worker（边缘）→ Hyperdrive → us-east-1；迁移期感知慢，运行时由 Hyperdrive 池化缓解 |
| R4 | PPG 无自动备份（免费档） | 上线前用 CSV 导出做一次冷备；后续按 PROD_DB_OPTIMIZATION_PLAN §2.2 落 R2 备份链 |
| R5 | 5 张「新命名」表只在 PPG 侧存在 | 无害（生产本就没用）；切流量前与 worker 代码核对确认未被引用 |
| R6 | 回滚 | 改回 Hyperdrive `f53fed…` 重部署即回 Neon（数据未动） |
