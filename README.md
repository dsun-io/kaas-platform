# KaaS Platform

> **Knowledge as a Service** —— 面向传统制造业的外贸业务平台。
> 以「工位（Workstation）」为交付单元，把客户/询盘、报价、订单、出运、单证、税务、情报与 AI 能力串成一条可追溯的业务链。

- 生产站点：`https://kaas.powervoy.com`
- 生产 API：`https://api.kaas.powervoy.com`
- 本地前端：`http://localhost:3000`
- 本地后端：`http://localhost:8000`（`/health`、`/docs`）

> 📌 **本文是主交接文档**（架构 / 环境隔离 / 双后端优化决策 / 开发与测试口径的唯一权威来源）。
> 决策依据与取证出处见 [docs/PLAN_B_EVALUATION_2026-10-19.md](docs/PLAN_B_EVALUATION_2026-10-19.md)；
> 执行入口见 [docs/MASTER_EXEC_PLAN_2026-10-19.md](docs/MASTER_EXEC_PLAN_2026-10-19.md)。

---

## 1. 当前架构总览（已确认）

```
                   一份 FastAPI app 代码（= backend/worker/src，方案 B S4 已落地）
                  /                                                      \
   本地开发入口：uvicorn local_run.py --reload            生产入口：Cloudflare Worker "kaas"
   （日常开发唯一形态；wrangler dev 只作部署前冒烟门禁）     ├─ kaas.powervoy.com      前端页面 + /api/v1/*
                  │                                    ├─ api.kaas.powervoy.com  仅 API
                  │                                    │  运行时只用 asyncpg（不依赖 sqlalchemy/alembic/greenlet）
                  │                                    ▼ Hyperdrive（生产 config → Neon 生产分支）
                  └────────── kaas_common（唯一"脑"）──────► R2 / KV（三环境物理隔离，见 §2）
                     参数化 SQL · 纯函数规则 · 报价引擎 · 业务枚举 ·
                     SQLAlchemy models + Alembic（仅迁移期加载，不在运行时）

门禁：contracts:check（前端 zod ↔ 共享内核/契约快照）
      sync-shared.ps1 -Check（kaas_common 镜像一致）
      check-schema-coverage.py / check-schema-drift.py（空库可建 + 生产列级一致）
      check-runtime-deps.py（运行时不得出现 ORM/greenlet）
```

- **生产唯一 Worker**（事实）：`backend/worker/wrangler.jsonc` 是全仓唯一生产 wrangler 配置；
  `backend/orchestrator` **从未部署到 Cloudflare**（无任何 orchestrator 侧 wrangler 配置、无部署 job）。
- **单应用已落地（S4，2026-10-19）**：orchestrator 业务壳（api/services/repositories/domain/schemas/
  jobs/middleware/core/main）已删除，目录只留 `app/db`（ORM 模型）+ `alembic/`（迁移链）；
  本地与生产跑**同一份** `backend/worker/src/main.py`（本地入口 `backend/worker/src/local_run.py`）。
- **kaas_common 唯一脑**：参数化 SQL、纯函数规则、报价引擎（`export_quote`）、业务枚举全部在
  `backend/kaas_common/`（S4 把原 `orchestrator/app/services/export_quote` 与 `app/domain/enums.py`
  迁入）；worker 侧为逐字节镜像（`scripts/sync-shared.ps1`）。
- **删壳前规模（评估口径，2026-10-19，仅存档）**：orchestrator app/ 167 文件 / 33,764 行 /
  231 路由；worker src/（跟踪，不含镜像）25 文件 / 14,717 行 / 225 路由。S4 后 orchestrator 业务
  代码为 0，测试从 1,220 条 → 222 条（迁移/模型/kernel，处置见
  [docs/S4_TEST_MIGRATION_2026-10-19.md](docs/S4_TEST_MIGRATION_2026-10-19.md)）。
- **技术栈基线（2026-10-20 升级后）**：Next **16.4.2** / React **19.3** / ESLint **10.13（flat config）** /
  TypeScript **6.0.3**；CI Node **22**（本地 Node 24）；`pnpm audit` **0 critical**
  （3 high 均为 dev-only：wrangler→sharp、shadcn→MCP SDK、micromatch→braces）。
  升级账本见 [docs/TECH_STACK_UPGRADE_2026-10-17.md](docs/TECH_STACK_UPGRADE_2026-10-17.md)；
  本轮交接见 [docs/HANDOVER_2026-10-20.md](docs/HANDOVER_2026-10-20.md)。

---

## 2. 数据库与存储（三环境资源隔离）

### 2.1 生产数据库 = Neon；Prisma Postgres 已放弃（已确认）

**PPg 已放弃，不得回迁、不得保留 PPg 连接配置、不得保留"可切回 PPg"的双路径。**
决策依据（防止后续重新提出）：

- PPg **固定 10 连接上限**、**不支持 Postgres 扩展**，在 Cloudflare Workers + Hyperdrive 架构下是**结构性阻塞**；
- Neon 免费层提供 **1 GB 存储、100 CU-hours、10 分支**，闲置仅缩容不清数据；
- **生产 Hyperdrive 必须指向 Neon 生产分支。**

### 2.2 三环境资源隔离矩阵（**目标态 · 尚未实施**）

