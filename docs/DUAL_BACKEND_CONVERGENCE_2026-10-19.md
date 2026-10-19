# 双后端收敛评估（2026-10-19 · 重激活）

> 🔄 **方向升级（2026-10-19 晚场，已确认）**：本文评估出的 A′ 路线已被**方案 B** 取代
> （评估结论 B-可行 + 三项已确认修正，见 [PLAN_B_EVALUATION](./PLAN_B_EVALUATION_2026-10-19.md)）。
> **仍然有效且不得删除的内容**：§3.1/§3.3 的**路线 A 否决记录与证据**（决策 2）。
> **已失效的内容**：§7 协同表中的 P1 迁库协同（决策 1 放弃 PPg 回 Neon）。
> **当前唯一权威：[README.md](../README.md)（主交接文档）。**

> **状态：仅评估，未执行任何代码改动。** 本文取代 2026-09 归档版
> [`archive/2026-10-17-doc-cleanup/DUAL_BACKEND_CONVERGENCE.md`](./archive/2026-10-17-doc-cleanup/DUAL_BACKEND_CONVERGENCE.md)
> ——旧版前提部分已被生产事实推翻（见 §3.1），不可直接执行。
> 配套事实：[WORKER_ORCHESTRATOR_DRIFT.md](./WORKER_ORCHESTRATOR_DRIFT.md)、
> [PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md](./PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md)。
> 拍板记录见 §8；执行任何一条之前先重跑 §2 的取证命令。

---

## 0. 先澄清一个反复出现的误解

**"双后端" ≠ "一个开发库 + 一个生产库"。**

数据库分环境（本地 Docker PG / Neon dev / 生产库）是任何项目的常态，不是问题本身。
双后端指的是：**同一套 `/api/v1/*` 业务 API 存在两份代码实现**——

| | orchestrator | worker |
|---|---|---|
| 位置 | `backend/orchestrator` | `backend/worker` |
| 技术栈 | FastAPI + **SQLAlchemy ORM** + Alembic | FastAPI + **裸 asyncpg 手写 SQL** |
| 运行时 | 本地 Docker / uv（Python ≥3.11） | **Cloudflare Workers Python runtime**（生产唯一入口） |
| 角色 | 本地开发服务器 (`:8000`) + **数据库迁移唯一执行者** | 生产 API + 前端静态资产 |
| 规模（2026-10-19 实测） | 374 文件 / 28,981 行 | 423 文件 / 22,993 行 |
| 路由数（route-parity 实测） | 231 | 225 |

两端靠 `kaas_common` 共享内核 + `shared/contracts` zod 契约 + `route-parity.py` 门禁防漂移。
注册 500 事故（2026-10-19，见 PROBLEM_STATUS 交接摘要）证明：**防线能查"有没有"，查不了
"行为一不一样"**——同一张表，SQLAlchemy 模型带默认值、裸 INSERT 不带，门禁全绿、生产 500。

## 1. 硬约束（用户裁决，排除部分路线）

1. **Cloudflare 免费托管不可放弃**（2026-10-19 用户明确）⇒ 排除"生产弃用 worker、改跑
   VPS/容器"路线（下称旧路线 B）。
2. **Alembic 迁移必须保留**（schema 演进已依赖它）⇒ 无论怎么收敛，orchestrator 的迁移
   能力都要活着，或以等价物替代。
3. 与迁库解耦：本文是独立方向决策，可与 `PROD_DB_OPTIMIZATION_PLAN` 共用执行窗口
   （协同点见 §7），但不并入该文档。

## 2. 当前事实（取证命令可复现）

```powershell
python scripts/route-parity.py
# 2026-10-19 实测：orchestrator 231 路由 / worker 225 / 允许清单 11
# 缺失 11（全部已登记）/ 过期 0 / worker 独有 5（不算失败）
git diff --stat origin/main...HEAD -- backend/orchestrator backend/worker
```

**漂移现状：路由面已对等了**（门禁 PASS），剩余的"worker 独有 5 条"是调试/订阅类接口。
真正没对等的是**行为面**：ORM 默认值、约束兜底、事务边界、查询缓存语义——这类差异
现有门禁全部看不见，只能靠事故暴露。

## 3. 路线评估

### 3.1 旧方案（2026-09 归档版）哪些前提已失效

| 旧版前提 | 2026-10-19 事实 |
|---|---|
| "Pyodide 不支持 C 扩展 ⇒ asyncpg/bcrypt 进不了 Worker" | **`asyncpg` + `bcrypt>=5` 已在生产 Worker 实际运行**（`backend/worker/pyproject.toml` 仅 6 个依赖，部署在线）。Workers Python runtime 的 C 扩展支持已远超旧版假设。 |
| "SQLAlchemy 天然无法复用" | 仍**未验证**，但理由变了：SQLAlchemy 本体是纯 Python，真正要验证的是 `greenlet`（asyncio 必需，C 扩展）与冷启动开销，而不是"能不能 import"。 |
| 冷启动 CPU 限额（DEPLOY.md §0.2 冷启动 ~2.8s） | **仍然成立**，这是收敛的最大硬约束：依赖越重越危险。 |