> ⚠️ **实施状态（2026-10-20 核对）**：下表是**目标态**。S5 预览环境已落地（`scripts/preview/` +
> `.github/workflows/preview.yml`，2026-10-20，`18ae386`）：每 PR 派生 Neon 分支 `preview-pr-<num>` +
> 独立 Hyperdrive `kaas-preview-<num>` + 预览 worker `kaas-preview-pr-<num>.workers.dev`，PR 关闭自动回收。
> **已知的现状与目标态差异（断言按现状值写，S5-d 已落地）**：
> - 生产 R2 桶实配 = **`kaas-files`**（≠ 目标态 `kaas-prod-storage`；桶迁移另立项，断言变量 `PROD_R2_BUCKET`）；
> - 生产 worker **尚无 KV 绑定**（目标态 KV 列是前瞻；预览 KV `KAAS_PREVIEW` 已建供预览用）；
> - Neon 分支 Protected 为**付费功能**，Free 套餐不可用 ⇒ 由预览脚本"删分支双保险校验"
>   （branch_id ≠ production 且 name ≠ production，缺一拒删）兜底。
>
> 当前生产仍为：`backend/worker/wrangler.jsonc` 只有 1 个 Hyperdrive（`f53fed49…` → Neon 生产分支）、
> R2 桶名 `kaas-files`、无 KV 绑定。**不要按本矩阵直接改生产配置**；预览链路见 `scripts/preview/README.md`。

核心原则：**环境之间物理隔离，不靠代码前缀或运行时判断区分生产与预览；预览之间共享预览专用资源，用 PR 前缀区分；开发默认本地，不触云。**

| 资源 | 生产 | 预览（所有 PR 共享预览专用资源） | 开发（默认） | 开发（远程冒烟，仅 wrangler dev --remote） |
| :--- | :--- | :--- | :--- | :--- |
| **Neon 分支** | 受保护 Root 分支 `main` | 每个 PR 从生产派生的独立子分支 `preview-<pr-slug>`，写时复制，独立凭证 | **本地 Docker PG** | Neon 开发分支 `dev` |
| **Hyperdrive config** | `kaas-prod-hyperdrive` → 生产分支 | 每个 PR 独立 config `kaas-preview-<pr-slug>` → 该 PR 的 Neon 分支，PR 关闭时回收 | **不适用（本地直连 Docker PG）** | `kaas-dev-hyperdrive` → 开发分支 |
| **R2** | `kaas-prod-storage` | `kaas-preview-storage`（所有预览共享，对象键用 `pr-<slug>/` 前缀区分 PR） | **本地 MinIO，桶名 `kaas-dev`** | `kaas-dev-storage` |
| **KV** | 生产 namespace ID `id` | 预览 namespace ID `preview_id`（所有预览共享，键用 `pr-<slug>:` 前缀区分 PR） | **本地持久化，不触云** | 开发专用 namespace |

### 2.3 硬规则（**目标态**约束 · 实施时不得违反）

1. **开发默认数据库是本地 Docker PG**。日常开发、单测、Alembic 迁移一律使用本地 Docker PG。Neon 开发分支仅用于 `wrangler dev --remote` 的部署前冒烟，低频使用，CI 不得依赖。不得将开发默认数据库改为 Neon 开发分支。
2. **开发默认存储是本地 MinIO**（docker-compose 已有，桶名 `kaas-dev`）。日常开发、单测、本地热重载一律使用本地 MinIO 或 wrangler dev 的本地 R2 模拟，不触远程 R2。远程 R2 开发桶 `kaas-dev-storage` 仅用于 `wrangler dev --remote` 冒烟，CI 不得依赖。
3. **生产、预览、开发远程的 R2 桶必须物理独立**：`kaas-prod-storage`、`kaas-preview-storage`、`kaas-dev-storage`。不得共用桶名，不得在同一桶内靠前缀区分生产与预览。
4. **生产、预览、开发的 KV namespace 必须物理独立**：生产用 `id`，预览用 `preview_id`，开发远程用独立 namespace。不得共用 namespace ID。
5. **预览桶内对象键必须带 `pr-<slug>/` 前缀**，预览 KV 键必须带 `pr-<slug>:` 前缀。前缀由 CI 在部署时注入 `PR_SLUG` 环境变量，代码从环境变量取前缀，不得硬编码。
6. **代码不得硬编码任何 bucket name、namespace ID、连接字符串**。所有绑定通过 `wrangler.toml` 和 CI 注入。
7. **Neon 生产分支必须设为 Protected**。预览分支从生产派生，自动获得独立凭证。三个环境的连接字符串不得相同。
8. **Hyperdrive 按环境独立**：生产、预览、开发远程各自独立 config。预览 config 与 Neon 预览分支一一对应，PR 关闭时回收。不得让预览 Worker 绑定生产 Hyperdrive config，不得让生产 Worker 绑定任何非生产 config。
9. **CI 防污染断言**（任一失败即中止部署）：
   - 生产部署前：绑定的 R2 bucket name 等于 `kaas-prod-storage`、KV namespace ID 等于生产值、Hyperdrive config ID 等于生产值，且均不等于任何预览/开发值。
   - 预览部署前：绑定的 R2 bucket name 等于 `kaas-preview-storage`、KV namespace ID 等于预览 `preview_id`、Hyperdrive config ID 指向该 PR 的 Neon 分支，且 `PR_SLUG` 已注入。