> ⚠️ **2026-10-19 POC 结论（已验证，取代本节推断）**：`greenlet` 在 Workers runtime
> **无可安装 wheel**（Pyodide 索引无此包；PyPI 79 个发行文件 0 个 wasm）⇒
> `sqlalchemy.ext.asyncio` ImportError，路线 A **不可行 as-is**；冷启动 +1854ms 也超线。
> 详见 [POC_WORKER_SQLALCHEMY_2026-10-19.md](./POC_WORKER_SQLALCHEMY_2026-10-19.md)。
> 当前执行方向：**路线 A′ + C 子集**（见 §3.2 末）。

### 3.2 三条路线

**路线 A：收敛为单一应用源码，Worker 装载统一 app —— ❌ 2026-10-19 POC 判定不可行 as-is**

> POC 已验证：`greenlet` 在 Workers runtime 无可安装 wheel ⇒ `sqlalchemy.ext.asyncio`
> ImportError（异步查询 100% 不可用）；且冷启动 +1854ms 超线。见
> [POC 文档](./POC_WORKER_SQLALCHEMY_2026-10-19.md)。唯一复活路径是自建 greenlet 的
> wasm 构建（独立立项，远超 0.5–1 天），不阻塞当前排期。

以下为原评估内容，保留备查：

把业务 API 收敛成一份 FastAPI 应用（以 orchestrator 的 SQLAlchemy 实现为准），
Worker 变成"打包这份应用 + Workers 运行时适配层"；orchestrator 退化为
**迁移工具 + 本地开发壳**（本地直接跑同一份 app）。

- 环境隔离怎么实现（回应"合并后靠什么隔离"）：**和全世界所有正常项目一样——
  靠部署目标 + 环境配置，不靠代码副本。** 本地 = Docker Compose 起同一份代码 +
  本地 PG；生产 = push `main` → CI 打包同一份代码部署到 Worker +
  Hyperdrive/生产库。`DATABASE_URL`、密钥、对象存储 binding 全部走环境配置。
  推送/部署节奏与今天完全一致，隔离强度不比现在差——现在的"隔离"其实是
  "两份代码各自连各自的库"，合并后才是标准的"一份代码、多环境部署"。
- 优点：行为面漂移**结构性归零**（同一份 SQLAlchemy 代码不可能对同一列一个补默认值
  一个不补）；新功能只写一遍。
- 代价/风险：① SQLAlchemy+greenlet 在 Workers runtime 的兼容性与冷启动开销
  **必须先 POC**；② 重型依赖（oss2/minio/openpyxl/apscheduler/otel）不能进 Worker 包，
  需要按" Workers 可用 / 仅本地 "切分依赖组；③ 打包与部署链改造（pywrangler 配置）。
- 工作量估计：POC 0.5–1 天；全量收敛 3–5 天（含回归）。

**路线 A′：只收敛数据访问层（2026-10-19 POC 后的执行方向）**

SQL/DDL 语句不再手写散落于 worker 各处，而是从内核**统一生成/统一存放**（SQL 常量 +
参数构造器都在 `kaas_common`，两侧 import 同一份；orchestrator 的 SQLAlchemy 模型与
worker 的 DDL/默认值口径对齐）；orchestrator 保留 ORM 作迁移工具，worker 保留裸 asyncpg
但**语句与内核同源**。行为面差异（默认值、列清单、约束）大幅收窄，改动量小、不碰运行时风险。

可选强化（POC 已实测可行，需权衡）：worker 引入 **SQLAlchemy 同步 Core 仅编译 SQL** +
asyncpg 执行——共享同一份查询构造代码，但 +8.2 MiB 包体 / +1.8s 冷启动。
**建议不做**（冷启动是免费档硬约束），仅当内核同源方案维护成本过高时再评估。

配套路线 C 子集（同批执行）：worker 写入路径测试接**真 Postgres**（本地 Docker），
消灭注册类 500 的土壤。

**路线 C：维持双后端，加固防线**

worker 测试接真 Postgres（本地 Docker，已有环境）；把注册类"写入路径"的 INSERT
语句也收进内核统一生成；行为面差异靠测试与审计清单兜底。
- 优点：零架构风险，本周就能做。
- 缺点：**漂移风险只是缓解不是消除**，每次新功能仍写两遍（或两遍同步），长期成本持续。

### 3.3 合并 vs 不合并：优劣对照