10. **清理**：PR 关闭时删除该 PR 的 Neon 分支（或设 TTL）、回收该 PR 的 Hyperdrive config、删除 `kaas-preview-storage` 中 `pr-<slug>/` 前缀下的对象、清理预览 KV 中 `pr-<slug>:` 前缀的键。开发远程资源由开发者手动清理，不进入 CI 自动清理。

### 2.4 CI 防污染断言（已确认 · 即 §2.3 规则 9 的独立落点，内容一致，任一失败即中止部署）

- **生产部署前**：绑定的 R2 bucket name 等于 `kaas-prod-storage`、KV namespace ID 等于生产值、Hyperdrive config ID 等于生产值，且均不等于任何预览/开发值。
- **预览部署前**：绑定的 R2 bucket name 等于 `kaas-preview-storage`、KV namespace ID 等于预览 `preview_id`、Hyperdrive config ID 指向该 PR 的 Neon 分支，且 `PR_SLUG` 已注入。

---

## 3. 双后端优化的最终决策（已确认）

### 3.1 方案 B 的最终形态（评估后修正版，不是任务书原版）

- **一份 app 代码，双入口**：同一份 FastAPI app 代码，本地用 uvicorn 热重载入口开发，生产用 Worker 入口部署。不再有独立的 orchestrator 业务实现（**S4 已落地 2026-10-19**）。
- **生产 Worker 运行时只用 asyncpg**。SQLAlchemy 模型仅存在于迁移目录，只在 Alembic 时加载。生产运行时依赖不得包含 sqlalchemy / alembic / greenlet。
- **wrangler dev 降级为部署前冒烟门禁**，不作为日常开发形态。实测冷启动 38s、热重载 33–72s，对比 uvicorn 2.72s / 21ms，不可接受。
- **迁移执行位置改为 CI 或独立 CLI**，不再常驻。`deploy.yml` 的 `migrate` job 已加（S2），S4 把依赖拆到 `[project.optional-dependencies].migrations`。
- **kaas_common 是唯一"脑"**：参数化 SQL、纯函数规则、报价引擎、业务枚举、SQLAlchemy models、Alembic migrations、默认值/约束口径全部集中在此。
- **kaas_common/db.py 已提供事务包裹执行**（S1）：裸 asyncpg 语句级 autocommit 无法复刻 savepoint 回滚语义，这是测试重写的前提；实现见 `backend/kaas_common/db.py`（`Session.transaction()`，嵌套自动 SAVEPOINT）。

### 3.2 三项已确认修正（原样）

1. **相对冷启动验收线**：基线实测中位 **2,680ms**，原"<1 秒"对任何方案不可达。验收线确定为 **≤2,950ms（基线 +10%）**。对 B 和 A′ 无差别。
2. **本地开发形态**：uvicorn 本地热重载 + wrangler dev 作部署前冒烟门禁。同一份 app 代码，双入口。wrangler dev 不作为日常开发形态。
3. **测试处置（S4 已按实际落地修正）**：原计划"约 1,085 条原样保留"的前提是 app.services/domain
   在新形态下存活；S4 选择**不搬迁业务壳**，因此这 1,220 条中只有 222 条（共享内核纯函数 + ORM 模型/
   迁移/schema 对齐）保留，其余按域由 worker 侧 parity 测试（auth/CRM/quote 三域已清零差异）与真 PG
   集成替代 —— 逐文件处置见 [docs/S4_TEST_MIGRATION_2026-10-19.md](docs/S4_TEST_MIGRATION_2026-10-19.md)。

### 3.3 路线 A 已否决，不得复活（已确认）

- 否决依据一：SQLAlchemy async 依赖 greenlet，**Pyodide/wasm 无 greenlet 轮子**导致
  `import sqlalchemy.ext.asyncio` 直接 ImportError（PyPI greenlet 3.5.6 共 79 个发行文件、0 个 wasm/emscripten 轮子）。
- 否决依据二：加 SQLAlchemy 后 Worker 冷启动中位 **2059ms → 3913ms（+1854ms）**，超验收线。
- 完整证据：[docs/POC_WORKER_SQLALCHEMY_2026-10-19.md](docs/POC_WORKER_SQLALCHEMY_2026-10-19.md)。
- 复活条件（仅记录，不排期）：上游/自建 greenlet wasm 构建，或放弃免费托管——两条当前均不成立。

### 3.4 为什么是 B 而不是 A′（对比）

| | A′（两壳 + 一脑，曾用方向） | **B（已确认）** |
|---|---|---|
| 运行时 | orchestrator 壳保留 SQLAlchemy Session + worker 裸 asyncpg 双适配 | 单一 asyncpg 运行时，无第二连接对象 |
| 行为漂移 | 靠测试覆盖压制（结构性风险残留） | 结构性消除（一份运行时实现） |
| 代价 | 小改 | 350–380 条测试重写 + 本地形态与迁移位置调整（§3.2） |
| 评估结论 | 对比项 | **B-可行**（[PLAN_B_EVALUATION](docs/PLAN_B_EVALUATION_2026-10-19.md) §6） |

---

## 4. 本地开发形态（已确认）

- **开发默认数据库：本地 Docker PG**（docker-compose 内置）。日常开发、单测、Alembic 迁移一律用它，不触云。
- **开发默认存储：本地 MinIO**（docker-compose 内置，桶名 `kaas-dev`）。日常开发、单测、本地热重载一律用它或 wrangler dev 的本地 R2 模拟，不触远程 R2。
- **日常开发唯一入口：`uvicorn local_run.py --reload`**（或 `docker compose up -d` 起 backend 服务，
  两者跑的都是 `backend/worker/src/main.py` 这一份 app；热重载实测：冷启动 2.72s、改动后 21ms 恢复）。
- **`wrangler dev` 仅作部署前冒烟门禁**，不作为日常开发形态（实测：冷启动 37.98s / 37.70s，热重载后首请求 32.9s / 72s 恢复，对比 uvicorn 14×/30× 劣化）。
- **Neon 开发分支 `dev` 与远程 R2 开发桶 `kaas-dev-storage` 仅用于 `wrangler dev --remote` 冒烟**，低频使用，不作为日常开发资源，CI 不得依赖（见 §2.3 规则 1、2）。
- 具体启动命令见 [§13 本地开发命令](#13-本地开发命令)。

---

## 5. 迁移执行方式（已确认）

- **Alembic 是唯一 Schema 变更来源**；执行位置 = **CI 步骤或独立 CLI**，不常驻、不在 Worker 请求路径中执行 DDL。
- **`deploy.yml` 已新增 `migrate` job**（S2）：生产部署前 `alembic upgrade head`，再部署 Worker。
  连接串放 secret **`PROD_DATABASE_URL`**；未配置时该 job 告警跳过（保持手动迁移现状）。
  迁移依赖隔离（主依赖去 ORM、`[project.optional-dependencies].migrations`）随 **S4** 落地。
- **迁移依赖隔离已落地（S4）**：orchestrator 主依赖为空，`[project.optional-dependencies].migrations`
  才装 sqlalchemy/alembic/psycopg2；CI 与 deploy 的迁移步骤统一 `uv sync --extra migrations` / `uv run --extra migrations alembic …`。
- 现状命令与 head（`202610190020`）见 [§15 数据库迁移](#15-数据库迁移)；**开发迁移目标永远是本地 Docker PG**（§2.3 规则 1）。

---

## 6. 测试策略（已确认）

- **重写范围**：350–380 条（约 27%，db-marked 288 + unit 中碰 DB 87，含少量双计）——因 ORM 造数/断言随壳迁移为 queries/ 裸 SQL；与阶段二 S3 同批做，共用 queries/ 造数。
- **marker 错位归位**：`-m unit` 中 87 条实际碰 DB 的用例先归位，避免 unit 门禁口径失真。
- **保留范围**：其余约 1,085 条原样保留——前提：其 import 的 app.services/app.domain 在 B 后以新形态存活。
- **真 PG fixture 复用**：直接复用 worker 侧 pgserver/PG_BIN 方案（`backend/worker/tests/integration/conftest.py`：临时 PG16、随机端口、临时数据目录；CI 用 postgres service），供给链零新建。
- **设计要求**：`kaas_common/db.py` 已提供**事务包裹执行**（S1，`Session.transaction()`，嵌套自动 SAVEPOINT）——裸 asyncpg 语句级 autocommit 无法复刻 orchestrator 的 savepoint 回滚隔离语义，这是测试重写的前提；种子 SQL 化须照抄 DDL 默认值（ORM `default=` 是客户端行为，历史 500 事故根因）。
- 现状门禁命令与基线见 [§14 测试与门禁](#14-测试与门禁)。

---

## 7. 冷启动验收线（已确认）

| 项 | 值 |
|---|---|
| **基线实测** | 生产 Worker `kaas` 中位 **2,680 ms**（样本 2663 / 2658 / 2856 / 2989 / 2680，n=5，全有效） |
| 测量方法 | `wrangler versions upload` 返回的 `Worker Startup Time`（Cloudflare 上传时实测；不接管流量） |
| 包体佐证 | Total Upload 11,588.84 KiB / gzip 2,934.96 KiB，与文档基线一致；免费层限值 64 MiB |
| 原验收线 | "<1 秒" —— 比基线低约 4 倍，对任何方案**物理不可达，已废弃** |
| **修正验收线** | **≤2,950 ms（基线 +10%）**，对 B 和 A′ 无差别 |
| 交叉对照 | DEPLOY.md 历史观测 ~2.8s ✓；POC 探针 2059ms（探针包体 10.8 MiB 较小，合理偏低） |

---

## 8. 已知问题清单（2026-10-19 评估发现）

| # | 问题 | 处置归属 |
|---|---|---|
| 1 | **空库快径缺 worker 表/列**：空库只 `metadata.create_all`，worker 需要的表/列缺失，新环境必 500 | **已修（S2 + S6-e）**：`env.py` 补齐模型 import（`88132af`）+ `legacy_models.py` 补 8 张 worker 独有表；**新增列级门禁** `check-schema-drift.py`（对生产列快照）再抓出 3 处缺列（`tenant_workstation_products.team_id`、`trade_docs.owner_id/owner_scope`、`market_ports.created_at/updated_at`）并补幂等迁移 `202610190020`。生产独有 13 张历史表已登记 allowlist；模型多出 5 张旧命名 refs 表（生产已改名 `_legacy`）→ **S4 清理** |
| 2 | **attribute-proposals 3 条路由生产 404**：有前端活页面在调（`admin/spec-proposals/page.tsx:53,64,83`） | **已修（S3）**：移植到 worker `ws_admin_proposals.py`（列表/推荐/审核，平台运营鉴权，12 条单测）；route-parity 缺失 11→8 |
| 3 | **DEPLOY.md 漂移**（曾与 P1 分支 PPG 配置比对得出"仍写 Neon"的漂移结论） | **本（文档）更新已修正**：决策 1 回 Neon 后，DEPLOY.md 的 Neon 口径与 main 生产实配重新一致；已补主文档指针 |
| 4 | **门禁登记理由可能过期**：allowlist 的 comtrade"定时器调度"说法与代码不符 | **已修（2026-10-19 复核）**：8 条登记逐条核对实现位置并更正理由（comtrade 实为长任务采集器、前端 0 调用）；指针改到归档原文 |
| 5 | **两个 APScheduler 定时任务生产从未执行**：15 分钟 replied→询盘自动扫描（生产已手动对等）、每日 events 归档（生产 246 行无人归档） | **已重建（S3 顺带项）**：CF Cron `triggers.crons`（`*/15 * * * *`；归档 `30 16 * * *` UTC = 上海 00:30），逻辑在 `backend/worker/src/ws_cron.py`，30 条单测；下次部署后生效 |
| 6 | **历史迁移链有结构性断点**：70 versions 中 35 个含 drop_table，downgrade 需逐版本审计 0.5–1 天 | 独立于 B：B 实施前完成审计 |
| 7 | **orchestrator vs worker 行数差口径**：旧文档"6000 行差"是错觉（worker 侧混入约 10,124 非空行 kaas_common 镜像） | **本（文档）更新已修正**：可比净差 **16,154 行**，见 §1 |

---

## 9. 决策记录（全部已确认 · 附依据）

| # | 决策 | 依据（防回退） |
|---|---|---|
| 1 | **生产数据库放弃 PPg，回 Neon**；生产 Hyperdrive 必须指向 Neon 生产分支；不保留 PPg 连接配置、不保留双路径 | PPg 固定 10 连接上限、不支持 Postgres 扩展，在 Workers + Hyperdrive 架构下是结构性阻塞；Neon 免费层 1 GB / 100 CU-hours / 10 分支，闲置仅缩容不清数据（§2.1） |
| 2 | **路线 A 已否决，不得复活** | greenlet 无 wasm 轮子 → `sqlalchemy.ext.asyncio` ImportError；+SQLAlchemy 冷启动 2059→3913ms（+1854ms）超线（§3.3，POC 文档） |
| 3 | **双后端优化采用方案 B**（评估结论 B-可行，含三项已确认修正） | [PLAN_B_EVALUATION](docs/PLAN_B_EVALUATION_2026-10-19.md)：Q1 成本中（350–380 条/3–5 人日）、Q2 无不可替代运行时逻辑、Q3 wrangler dev 冒烟可行但日常不可接受、Q4 基线实测；A′ 对比见 §3.4 |
| 4 | **三环境资源隔离矩阵 + 10 条硬规则** | 环境物理隔离、预览共享专用资源按 PR 前缀区分、开发默认本地不触云（§2.2–2.3，原样） |
| 修正-1 | 冷启动验收线 ≤2,950ms（基线 +10%） | 基线 2,680ms 实测；原 <1s 不可达（§7） |
| 修正-2 | 本地形态 = uvicorn 日常 + wrangler dev 冒烟门禁；同一份 app 双入口 | 实测 14×/30× 劣化（§4） |
| 修正-3 | 测试处置 = 27% 重写 + 87 归位 + ~1,085 保留 | fixture 级取证（§6） |

---

## 10. 实施排期参考

- 阶段二 S1–S6 ≈ **9–13 人日**（依赖拆分 0.5 / 迁移归位 1 / 路由合并 5–8 / 删壳+CI 1 / preview+deploy 1–2 / 静态门禁 0.5–1）；
- 阶段三 ≈ **5–8 人日**；**全案 ≈ 14–21 人日**（不含观察期）。
- **最大不确定点**：① 测试重写处置的执行返工；② 行为漂移真实面积（除缺失 11 条路由外，S3 逐路由核对时才能量化）。

---

## 11. 当前业务模块

| 工位 | 状态 | 说明 |
|---|---|---|
| 进出口情报 | 已上线 | 海关/贸易数据、货运记录、竞争格局 |
| 市场调研 | 已上线 | 从地图源挑选并深化（品类/价格/观察/能否提供） |
| 地图源客户信息获取 | 已上线 | Google Places 拓店铺 + 爬官网提产品 + CSV 导入 |
| 线索池 | 已上线 | `lead_candidates` 共享池，工位间唯一通信接口 |
| 客户/询盘 | 已上线 | 客户阶段、询盘三态（未报价/已报价/已关闭）、询盘编号 |
| 报价 | 已上线 | 多产品算价、成本手填、产品税率、整单保险、批量报价 |
| 订单 | 已上线 | 报价转化、状态机、应收/付款计划、汇兑损益 |
| 外贸单证 | 已上线 | 报价/订单/询盘生成 PI、CI、PL 等，快照留档 |
| 出运台账 | 已上线 | 出运记录、单号、订单关联 |
| 税务管理 | 已上线 | 企业税档（销项/杂税）+ 产品税率（进项/退税） |
| AI 层 | 已上线 | BYOK Provider、任务模板、用量审计 |
| 客户触达 | 已上线 | 邮箱/campaign/发送/重发 |

---

## 12. 本轮（2026-10-18）上线内容

### 12.1 税务档案

税务管理分两块：

1. **企业税档**：销项增值税、杂税（印花税已含在杂税里）；
2. **产品税率**：进项增值税、出口退税率，按产品逐条维护；
   - 同一团队同一产品只能一条；
   - 已配置的产品不会在下拉里重复出现；
   - 税变化时在一个页面统一改。

报价时：

- 企业税档带销项税、杂税；
- 每行按产品带进项税、出口退税率；
- 报价单保存 `tax_snapshot`，其中 `product_taxes` 保留当时各产品税率。

### 12.2 成本

- **所有报价行成本必须手填**；
- 历史报价只作为参考显示，必须点「应用参考成本」才带入；
- 不会自动套用产品定义里的默认成本；
- 未填成本不能算价、不能保存；后端保存报价时也会校验。

### 12.3 整单保险

- 仅对 **CIF / DAP / DDP** 生效；
- 公式：`保险费 = 整单 EXW 货值 × 1.1 ÷ 1000`，**最低 15 美元**；
- 整单只算一次，按各报价行 EXW 货值比例分摊；
- 报价页保险项显示“自动计算”，不要求手填；
- 后端 `/export-quote/calculate` 回传 `meta.term_totals` 供前端两轮计算。

### 12.4 批量报价

- 报价工位 → 批量报价页；
- 选客户 → 选询盘 → 统一产品/规格/成本/件数 → 生成报价单；
- 单批最多 200 行；
- 同一询盘允许多张报价，默认最新一张；某张生成后续单证后，同询盘其他报价转 `closed`；
- 未配置产品税率的产品会被拦截，提示先到税务管理配置。

### 12.5 其他口径

- 船公司固定选项，格式「中文名-英文缩写」（如 `马士基-MSK`、`地中海航运-MSC`、`中远海运-COSCO`）；
- 客户按米报需求时，报价行可填米数，系统按“每卷米数”自动换算卷数，**小数进一**；
- 编号格式：`类型-国家-客户-时间戳`，例如 `INQ-US-TIM-20261018111149`、`QUO-US-TIM-...`、`PI-...`、`SHP-...`；
- 国外费用美元、国内费用人民币，按报价汇率折算。

---

## 13. 本地开发命令

> 形态口径见 [§4 本地开发形态](#4-本地开发形态已确认)（默认本地 Docker PG + 本地 MinIO、uvicorn 日常、wrangler dev 仅冒烟）。
> 以下为**当前（实施前）**命令；方案 B 实施后 uvicorn 入口不变，orchestrator 业务实现并入同一份 app。

### 13.1 启动

```powershell
# 根目录：起 Postgres / Redis / MinIO / backend（backend = worker local_run，单应用）
docker compose up -d

# 首次建表（空库快径；与生产同一套 Alembic）
cd backend/orchestrator
uv sync --extra migrations
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --extra migrations alembic upgrade head

# 健康检查
curl http://localhost:8000/health

# 前端（另一个终端）
cd frontend
pnpm install
pnpm dev                      # http://localhost:3000
```

前端 `.env.development` 默认：

```env
NEXT_PUBLIC_API_MODE=real
NEXT_PUBLIC_API_BASE_URL=http://localhost:8000
```

只想用 mock（无需后端）：把 `NEXT_PUBLIC_API_MODE` 改为 `mock`。

### 13.2 后端单独启动（不经 Docker）

```powershell
# 1) 起本地 PG（compose 里已有）
docker compose up -d postgres
# 2) 首次建表
cd backend/orchestrator
uv sync --extra migrations
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --extra migrations alembic upgrade head
# 3) 起 app：**生产同一份** worker app（uvicorn 只是本地入口）
cd ../worker/src
$env:JWT_SECRET="local-dev-jwt-secret-at-least-32-chars!!"
$env:ADMIN_SETUP_TOKEN="local-setup-token"
$env:LOCAL_DATABASE_URL="postgresql://kaas:kaas_dev@localhost:5432/kaas_dev"
$env:LOCAL_RELOAD="1"
uv run --with uvicorn --with fastapi --with asyncpg --with pydantic --with pyjwt --with bcrypt --with python-multipart python local_run.py
```

### 13.3 本地登录账号

> **S4 起不再有预置账号**（旧 `seed_dev.py` 已随 orchestrator 业务壳删除）。
> 首次启动后用 `ADMIN_SETUP_TOKEN` 引导一个系统管理员，其余账号走注册/邀请流程。

```powershell
# 引导系统管理员（bootstrap 只允许第一次；已初始化后再调返回 403）
curl.exe -X POST http://localhost:8000/api/v1/auth/bootstrap-admin `
  -H "Content-Type: application/json" -H "Authorization: Bearer local-setup-token" `
  -d '{\"email\":\"admin@kaas.local\",\"password\":\"DevAdmin2026!\",\"display_name\":\"本地管理员\"}'
```

登录：`http://localhost:3000/login`。API 文档：`http://localhost:8000/docs`。

> 注意：`http://localhost:8000/` 根路径返回 401 是正常的；健康检查用 `/health`。

---

## 14. 测试与门禁

```powershell
# 迁移/模型测试（S4 删壳后：222 条 = 共享内核纯函数 + ORM 模型/schema/迁移对齐）
cd backend/orchestrator
uv sync --extra migrations
uv run --extra migrations pytest tests -q

# Worker 单测（唯一运行时：954 passed + 5 skipped）
cd backend/worker
uv run --frozen --with pytest --with httpx2 python -m pytest tests -q

# Worker 真 PG 集成（本地 Docker PG）
$env:TEST_DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_worker_test"
uv run --frozen --with pytest --with httpx2 python -m pytest tests -m integration -q

# 前端
cd frontend
pnpm typecheck
pnpm lint
pnpm test

# 共享内核同步与检查
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check

# 运行时依赖断言（方案 B S1，CI 双闸也跑）
backend/orchestrator/.venv/Scripts/python.exe scripts/check-runtime-deps.py

# schema 完备性断言（方案 B S2：worker SQL 引用的表 ⊆ 空库快径 metadata）
backend/orchestrator/.venv/Scripts/python.exe scripts/check-schema-coverage.py

# 列级漂移断言（2026-10-19 S6-e：模型必须覆盖生产列快照的全部列/表）
# 快照过期时重生成（只读生产）：
#   backend/orchestrator/.venv/Scripts/python.exe scripts/dump-prod-schema-columns.py
backend/orchestrator/.venv/Scripts/python.exe scripts/check-schema-drift.py

# Worker 包体积/冷启动门禁（S6-c；pywrangler dry-run 不上传不部署；本机工具链不可用时 SKIP）
backend/orchestrator/.venv/Scripts/python.exe scripts/check-worker-bundle.py

# 契约检查（前端 zod ↔ 共享内核 / 冻结契约快照；R6 openapi 新鲜度已随单应用退役）
cd frontend
pnpm contracts:check

# 静态导出（Next 16：out/ 为产物；**不要设 NEXT_DIST_DIR**，否则产物会落到该目录）
$env:NEXT_EXPORT="1"
cd frontend
pnpm build                 # → frontend/out（267 文件；与 deploy.yml 产物路径一致）
```

测试资产（2026-10-19 评估口径，见 [PLAN_B_EVALUATION §1](docs/PLAN_B_EVALUATION_2026-10-19.md)）：

- orchestrator（S4 删壳后）：only `app/db` + `alembic`；测试 **222 passed**（共享内核纯函数 + ORM 模型/
  schema/迁移对齐）；逐文件处置见 [S4_TEST_MIGRATION](docs/S4_TEST_MIGRATION_2026-10-19.md)；
- worker：**954 passed + 5 skipped**（含迁入的 15 个报价引擎测试文件；三域 parity 棘轮已清零）；真 PG 集成 5 条
  （`@pytest.mark.integration`；本地无 PG 自动 skip，CI 由 `worker-db-tests` job 用 postgres service 跑）；
- 前端（Next 16 / React 19）：typecheck ✅ / lint **0 errors（91 warnings）** / **455 passed** /
  e2e **23 passed + 4 skipped** / `NEXT_EXPORT` 构建 ✅（`frontend/out` 267 文件）；
- 列级漂移 0 / 表级缺失 0；contracts:check 全 PASS（R6 已退役，`scripts/archive/route-parity.py` 为历史门禁）；
- 依赖安全：`pnpm audit` **0 critical**（3 high 均 dev-only，见 HANDOVER §2.3）。

E2E：

| 模式 | 命令 | 说明 |
|---|---|---|
| MSW contract E2E | `cd frontend && pnpm e2e` | 默认，无需后端 |
| Real Backend E2E | `NEXT_PUBLIC_API_MODE=real-backend pnpm e2e` | 需 Docker + 后端 |

---

## 15. 数据库迁移

当前 head：**`202610190020`**。

本轮相关迁移：

| 版本 | 内容 |
|---|---|
| `202610190020` | 补齐生产已有、迁移链缺失的列（`trade_docs.owner_id/owner_scope`、`market_ports.created_at/updated_at`；幂等 DO 块） |
| `202610180006` | 企业税务档案表 + 种子 + 旧客户税率档案迁移 |
| `202610180007` | 报价单税务快照 |
| `202610180008` | 安全占位（原删表动作延后） |
| `202610180009` | 产品税率表 |
| `202610180010` | 发布后清理：删旧客户税率档案表、清旧进项/退税键 |

生产发布必须分段执行：**先 009 → 部署 Worker → 冒烟 → 再 010**。
完整步骤见 [docs/DEPLOYMENT_PLAN_2026-10-18.md](docs/DEPLOYMENT_PLAN_2026-10-18.md)。

```powershell
cd backend/orchestrator
alembic heads
alembic current
alembic upgrade 202610180009   # 发布前
# 部署 + 冒烟
alembic upgrade 202610180010   # 发布后清理
```

> 生产库连接串只放在本机环境变量 / `.env.local`，不要提交。
> 方案 B 实施后迁移执行位置改为 CI 或独立 CLI（§5），开发迁移目标永远是本地 Docker PG（§2.3 规则 1）。

---

## 16. 部署

- ⚠️ **自动部署已冻结（2026-10-19 重构期 · 用户指令）**：`deploy.yml` 不再监听 push，只保留
  `workflow_dispatch`。**必须等用户明确下达部署指令后才部署**，中途提交一律不发布。
- ⚠️ **GitHub Actions 额度已达限额（2026-10-19 用户确认）**：CI/部署工作流可能无法启动；
  最终发布改走**本机 `pywrangler deploy`**（或额度恢复后手动 `workflow_dispatch`）。
- 流程：前端静态导出 → 同步共享内核 → `pywrangler deploy` → 生产冒烟；
- 冷启动窗口、回滚、Neon/Hyperdrive 说明见 [DEPLOY.md](DEPLOY.md)；
- 本轮发布顺序、风险、验收清单见 [docs/DEPLOYMENT_PLAN_2026-10-18.md](docs/DEPLOYMENT_PLAN_2026-10-18.md)。

常用运维：

```powershell
cd backend/worker
npx wrangler deployments list --name kaas
npx wrangler versions deploy <version-id>@100% --name kaas --yes
```

---

## 17. 关键业务规则

### 17.1 询盘 / 报价状态

- 询盘：`unquoted`（未报价）→ `quoted`（已报价）；`closed`（已关闭）为手动；
- 报价：`draft / sent / accepted / rejected / expired / closed`；
- 询盘生成报价后自动变已报价；
- 报价生成后续单证（PI/合同等）后，同询盘其他报价自动 `closed`；
- 询盘编号在生成报价前可改，生成报价后锁定并二次确认。

### 17.2 单号

统一 `类型-国家-客户-时间戳`：

- `INQ-...` 询盘
- `QUO-...` 报价
- `PI-...` / `CI-...` / `PL-...` 单证
- `ORD-...` 订单
- `SHP-...` 出运

### 17.3 成本 / 税 / 保险

详见 [docs/QUOTE_COST_INSURANCE_2026-10-18.md](docs/QUOTE_COST_INSURANCE_2026-10-18.md)。

---

## 18. 仓库结构

```
backend/
  kaas_common/            共享内核（唯一源：SQL/纯函数/报价引擎/枚举）
  orchestrator/           迁移与模型工具（S4 后仅 app/db + alembic；不可运行后端）
  worker/                 唯一运行时：Cloudflare Worker（Python FastAPI + assets）+ local_run.py 本地入口
frontend/                 Next.js 16 静态导出（out/）
shared/contracts/         前后端 zod 契约
scripts/                  sync-shared / contracts / schema 门禁 / 包体积 / 迁移审计；archive/ 为已退役脚本
docs/                     设计与交接文档
.github/workflows/        backend-test / frontend-ci / contracts-check / deploy
docker-compose.yml        本地基础设施 + 本地后端（worker local_run）
```

---

## 19. 文档索引

**主交接文档：本文（架构 / 三环境隔离 / 方案 B 决策 / 冷启动 / 测试策略）**

- [DEPLOY.md](DEPLOY.md) — 生产部署与运维速查
- [docs/HANDOVER_2026-10-20.md](docs/HANDOVER_2026-10-20.md) — **2026-10-20 交接总入口**（本轮改动/回归证据/待你操作事项/发布检查单）
- [docs/USER_ACTIONS_2026-10-19.md](docs/USER_ACTIONS_2026-10-19.md) — 需用户执行的操作（安全/业务/环境决策，含步骤与验证）
- [docs/ENV_VERIFICATION_2026-10-19.md](docs/ENV_VERIFICATION_2026-10-19.md) — 三环境核对与发布检查单
- [docs/PLAN_B_EVALUATION_2026-10-19.md](docs/PLAN_B_EVALUATION_2026-10-19.md) — 方案 B 阶段一评估报告（四问取证，结论 B-可行）
- [docs/MASTER_EXEC_PLAN_2026-10-19.md](docs/MASTER_EXEC_PLAN_2026-10-19.md) — 总执行清单（P1 迁库批次已随决策 1 废弃）
- [docs/PROBLEM_STATUS_2026-10-11.md](docs/PROBLEM_STATUS_2026-10-11.md) — 问题状态滚动口径
- [docs/SECURITY_AUDIT_2026-10-19.md](docs/SECURITY_AUDIT_2026-10-19.md) — 安全审查报告（危/高/中/低 + 三环境核对 + 需用户操作清单）
- [docs/MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md](docs/MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md) — 迁移链 downgrade 审计（drop_table 精确 3 个）
- [docs/S4_SINGLE_APP_PLAN_2026-10-19.md](docs/S4_SINGLE_APP_PLAN_2026-10-19.md) — S4 单应用收口设计（worker 为唯一运行时）
- [docs/POC_WORKER_SQLALCHEMY_2026-10-19.md](docs/POC_WORKER_SQLALCHEMY_2026-10-19.md) — 路线 A 否决证据
- ~~[docs/PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md](docs/PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md)~~ — **已废弃**（决策 1：放弃 PPg 回 Neon）
- ~~[docs/HANDOVER_2026-10-19_P1_PPG_MIGRATION.md](docs/HANDOVER_2026-10-19_P1_PPG_MIGRATION.md)~~ — **已废弃**（决策 1：P1 迁库终止，历史保留）
- [docs/TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md](docs/TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md) — 税务改造
- [docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md](docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md) — 批量报价
- [docs/QUOTE_COST_INSURANCE_2026-10-18.md](docs/QUOTE_COST_INSURANCE_2026-10-18.md) — 成本/保险/计量口径
- [docs/SHEET_CALC_VERIFICATION_2026-10-18.md](docs/SHEET_CALC_VERIFICATION_2026-10-18.md) — 智能表格算价核验
- [docs/WORKSTATION_DESIGN.md](docs/WORKSTATION_DESIGN.md) — 工位总体设计
- [docs/CURRENT_IMPLEMENTATION_MAP.md](docs/CURRENT_IMPLEMENTATION_MAP.md) — 当前实现地图

---

**最后更新**：2026-10-19 晚场（记录决策 1–4 与三项已确认修正；分支收编 `88132af` 与文档收口同步）