| 维度 | 合并（A / A′） | 不合并（C） |
|---|---|---|
| 行为面漂移风险 | 结构性消除（A）/ 大幅收窄（A′） | 持续存在，靠测试与纪律 |
| 新功能成本 | 写一遍 | 写一遍 + 同步一遍 + 门禁排障 |
| 运行时风险 | A 有（需 POC 验证）/ A′ 无 | 无 |
| 冷启动/包体积 | A 需优化（依赖切分） | 不变 |
| 回滚难度 | 高（动部署链） | 低 |
| 近期事故复发概率 | 注册类 500 ≈ 0 | 仍可能（新列/新表场景） |

## 4. 建议

1. **先做 POC（路线 A 的验证项）**：在 Worker 里 import SQLAlchemy + greenlet +
   asyncpg，起一个最小路由（读一行、写一行），实测部署后的冷启动与稳定性。
   通过 ⇒ 排期路线 A；不通过 ⇒ 路线 A′ 起步、C 同步加固。
2. **不依赖 POC 结果、立刻可做的（路线 C 子集，本周）**：worker 测试接本地 Docker
   真 PG（环境已就绪），覆盖所有写入路径——这是注册 500 的直接疫苗，与收敛路线
   不冲突。
3. **与迁库窗口协同**（见 §7）：若 POC 通过，全量收敛与 Neon→PPG 迁移**不要同批**
   做（两个大变更叠加无法归因），建议：POC → 迁库 → 收敛，各自独立冒烟。

## 5. POC 验证清单（路线 A）

- [ ] Worker 内 `import sqlalchemy` + `greenlet` 可部署、可 import（deploy 不炸）
- [ ] `/health` 加一个 SQLAlchemy 查询探针，生产冒烟 200
- [ ] 冷启动时间对比（DEPLOY.md §0.2 口径）：基线 vs 加 SQLAlchemy 后，增幅可接受（<1s 量级）
- [ ] 连续 20 次冷启动无 isolate 启动失败（间歇 5xx 探针）
- [ ] 依赖切分方案落地：`pyproject.toml` 分 `worker` / `local-only` 两组，worker 包
      不含 oss2/minio/openpyxl/apscheduler/otel/psycopg2/alembic
- [ ] 打包链验证：`pywrangler deploy` 产物清单审计

## 6. 环境隔离与部署节奏（合并后的目标态）

```
                        同一份 FastAPI 应用源码
                       /                        \
   本地开发/迁移侧                           生产侧
   Docker Compose（PG17/Redis/MinIO）        push main → CI → pywrangler deploy
   DATABASE_URL=本地 PG                       → Worker + Hyperdrive → 生产库
   alembic upgrade（唯一迁移入口，不变）        静态资产同源构建
```

- 隔离边界 = **部署目标 + 环境变量 + 密钥**，与现状语义相同、强度更高（现在反而是
  代码层面就可能不一致）。
- push `main` 自动部署的规则不变；`paths-ignore`（纯文档）规则不变。
- 迁移纪律不变：永远先跑迁移、再部署依赖新 schema 的代码。

## 7. 与 `PROD_DB_OPTIMIZATION_PLAN` 的协同与边界

| 事项 | 归属 | 说明 |
|---|---|---|
| Neon→PPG 迁移、PG17 对齐、备份链 | DB 方案 | 收敛不改库，只改代码组织 |
| `session.py` SSL 判定通用化 | DB 方案 Step 2 | 收敛（A）若执行会重写数据访问层，届时该文件大概率被替换——**顺序上迁库在前，避免返工** |
| 真 PG 回归环境（本地 Docker） | 共用 | 迁库 Step 4 一致性校验 与 收敛回归 都用它 |
| Hyperdrive config 切换 | DB 方案 | 收敛后连接建立代码变了，但 Hyperdrive 配置对象不变 |

## 8. 决策记录

| 日期 | 事项 | 状态 |
|---|---|---|
| 2026-10-19 | CF 免费托管不可放弃 ⇒ 排除"弃用 worker 换 VPS"路线 | ✅ 已裁决 |
| 2026-10-19 | 本轮只补评估文档，不动代码 | ✅ 已裁决 |
| 2026-10-19（晚场） | **方向：合并（路线 A）+ 恢复三层环境模型**（推翻 DB 方案"降级两层"裁决）。理由链：双后端时代 orchestrator 充当准预览；单后端时代 push 即上生产，预览环境成为唯一安全网 ⇒ 两者是同一决策。计划与执行顺序（P0 POC → P1 迁库 → P2 预览环境 → P3 全量收敛 → P4 观察期）见 [DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md](./DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md) | ✅ **已裁决，待集中推进** |
| 2026-10-19 | **P0 POC 结论：路线 A 不可行 as-is**（greenlet 无 wasm wheel ⇒ sqlalchemy.ext.asyncio 不可用；冷启动 +1854ms 超线）⇒ 执行方向改为 **路线 A′（数据访问层同源）+ C 子集（worker 真 PG 测试）**；原"单后端合并"目标降级为"行为面漂移收敛到可测试、可审计" | ✅ 已验证，待用户确认 A′ 范围 |
