# 交接文档 · 2026-10-20 最终版（S5 预览交付 + 云资源治理 + 2026-10-21 生产发布已完成）

> **本文是当前主交接文档**。历史口径见 `PROBLEM_STATUS_2026-10-11.md`（滚动状态）与
> `README.md`（架构/环境矩阵/门禁唯一权威）。本文日期区间：**2026-10-20 全天**；
> **2026-10-21 生产发布三次部署与最终状态见 §0.4 / §0.2.1**。

## 0. 一句话状态

**S5 预览环境已全量交付并在 CI 端到端验证通过**（自动建库/部署/评论/回收，无需人工批准）；
**生产与预览、开发三环境隔离核验到位**；本轮清理了 2 个废弃库 + 1 个废弃 Neon 分支 + 1 个 PPG
Hyperdrive，并给 worker 依赖钉版入库。**前端 UI 优化 P0/P1/P2 已于 2026-10-20 下午全部收口**
（详见 `UI_UX_OPTIMIZATION_2026-10-20.md` §11）；**待办账本 = [`docs/TODO.md`](./TODO.md)**（2026-10-20 晚
口径修订：原「触发条件制」项全部恢复为活跃待办——单证内容专项 / 产品配置化 / 原 I-1~I-7 /
发布窗口项，由用户排期执行）。**后端 5 项已完成**（见 §0.1；`UI_BACKEND_DEPENDENCIES_2026-10-20.md` 转为验收基线）。
**开发已于 2026-10-20 晚按用户指令停止**，停止点与剩余工作见 **§0.2**。
**2026-10-21 已按用户指令完成生产发布窗口**：生产迁移 `202610180010`→**`202610200005`**（6 条），
Worker 三次部署（`dae596a5` → `cd15e9a5` → `9d497628`），冒烟通过；P4 观察期自 2026-10-21 起，详见 §0.4。

## 0.2 停止点交接：当前状态与剩余工作（**交接 agent 必读**）

### 0.2.1 停止点（2026-10-20 晚）

- **用户指令**：停止继续开发；把现状与剩余工作写进交接文档；归档过时文档；推送远程。
- **代码已在 `main`（2026-10-20 晚合并完成）**：PR #5 已合并，合并提交 **`118af7c`**；
  **`main` 的 CI 三条 workflow 全绿**（backend:test / contracts:check / Frontend CI；
  preview 只在 PR 事件跑）。**新设备 / 新 agent `git clone` 即拥有全部代码与交接文档**，
  无需切分支（分支 `feat/trade-doc-content-a` 是历史分支，**已删除**，见 §8）。
- **原开发位置**（仅历史记录）：分支 `feat/trade-doc-content-a`（独立 worktree
  `D:\projects\kaas-platform\.agents\worktrees\feat\trade-doc-content-a` **现已不存在**，勿按此路径找；
  主工作树当时是并行 UI 线在用，**未改动**）。
- **预览已回收**：PR #5 合并后按 `pull_request closed` 触发 teardown，**worker / Neon 分支 `preview-pr-5` /
  Hyperdrive / R2 前缀 / 预览 KV 已全部回收**（worker 现 404；Teardown job green）。
- **仓库可见性（2026-10-20 审计复核）**：用户口径 = 收尾完成后转回 **private**，但**实测当前仍为 public**
  （匿名 `git ls-remote https://github.com/dsun-io/kaas-platform` 成功；`gh` 本机未登录，Settings/Actions 未核）
  ⇒ **「转回 private」尚未完成，不是已完成项**，已统一登记 `docs/TODO.md`（D5）；private 期间 GitHub Actions 不可用，
  门禁以本地命令为准；本地各门全绿数字见 §0.1。
- **发布已于 2026-10-21 完成（详见 §0.4）**：用户下令后执行「迁移 → 构建 → 本机 `pywrangler deploy` → 冒烟」，
  生产迁移 `202610180010` → **`202610200005`**（6 条），Worker 三次部署
  （`dae596a5` → `cd15e9a5` → `9d497628`），三条 cron 保留；回滚版本见 §0.4。
  **后续发布仍仅手动**（`deploy.yml` 只 `workflow_dispatch`；优先本机 `pywrangler deploy`），按 §5 检查单走。

### 0.2.2 已完成（本分支 + 已合入 main 的 UI 线）

- 用户点名的**后端 5 项**：F1 签发自动上传、F2 内容版本、F3 个人信息、F4 询盘状态机、F5 报价/订单 1:N —— 全部 ✅（细节/证据见 §0.1）。
- 单证内容专项 A 组：A1（内容版本）、A3（字段体检）、A8/A9（指纹对账 cron + 列表标识）✅；
  顺手修线上 `GET /trade-docs` 500。
- 迁移 head：**`202610200005`**（2026-10-21 追加 `202610200004` 单证事实表与 `202610200005` 文件当前版本唯一索引 `NULLS NOT DISTINCT`；**生产已于 2026-10-21 应用到该 head**，见 §0.4）。
- 配置：两把 Resend key 已入 GitHub repo secrets（`RESEND_API_KEY_PROD` / `RESEND_API_KEY_PREVIEW`），换设备不失；
  生产 key 待发布窗口注入 Cloudflare（`docs/TODO.md` D1）。

### 0.2.3 剩余工作（全部登记在 [`docs/TODO.md`](./TODO.md)，按建议顺序）

| 组 | 项 | 前置 / 备注 |
|---|---|---|
| A2-方案B | 模板迁服务端（方案 B）：让「任意客户端/API 签发」都能服务端出 PDF | **方案 A 已完成**（`ws_files.archive_rendered_pdf`，confirm/PATCH 两入口已接线）；方案 B 未做，**已登记 TODO `A2-B`（🧭 需用户定要不要做）** |
| A4 | 单证图片素材库 | ✅ 2026-10-21：渲染改**短期签名直链**（`files/token.py` HMAC 900s + `render-content` 端点，文件/公章各一条），回退 data URI；素材库复用现有产品图库+公章库（无新表） |
| A5 | 单证编辑体验（行项批量编辑、条款模板、金额联动校验） | **需先与用户过方案**（🧭） |
| A6 | 模板逐字段对照真实出口单据 | **需用户提供样例单据**（🧭），是单证内容的最终验收标准 |
| A7 | 单证加固 P1/P2（事实层/一致性引擎/收款容差/回执登记/导出自检） | ✅ **2026-10-21 全部落地**：①事实层 + ②一致性引擎内核（87 测）+ 事实表（迁移 `202610200004`）+ **10 个 Worker 端点**（34 测）+ **UI**（事实确认/一致性三档/收款/单证清单/签发闸门，面板 9 + 契约 12 测）。`confirm` 默认拦截未确认事实，`allow_lint_override` 未对前端开放；口径见 [`TRADE_DOC_HARDENING.md`](./TRADE_DOC_HARDENING.md)。尾巴：导出自检 UI 需 PDF 文本抽取（TODO C21） |
| A8-① | PDF 归档「端到端真实跑一次」 | 需已部署环境（Browser Rendering 依赖生产 binding），归发布后 P4 |
| A9-补充 | preview ensure 对 Neon 423 短重试（TODO D7） | 低优先；本次靠 rerun 通过 |
| B1 | 租户级产品定义配置化 | ✅ **2026-10-21 销账**（端到端验收 + B4/B5/B6 修复复验）：`/tenant-products` CRUD 全通（201/200/200/204、409/422/404）、跨团队写/删 404、`/formulas`+`/explain` 回落租户产品、运行时算价即时生效；**系统级**产品仍靠 Python `@register`（4 个），属 §G-3 待用户定口径 |
| B2 | 产品可视化编辑器收尾（运行时生效链路） | ✅ **2026-10-21 端到端验收**：克隆 `field_fence` → 同价 3.041 → PUT `raw_price×1.2` → **同会话无重启**立即算得 3.6357 元/米（+19.6%），列表同步改名 |
| B3 | 租户开通报价工位 UI 交互 | ✅ **2026-10-21 端到端验收**：`PUT /teams/{id}/subscriptions/{code}` 后同一进程内 `/me/workstations` codes `[]→["full_chain"]`、中间件门 404→放行；`DELETE` 后立即回退（缓存失效生效） |
| C1 | 「流失」拒绝文件链路（订单新增 `lost`） | 🧭 需业务设计 + 用户拍板 |
| C2 | 文件存储收尾 4 项（真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试 / 产品图 `doUpload` 页面层测试） | ✅ **2026-10-21 收口**：`products-page-upload-and-sort.test.tsx`（页面级 upload/排序）+ 真 PG 写入路径用例（`tests/integration/`）；顺修 C22（迁移 `202610200005` 文件唯一索引 `NULLS NOT DISTINCT`）。TODO 账本由 Lead 销账 |
| C3 | Cloudflare agent 接入 | 🧭 价值未明，待用户排优先级 |
| C4 | 30/90 天客户自动沉寂 | 🧭 用户曾裁「先手动」，要做需重新设计 |
| C5 | 本地 mock 刷新丢数据（MSW 限制） | ✅ 2026-10-21：`mocks/persistence.ts` 版本化键 localStorage 持久化（47 集合、`?mock_reset=1` 重置、SSR no-op） |
| C6 | e2e 数据层不稳根治 | ✅ 2026-10-21：MSW 长尾覆盖 0 缺口（`mocks:check` 门禁）+ e2e 种子/空 storage/`?mock_reset=1` 三保险 + workers=2/NO_PROXY；全量 60 files/616 tests 22s 全绿 |
| D1–D7 | 发布窗口项（RESEND 注入 / R2 新密钥 / Hyperdrive 缓存 / 生产测试数据清理 / 仓库转 private / 发布检查单 §5 / preview ensure 对 Neon 423 重试） | **发布已于 2026-10-21 执行（§0.4）**；**D1/D2/D4 待用户动作**（D4 执行前需弹窗确认），D5 仓库转 private 待用户处理。注意 D3 口径：TODO 记 🧭 待批准，`PROBLEM_STATUS` 旧记录写「⏳ 发布窗口」，以 TODO 为准 |

### 0.2.4 恢复工作的最短路径

1. **在 `main` 上工作**：`git clone` 后直接改 `main`（PR #5 已合并，**无需切分支**）。
   历史 worktree `D:\projects\kaas-platform\.agents\worktrees\feat\trade-doc-content-a` 在新设备/本机均已不存在，
   勿再按旧路径找；`git worktree list` 当前只有主工作树。
2. 先读：`docs/README.md`（检索入口）→ 本文件 §0.2 → `TODO.md` → `PROBLEM_STATUS` 顶部。
3. 改完代码同步文档（`PROBLEM_STATUS` 顶部 + `TODO.md` 销账），提交并 push **`main`**
   （PR #5 已合并，不会再有「推送分支 → PR 自动更新」；需要预览就新开 PR）。
4. 门禁命令（**跑之前先确认 `scripts/sync-shared.ps1` 已同步**——`backend/worker/src/kaas_common/`
   是 gitignored 生成镜像，缺 `kaas_common.preview` 会直接 `ModuleNotFoundError`；其余注意 AGENTS.md 的工具链坑）：
   - worker：`cd backend/worker; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q`（现 **1233 passed + 12 skipped**；12 条 db/integration 档按约定 skip，有 docker PG 时会真跑、总数 1245）
   - orchestrator：`cd backend/orchestrator; uv run --extra migrations pytest tests -q`（现 **247**）
   - 前端：`pnpm typecheck` / `pnpm lint` / `pnpm test`（现 **616 passed / 60 files**）/ `pnpm contracts:check` / `pnpm mocks:check` / `pnpm ui:contrast` /
     `pnpm e2e`（**实测 28 条 = 24 passed + 4 skipped**，2026-10-20 `playwright test --list`）；构建与 e2e **不要同时跑**（共用 `.next`）
   - 静态：`scripts/check-runtime-deps.py`、`check-schema-coverage.py`、`check-schema-drift.py`、`scripts/sync-shared.ps1 -Check`
5. 改 `backend/kaas_common/**` 后必须 `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`（否则 worker 镜像是旧的）。

### 0.2.5 本轮文档整理

- 新归档批：[`docs/archive/2026-10-20-backend-closeout/`](./archive/2026-10-20-backend-closeout/README.md)
  （`ENV_VERIFICATION_2026-10-19.md`：迁移 head/预览状态已过时，当前看根 README §2 + 本文件 §2/§3/§5）。
- `E2E_GUIDE.md` 已就地更新到 2026-10-20 口径。**2026-10-20 审计复核（以实测为准）**：
  `playwright test --list` = **28 条（24 passed + 4 skipped）**；原文写的「27 条（23+4）」少 1 条，
  由 docs-b 在 `E2E_GUIDE.md` 同步修正，本文件不再复述旧数字。
- **UI 线文档已加状态横幅/逐处改状态（2026-10-21 C38 文档收尾）**：`UI_UX_OPTIMIZATION_2026-10-20.md`（P0/P1/P2 完成、§11 终验）、
  `UI_BACKEND_DEPENDENCIES_2026-10-20.md`（历史验收基线）；另有 4 份过时设计/计划移入
  [`docs/archive/2026-10-21-doc-closeout/`](./archive/2026-10-21-doc-closeout/README.md)。
- 检索入口仍是 [`docs/README.md`](./README.md)（已同步状态与归档批次）。

### 0.3 新设备 / 新 agent 接手清单（**设备无关**，换机也能完整接手）

> 前提：PR #5 **已合并到 `main`（合并提交 `118af7c`，main CI 全绿）** ⇒ 新设备 `git clone` 即拥有
> **代码 + 全部交接文档**（`docs/TODO.md` 的剩余待办也在 `main` 上，直接可检索）。

**0.3.1 仓库与文档在哪**

- 仓库：`https://github.com/dsun-io/kaas-platform`；交接文档全在 `docs/`，检索入口 `docs/README.md`。
- 以 `main` 为准（新设备 clone 默认分支即 `main`）；分支 `feat/trade-doc-content-a` 是已合并的历史分支，**已删除**。

**0.3.2 本机有、Git 里没有（换设备会缺，必须重建）**

| 本机东西 | 为什么不入库 | 新设备怎么办 |
|---|---|---|
| `.env.local` | **含密钥**，`.gitignore` 明确忽略；**现只是生产 DSN 存档（已加警示注释）**，本地开发**不读**它（`local_run.py` 用 `LOCAL_DATABASE_URL`，默认 Docker PG） | 新建该文件，按下表变量名填值；值从 GitHub repo secrets / Neon / Resend / 用户处取 |
| `backend/worker/src/kaas_common/`（**gitignored 生成镜像**） | 由 `scripts/sync-shared.ps1` 从 `backend/kaas_common/` 生成（`backend/worker/.gitignore:15`），不入库 | **clone/切换分支后先跑** `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`（本机实测 `-Check` 三行全「一致」）；未同步会崩在 `ModuleNotFoundError: No module named 'kaas_common.preview'`（`ws_files.py:51`） |
| 本地开发库 `kaas_dev`（Docker volume） | 运行数据，不入库 | 空库快径：`cd backend/orchestrator && uv run --extra migrations alembic upgrade head` → 本机实测 **106 表 / head `202610200005`**；**不要修历史迁移链**。半初始化的旧库（如停在 `202610180010`/93 表、缺 `market_ports`）先 `ALTER DATABASE … RENAME TO …_legacy_<日期>` 保留，再建空库走快径 |
| `backend/.tools/`（删除前备份 CSV） | gitignored 的运维临时产物 | 历史备份不必恢复；需要时从旧设备拷 |
| `frontend/node_modules`、`**/.venv` | 依赖产物 | `cd frontend && pnpm install`；`uv sync`（见 §0.2.4 门禁命令） |
| 本地 Docker 容器（PG/Redis/MinIO） | 环境 | `docker compose up -d` |
| worktree 路径 `.agents/worktrees/...` | 本机 git worktree 布局 | 新设备不需要 worktree；`git clone` + 在 `main` 上工作即可 |

**0.3.3 密钥/配置的持久位置（克隆仓库不包含，但换设备仍可用）**

- **GitHub repo secrets（12 个，仓库 Settings → Secrets 可见名称）**：`PROD_DATABASE_URL`、
  `NEON_API_KEY`、`NEON_PROJECT_ID`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`JWT_SECRET`、
  `ADMIN_SETUP_TOKEN`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_ENDPOINT`、
  **`RESEND_API_KEY_PROD`**、**`RESEND_API_KEY_PREVIEW`**。
- **Cloudflare Worker（生产 `kaas`）secrets**：`JWT_SECRET` / `ADMIN_SETUP_TOKEN` / `S3_ACCESS_KEY` /
  `S3_SECRET_KEY`（已配）；**`RESEND_API_KEY` 待发布窗口注入**（值 = repo secret `RESEND_API_KEY_PROD`）。
- **Neon / Cloudflare / Resend 控制台**：项目、分支、桶、Hyperdrive、域名
  （`send.powervoy.com` 已验证）都在云上，与设备无关；新设备只需账号权限。
- `.env.local` 需要的变量名（**只写名，不写值**）：`DATABASE_URL`（Neon 生产 DSN **存档**，已加警示注释）、
  `RESEND_API_KEY`、`RESEND_API_KEY_PROD`、`RESEND_API_KEY_PREVIEW`；旧字段 `DATABASE_URL_PPG` 已废弃可删。
  **注意：本地开发不读 `.env.local`** —— `local_run.py` 用 `LOCAL_DATABASE_URL`（默认 Docker PG）。

**0.3.4 新设备首次接手步骤**

1. `git clone https://github.com/dsun-io/kaas-platform && cd kaas-platform`
2. 装依赖：`cd frontend && pnpm install`；`cd backend/worker && uv sync`；`cd backend/orchestrator && uv sync --extra migrations`
3. **先跑共享内核同步（必须，别跳过）**：
   `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`
   —— `backend/worker/src/kaas_common/` 是 **gitignored 生成镜像**（源 38 文件，`backend/worker/.gitignore:15`），
   clone 后不跑会崩在 `ModuleNotFoundError: No module named 'kaas_common.preview'`
   （`backend/worker/src/ws_files.py:51` → `kaas_common/preview.py` 缺失；本机实测镜像少 1 文件且有 4 个文件内容过期）。
   跑完用 `-Check` 自证：三行应全「一致」。
4. 建 `.env.local`（变量名见 0.3.3；值找用户/控制台，不要提交）。**注意**：它现只是生产 DSN 存档，
   本地开发不读（`local_run.py` 用 `LOCAL_DATABASE_URL`，默认 Docker PG）。
5. 本地起环境：`docker compose up -d`；`cd backend/orchestrator && uv run --extra migrations alembic upgrade head`
   （**空库快径是正路**，不要修历史迁移链；本机实测 → **106 表 / head `202610200005`**）。
   老库若停在半初始化状态（如 `202610180010` / 93 表、缺 `market_ports` 导致 `202610190020` 迁移失败），
   先 `ALTER DATABASE kaas_dev RENAME TO kaas_dev_legacy_<日期>` 保留数据，再建空库走快径。
   起完 `docker compose up -d backend` 后 `/health` 应 200 且 `shared.loaded=true`（本机实测）。
6. 读交接：`docs/README.md` → 本文件 §0.2/§0.3 → `docs/TODO.md` → `PROBLEM_STATUS` 顶部
7. 跑门禁确认环境正常（命令与当前数字见 §0.2.4；跑前再确认一次 sync-shared）；工具链坑见 `AGENTS.md`
8. 剩余工作：本文件 §0.2.3 + `docs/TODO.md`（两者都在 `main` 上，可直接检索到）

**0.3.5 需要的账号/权限**

GitHub 仓库写权限（含 Actions secrets 可见）· Cloudflare 账号（Worker/R2/KV/Hyperdrive/Browser Rendering）·
Neon 项目权限 · Resend 账号（`send.powervoy.com` 域名）· 生产域名 DNS（`kaas.powervoy.com` / `api.kaas.powervoy.com`）。
缺权限时先只做本地开发（不触云），发布相关项（D 组）等权限齐再动。

## 0.4 生产发布记录（2026-10-21，用户下令"先发布窗口，安全项发布后做"）

> 依据：用户 2026-10-21 决策；执行人：DSH 会话。**回滚版本见下**。

| 步骤 | 结果 |
|---|---|
| 迁移前快照 | ✅ Neon snapshot `snap-late-shape-b55lavme`（name `pre-release-20261021-2045`，branch `br-raspy-snow-b5bp9zoh`） |
| DB 迁移 | ✅ 生产 `202610180010` → **`202610200005`**（6 条全部 Running：补列 → 内容版本 → 对账表 → 询盘阶段 → 事实表 → 文件唯一索引）；迁移后 **113 表**，`users 3 / customers 10 / file_objects 5` 行数不变，`uq_file_current` 已含 `NULLS NOT DISTINCT` |
| 前端构建 | ✅ `NEXT_EXPORT=1 pnpm build` → `frontend/out` **275 文件** |
| Worker 部署 | ✅ `uv run pywrangler deploy`（本机需先修 pyodide 工具链：uv **0.13.3**、`uv python install cpython-3.14.2-emscripten-wasm32-musl`、`UV_PYTHON_INSTALL_DIR` 与 venv home 对齐、`UV_CACHE_DIR=D:\tools\uv-cache`、`PYTHONUTF8=1`）；**新版本 `dae596a5-7e8c-44dc-8a7b-d3fe0c650c2f`**，上传 225 资产，三条 cron 保留 |
| 冒烟（首发） | ✅ `/health` 200 JSON（`shared.loaded=true`）、`/api/v1/auth/me` 401、`/api/v1/export-quote/products` 401、`/login` 200、`api.kaas.powervoy.com/health` 200 |`n| 二次部署（sweep 修复） | ✅ 版本 **`cd15e9a5-47e3-4758-881d-343f6e13c3b4`**（含 C23 shipments 入口恢复 / C28 渠道枚举 / C29 移除占位导入）；冒烟：`/health` 200、`/shipments` 200、`/login` 200、`/api/v1/shipments` 401 |
| 三次部署（A4 渲染直链） | ✅ 版本 **`9d497628-4ef1-47bf-ae98-4e703326bfe2`**（渲染图片/公章改短期签名直链，去 base64）；冒烟：`/health` 200、`/render-content`（无令牌）401 `RENDER_TOKEN_INVALID`、`/login` 200 |
| 四次部署（sweep 主体修复） | ✅ 版本 **`3a5ce179-7a0c-484e-9f39-b3e342dc4496`**（C19 批量导入 / C21 导出后自检 pdf.js / C25 分页 / C32 billing 入口 / C35 stage 筛选）；`out/` **277**（含 `pdf.worker.min.*.mjs`）；冒烟：`/health`、`/login`、`/billing`、`/quotes`、pdf worker 资产均 200，`/render-content` 无令牌 401；e2e 28（24+4） |
| 五次部署（C33/C39） | ✅ 版本 **`3d324441-a6dc-41fc-bf6b-34901fca3ab5`**（audit-log 筛选参数生效 + 手工录入错误提示 + 3 条 e2e skip 修复）；冒烟：`/health`/`/login`/`/quotes`/`/billing`/`/audit-log` 均 200，`/admin/audit-log` 无令牌 401、`/render-content` 无令牌 401；e2e **27 passed + 1 skipped = 28** |
| 十一次部署（C36 下期 12 UI / A10 P2 / C27b） | ✅ 版本 **`e5092262-d595-426f-ad22-4915fa022eaf`**：C36 下期 12 条全部接 UI（订单收款计划/状态流转/汇率历史/应收台账/AI 运行/情报导入/线索/品名对照/调研）；A10 P2 三类证书模板（DOC_TYPE 23 类、金标 28）；C27b 加固写端点限团队管理员/internal；门禁 worker 1558+12skip / 前端 926（108 files）/ e2e 27 / out 286；冒烟 `/health`、`/receivables`、`/orders`、`/market`、`/research`、`/intel`、`/settings/ai-providers` 均 200，`/receivables`、`/clause-templates` 无令牌 401，login 401（DB 通） |
| 十次部署（A8 归档修复） | ✅ 版本 **`711acb5f-53ac-4fd9-972e-cb8f6415d1b2`**（events_archive_log id 默认修复 + worker 显式 uuid；迁移 `202610210001`；A8 归档实测 archived=7、DB 1 行、R2 326B；DIAG_TOKEN 与临时诊断端点已删除）；冒烟 `/health` 200、login 401（DB 通）、旧诊断端点 404 |
| 九次部署（A10/C27/A5-W2） | ✅ 版本 **`2fad8cb9-dd45-4226-9749-ef4a52e62dd5`**（A10 受益人声明+SASO/COC 模板/后端 DOC_TYPE 20 类；C27 四类越权闸门修复 + R-1 PATCH；A5-W2 items_override 前后端；C36 五条 UI；worker 1523+12skip / 前端 809（87 files）/ e2e 27 / out 277）；冒烟：`/health`、`/trade-docs`、`/settings/ai-providers`、`/settings/tax-archives`、`/pricing-data`、`/team`、`/leadgen` 均 200，`/clause-templates` 无令牌 401，login 401（DB 通） |
| 八次部署（A6 P1/A14/A5-W3/重置邮件 UI/密钥轮换） | ✅ 版本 **`5295d362-b6ba-48b4-b8a1-de3235f95658`**（合同双语 12 条/G7 CI 银行块/G8 引用链/G9 税号/G10 双栏/G12 P2；A14 packing facts；A5-W3 金额摘要条；重置邮件新版 UI；Neon 口令+JWT 已轮换，Hyperdrive/GH/本地同步；worker 版本 `7ae1ea79`→`5295d362`）；构建 out/277；冒烟：`/health` 200、`/trade-docs`/`/settings/company-profile`/`/quotations/v2-quote` 200、`/clause-templates` 无令牌 401、login 401（DB 通）；e2e **27=27+0** |
| 七次部署（A5-W1/A6-1 + R2/Resend 密钥） | ✅ 版本 **`69765ef6-4bd1-4c87-99ad-b886b359ff90`**（条款模板库上线 / PI·CI 双币种金额块 / 合同双语条款数据层；生产迁移 `202610200006` 已应用；S3 新 32 位密钥已绑定并真回环验证；Resend 发送 key 已绑定）；冒烟 `/health`、`/dashboard`、`/trade-docs`、`/settings/company-profile`、`/quotes` 200，`/clause-templates`、`/admin/archive-logs` 无令牌 401 |
| 六次部署（A12/A13/C26/C30/C31/C36） | ✅ 版本 **`569a8b88-d5f9-4cd6-9719-e9aaf3e595fd`**（trigger_expr 求值/A13 中译英/C30 归档页/C26 a11y/C31 仪表盘占位/C33 events 修复/C36 API 清单）；`out/` **276**；冒烟：`/health`、`/dashboard`、`/quotes`、`/trade-docs`、`/billing` 200，`/admin/archive-logs`、`/render-content` 无令牌 401；e2e **27 passed + 0 skipped** |
| **回滚** | `cd backend/worker; npx wrangler versions deploy 77901aa1-5794-4013-bfad-3b0a80b8a57b@100% --name kaas --yes`（库回滚走 Neon PITR/快照，**不要** alembic downgrade base） |
| ⚠️ 冷启动 | `pywrangler` 报 **Worker Startup Time 3386ms** > 验收线 **2,950ms**（该数字≠Dashboard p50）；`backend/worker/coldstart-baseline.json` 仍 **PENDING**，需发布后在 Dashboard → Workers → kaas → Metrics 读 p50 判定，并决定是否裁剪包体（本次上传 11.9 MiB） |
| 待用户动作 | **D1 ✅ 2026-10-21 已完成**（`RESEND_API_KEY` 已 `wrangler secret put`，secret list 5 项；key 权限=仅发送，`/domains` 401 属预期）⇒ 忘记密码邮件恢复；**D2** R2 新 32 位密钥仍待创建（现 `S3_ACCESS_KEY` 13 位，直传走兜底）；**D4** 生产测试数据清理执行当次确认 |
| 未做 | D5 转 private（用户 2026-10-21 决定保持 public）；P4 观察期进行中 |
| 密钥托管（2026-10-21 最终） | **铁律**：凡 `DSH-Admin` 命名密钥**仅供 DSH（AI）使用**，不得配置到平台/CI/其他单位；**一个密钥只用于一处**，按命名区分。**DSH 专用**：CF/Neon/Resend/GitHub 的 `DSH-Admin`（存 `~/.dsh/secrets/` + 用户级 env，不入仓；R2 派生 S3 凭据只供我本地测试）。**系统专用**：`kaas-r2-system-20261021`（worker R2 S3，仅 kaas-files 对象读写）、`kaas-ci-system-20261021`（GH secret `CLOUDFLARE_API_TOKEN`，deploy/preview 用；Workers Editor+KV Write）、`kaas-preview-storage-rw`（预览 S3）、`kaas-prod-system-20261021`（生产 Resend 发送 key → worker `RESEND_API_KEY` + GH `RESEND_API_KEY_PROD`，deploy.yml 每次部署自动同步）、`kaas-预览`（预览 Resend）、Neon `kaas`（GitHub/CI/preview 自动化）、`neon-cli-mcp-*`（保留）。**已清理**：CF 旧 `kaas R2 Account Token` 吊销、Resend 旧 `kaas-生产` 删除。**预览环境**（R2 `kaas-preview-storage`+KV `KAAS_PREVIEW`+token+Resend `kaas-预览`）属设计内，勿删。**纪律**：破坏性操作（删数据/删桶/吊销/轮换）执行前先确认 |

## 0.1 本轮后端交付（2026-10-20 晚 · 分支 `feat/trade-doc-content-a` · PR #5）

用户点名的**后端 5 项 + 单证内容专项**已全部落地。PR #5 `mergeable_state=clean`，
四条 workflow（backend:test / contracts:check / Frontend CI / preview）在合并后 head 全绿：
预览 `https://kaas-preview-pr-5.dspro0124.workers.dev`。

| 项 | 落地要点 |
|---|---|
| **F1 服务端签发自动上传** | `confirm` / `PATCH` 可携带预览同一份 HTML → 服务端唯一实现 `ws_files.archive_rendered_pdf` 出 PDF 并落 `render_pdf` 新版本；**失败不回滚签发**（响应 `pdf_archive{ok:false}`，界面提示手动上传）；前端签发已接线 |
| **F2 单证内容版本** | 迁移 `202610200001`；五条写路径全部留版；列表/详情/恢复三端点 + 前端「内容版本」面板 |
| **F3 个人信息编辑** | `PATCH /auth/me`（显示名，只改本人；邮箱登录标识不自助改）+ `POST /auth/change-password`（验旧密码、≥8 位）；侧栏弹窗可编辑；MSW 真改显示名 |
| **F4 询盘状态机** | 迁移 `202610200003`：`stage/stage_updated_at` + `inquiry_stage_log`；事件驱动（报价/订单/出运/关闭）、只前进幂等、`closed` 终态；`GET /inquiries/{id}/stage-log` |
| **F5 报价/订单 1:N** | 口径 A（用户拍板）：保留 1:N；新建订单校验币种一致 + 未取消订单金额累计 ≤ 报价合计（422 明细） |
| **A1/A3/A8/A9** | 内容版本 / 字段体检 / 指纹对账 cron（每日 UTC 17:40）+ 列表「已变更」标识；**顺手修线上 bug**：`GET /trade-docs` 列表因 `_row_to_dict` 参数错必 500 |

- 迁移 head：**`202610200005`**（新增结构，幂等；2026-10-21 追加事实表与文件唯一索引）。
- 门禁（**2026-10-21 收口实测**）：worker **1233 passed + 12 skipped**（12 条 db/integration 档按约定 skip；有 docker PG 时全跑，总数 1245）/
  orchestrator **247** / frontend vitest **616（60 files）** ·
  typecheck 0 · lint 0 error / contracts R0–R6 / `mocks:check` 未覆盖 0 / `ui:contrast` 通过 /
  schema-coverage、drift、runtime-deps、sync-shared PASS。
- 配置：两把 Resend key 已持久化到 GitHub repo secrets（`RESEND_API_KEY_PROD` / `RESEND_API_KEY_PREVIEW`），
  换设备不失；生产 key 待**发布窗口**浇入 Cloudflare Worker secret（D1）。
- 合并纪律：与并行 UI 线的冲突（README / PROBLEM_STATUS / `trade-docs/page.tsx`）已解决 ——
  采用 UI 线新版页面布局后，重新接回 F1/A1/A3/A8/A9 的前端改动。
- 剩余（`docs/TODO.md`）：A2-B 方案 B（需用户定）、A5 编辑体验（需方案确认）、A6 真单据对照（需用户样例）、
  C21 导出自检 UI（PDF 文本抽取）；A4/A7 与 B1–B3 已于 2026-10-21 收口；D 组发布窗口项中 D1/D2/D4 待用户动作，发布已执行（§0.4）。

## 1. 本轮完成（按时间，均有 commit/实测证据）

| # | 事项 | 证据 |
|---|---|---|
| 1 | 本地 main 同步 + 残留分支清理（`docs/plan-b-handoff`、`feat/plan-b-single-worker`） | 本地 worktree/分支清单 |
| 2 | 环境补齐：Docker（WSL 修复后可用）、pnpm 12.14.0、gh 2.102.0 + 登录 dsun-io | 容器 healthy；`gh auth status` |
| 3 | 本地开发库建成：alembic head `202610190020`、102 表 | `alembic current` |
| 4 | 全量门禁验收（本机）：orchestrator 247 / worker 960+5 / 静态断言 5 项 / 前端 7 项 | 2026-10-20 实测 |
| 5 | main CI 恢复且全绿（backend:test / Frontend CI / contracts:check） | run `39364936582` 等；修了 2 个"从未真跑"的 CI 债（脚本路径 `555cc15`、`psql -vc` `91b010c`） |
| 6 | **S5 预览环境落地**（脚本/workflow/前缀规则/防污染断言） | `18ae386`（构建由 preview-builder 完成，lead 评审合并） |
| 7 | **预览链修复三 bug**：GitHub 丢弃含密码 job output（→`db-url.py`）；预览选错库（→跟生产同库名 neondb，仍是独立分支）；预览 Hyperdrive 缓存（→`caching.disabled=True`） | 见 §4 证据；`579533d` 等 |
| 8 | **审批门禁解除**：`preview.yml` 重写（secrets 逐项注入、去 `toJSON(secrets)`、写权限下沉） | dispatch 全绿 `39375956315` / `39377320026` |
| 9 | 云资源治理（用户授权，先备份后删）：`kaas_v2_test` 库、dev 分支 `kaas_v2_test_records` 库、`pre-deploy-20261018-2150` 分支、`kaas-ppg` Hyperdrive | 备份 CSV 于 `backend/.tools/backup-*`；Neon/CF API 删除结果 |
| 10 | **依赖钉版**：`backend/worker/pylock.toml` 入库（fastapi 0.141.1 / starlette 1.6.0 / pydantic 2.12.5 / asyncpg 0.31.0 / bcrypt 5.0.0） | `3abdcad` |
| 11 | 待办清零 + 19 份过时文档归档 + 死链清零（早前） | `29e940b`、`510cb69` |
| 12 | 演示预览可用性 + 销毁：登录 200/数据可读 → 全套 teardown 0 残留 | 见 §3 |

## 2. 三环境现状（2026-10-20 实测）

| | 开发 | 预览 | 生产 |
|---|---|---|---|
| 代码 | 本地工作树（热重载） | PR 分支代码 / dispatch 自动构建 | main |
| 数据库 | **本地 Docker PG**（`kaas_dev`，102 表） | Neon 分支 `preview-pr-<num>`（从 production copy-on-write 派生，独立 endpoint/凭证），库名与生产一致 `neondb` | Neon `production` 分支 `neondb` |
| 存储 | **本地 MinIO**（`kaas-dev`） | R2 `kaas-preview-storage`（键前缀 `pr-<num>/`）+ KV `KAAS_PREVIEW`（前缀 `pr-<num>:`） | R2 `kaas-files`（永久保留此名，改名取消） |
| Hyperdrive | —（本地直连） | `kaas-preview-<num>`（按需建删） | `neon-kaas` = `f53fed49…`（缓存保持开启） |
| Worker | uvicorn `local_run.py`（`--reload`） | `kaas-preview-pr-<num>`（workers.dev） | `kaas`（自有域名 + assets） |
| 进入方式 | `docker compose up -d` + `pnpm dev` | PR 自动 / `workflow_dispatch`（输入 pr_number） | push main 只跑 CI；**部署仅手动 dispatch** |
| 隔离证据 | 不触云 | S5-d 断言（部署前后对照**线上真实绑定**）+ R2/KV 前缀 + 独立凭证 | 同左（生产断言：R2=kaas-files / HD=f53fed49… / 无 KV / 无 PR_SLUG） |

**已删云资源（2026-10-20）**：生产分支 `kaas_v2_test`（81 表/13MB/冻结 202609300001/0 用户）、
dev 分支 `kaas_v2_test_records`（89 表/25 行）、分支 `pre-deploy-20261018-2150`、
Hyperdrive `kaas-ppg`（PPG 废弃线）。
**保留**：Neon = production / dev / （预览按需）；Hyperdrive = `neon-kaas`；R2 = kaas-files /
kaas-preview-storage；KV = `KAAS_PREVIEW`；Workers = `kaas`。
**非本项目的资源未动**（gaojin/lianjia/powervoy-web 的桶/KV/worker）。

## 3. 凭据与配置位置（不含明文）

- **本机**：`.env.local`（gitignored）：`DATABASE_URL`（Neon 生产）、`DATABASE_URL_PPG`（已废弃，可删）、
  `RESEND_API_KEY`（本地开发用）、**`RESEND_API_KEY_PROD`**（生产专用，发布窗口注入）、
  **`RESEND_API_KEY_PREVIEW`**（预览专用，已同步为 GitHub repo secret）。
  **注意：两把 Resend key 的持久位置是 GitHub repo secrets（换设备不失），本机文件只是副本；
  最终生效位置是 Cloudflare Worker secret（发布窗口浇入）。**
- **GitHub repo secrets（12 个）**：`PROD_DATABASE_URL` / `NEON_API_KEY` / `NEON_PROJECT_ID` /
  `CLOUDFLARE_API_TOKEN`（账号级，五权限）/ `CLOUDFLARE_ACCOUNT_ID` / `JWT_SECRET`、
  `ADMIN_SETUP_TOKEN`（**预览专用随机值**）/ `S3_ACCESS_KEY`、`S3_SECRET_KEY`、`S3_ENDPOINT`
  （**预览桶专用**，只够 `kaas-preview-storage`）/ **`RESEND_API_KEY_PREVIEW`**（预览专用发信 key）/
  **`RESEND_API_KEY_PROD`**（生产专用发信 key）。两只发信 key 与生产/预览一一对应、额度按账号共享、
  独立吊销；预览 worker **不得**使用生产 key。
- **GitHub repo variables（4 个）**：`KAAS_PREVIEW_KV_NAMESPACE_ID`（`c77ab8c9…`）/
  `KAAS_PREVIEW_R2_BUCKET=kaas-preview-storage` / `PROD_R2_BUCKET=kaas-files` /
  `PROD_HYPERDRIVE_ID=f53fed49…`。
- **Cloudflare Worker secrets（生产 `kaas`）**：`ADMIN_SETUP_TOKEN`/`JWT_SECRET`/`S3_ACCESS_KEY`/
  `S3_SECRET_KEY`（4 个，缺 `RESEND_API_KEY` → 发布时补）。
- 本地 wrangler OAuth 已登录 `dspro0124@163.com`；gh OAuth 已登录 `dsun-io`（scope: repo/workflow）。

## 4. 今日踩坑与结论（避免重做）

1. **GitHub 静默丢弃含密码 job output**（`Skip output ... since it may contain secret`）⇒ 跨 job 传 DSN
   必须让下游 job 自取（`db-url.py`）；GITHUB_ENV 不受此限。
2. **Neon 分支有多个库**（生产分支曾有 kaas_v2_test + neondb）⇒ 选库必须跟生产
   Hyperdrive `origin.database`，不能取 `databases[0]`。
3. **预览 Hyperdrive 缓存必须关**（`caching.disabled=True`）否则改库后 60s 读旧行（登录假 401）。
4. **`toJSON(secrets)` 整包注入疑似触发 GitHub 审批门禁**：改为逐项显式注入后 dispatch 正常
   （环境/权限/路径/事件类型均已排除；根因未 100% 定位，但已不可复现且新的写法安全更优）。
5. **本机 pywrangler 坑**：uv 的 pyodide 探针在 CJK 用户名路径下坏 ⇒ `UV_CACHE_DIR` 指 ASCII 路径；
   读含中文注释的 `wrangler.jsonc` 需 `PYTHONUTF8=1`。已写入 AGENTS.md。
6. **"预览 ~10 分钟必崩（1101/1102）"未再复现**：修复错误库/重建旧绑定后，KV 开关两种部署各稳定
   13–14 分钟（16/16 探测 200）。保留 `--no-kv` 实验开关备用。
7. **PowerShell 批量改文件曾把中文写坏**（Set-Content 默认编码）⇒ 改中文文件一律用 edit/write 工具，
   改后 `git diff` 自检。

## 5. 发布检查单（迁移自旧交接 §7；**2026-10-21 已按此执行三次部署**，后续发布沿用）

1. 迁移：`DATABASE_URL=<PROD_DATABASE_URL> uv run --extra migrations alembic upgrade head`
   → 期望 head **`202610200005`**（新增 `202610200001` 内容版本表、`202610200002` 对账表、
   `202610200003` 询盘阶段表/列、`202610200004` 单证事实表、`202610200005` 文件当前版本唯一索引（`NULLS NOT DISTINCT`）；均为**新增/重建索引**结构，幂等执行，不改既有列语义；`202610200005` 发布前先跑迁移 docstring 里的查重 SQL，有重复 current 行先人工处置）。
2. 补 secret：`cd backend/worker; npx wrangler secret put RESEND_API_KEY --name kaas`
   （值取本机 `.env.local` 的 **`RESEND_API_KEY_PROD`** —— 生产专用 key，2026-10-20 用户提供；
   本地开发继续用 `RESEND_API_KEY`，预览**不配**发信。版本管理未部署状态下普通 put 会被拦，
   须与部署同窗口或 `versions secret put`）。
   同窗口可顺带（需单独批准）：S3 新密钥替换 + `npx wrangler hyperdrive update f53fed49… --caching-disabled`。
3. 构建：`cd frontend; $env:NEXT_EXPORT="1"; pnpm build` → `out/` **275 文件**（2026-10-21 实测）。
4. 部署：`cd backend/worker; uv run pywrangler deploy`（首选；或 GitHub `deploy.yml` workflow_dispatch）。
5. 冒烟：`/health` 200（JSON+shared.loaded）、登录、客户列表、`export-quote/products`、crons 在 Dashboard 可见。
6. 冷启动基线：CF Dashboard → Workers → kaas → Metrics 读 p50 写入 `backend/worker/coldstart-baseline.json`（验收线 ≤2,950ms）。
7. 回滚：`wrangler versions deploy <上一版>`；库回滚走 Neon PITR/分支（**不要** `alembic downgrade base`）。
8. 留痕：更新 `PROBLEM_STATUS`「迁移 head / 部署版本」并 push；发布后进入 P4 观察期（1 周）。

## 6. 待办（用户触发项；**活跃待办账本 = [`docs/TODO.md`](./TODO.md)**）

| # | 事项 | 触发条件 |
|---|---|---|
| 1 | **UI/UX 优化任务收尾**（另一会话，并行线；写范围 `frontend/**` + `docs/ui-redesign/`） | ✅ 已收口（2026-10-20，P0/P1/P2 完成，见 `UI_UX_OPTIMIZATION_2026-10-20.md` §11 与 §0.1）；残留文档勾选口径已在 2026-10-21 C38 文档收尾中处理完毕 |
| 2 | **用户在预览验收** | 预览已随 PR #5 teardown（§0.2.1）⇒ 改为「发布后在生产/新预览验收」，并入第 3/4 项 |
| 3 | **生产发布**（按 §5 检查单） | ✅ **2026-10-21 已执行**：迁移 `202610180010`→`202610200005` + Worker 三次部署（`dae596a5`→`cd15e9a5`→`9d497628`），冒烟通过（§0.4） |
| 4 | 发布后 P4 观察期（冷启动/5xx/延迟，1 周） | **进行中**（自 2026-10-21 起，至 2026-10-28；冷启动 p50 待在 Dashboard 读） |
| 5 | 仓库转回 private（**实测当前 public**；用户自转） | 用户决定，**仍未完成**（2026-10-20 审计复核） |

**口径修订（2026-10-20 晚，用户裁决；2026-10-21 状态更新）**：原「触发条件制（不活跃跟踪，到点自动执行）」的
U-B1/U-B5 发布窗口项、Hyperdrive 缓存关闭、生产测试数据清理（执行当次需用户确认）、批次 7
（I-1~I-7）**已全部恢复为活跃待办**，统一登记在 [`docs/TODO.md`](./TODO.md)。
其中**生产发布已于 2026-10-21 执行**（§0.4）；单证内容专项 A4/A7 与产品配置化 B1–B3 已于 2026-10-21 收口
（A5/A6 需用户方案/样例，仍是活跃待办）。Neon Protected 维持「付费不升级、删分支双保险
校验替代」（U-S5，现行锚点 = **根 `README.md` §2 三环境矩阵**；旧文写的「README §2.2」已不存在）。

## 7. 交接提醒（给下一个会话）

- **并行写纪律（2026-10-20 审计复核：原「未提交改动已扩大到后端」警告已过期）**：当时列出的
  `backend/kaas_common/workstation/customer_records.py`、`backend/worker/src/ws_customer_records.py` 已随
  `a299ea60` 提交，`frontend/**` 相关改动已合入，`docs/ui-redesign/phase1/` 不存在；交接时 `git status`
  除未跟踪 `.tmp/` 外干净。**通用纪律仍然有效**：只提交自己写范围、不要 `git add -A`、`kaas_common`
  改动必须跑 `scripts/sync-shared.ps1`。
- **分支收尾（2026-10-20 已完成）**：`archive/convergence-aprime-20261019` tag 已建、远端
  `feat/convergence-aprime` 已删；本地 `feat/trade-doc-templates`、`tech-stack-next16` 已删；
  远端 `feat/trade-doc-content-a` 已删；本地仅剩 `main`（`git branch` 实测）。POC 目录清理仍挂 TODO F7。
- **预览触发**：PR 打开/推送 → 自动部署并评论 URL；PR 关闭 → 自动 teardown；手动演示用
  `gh workflow run preview.yml -f pr_number=<伪号>`（可加 `-f no_kv=true` 实验）。
- **发布**：push main **不会**自动部署（`deploy.yml` 仅 workflow_dispatch）。
- **分支保护已配置**（用户 2026-10-20）：限制删除 + 合并需 PR；之后所有改动走 PR。
- 门禁、迁移、回滚口径见 README §14/§15（唯一权威）。

## 8. 遗留物与本地环境清单（交接时状态）

| 项 | 状态 | 处理建议 |
|---|---|---|
| 分支 `feat/convergence-aprime` | **✅ 已处置（2026-10-20 收尾，实测）**：tag `archive/convergence-aprime-20261019` 已建、**保留**；远端分支已删（`git ls-remote` 现仅 `main`），本地 worktree/分支均不存在。理由：合并会让生产连已删的 Hyperdrive `kaas-ppg` | 保持现状，勿合并 |
| 本地分支 `feat/trade-doc-templates`、`tech-stack-next16` | **✅ 已删除**（2026-10-20 收尾；`git branch` 现仅 `main`） | 无需处理 |
| 远端分支 `feat/trade-doc-content-a` | **✅ 已删除**（已并入 `main` 的历史分支） | 无需处理 |
| 分支 `feature/intel-workstation-v1` | 远端已删（gone），本地保留 | 同上 |
| `backend/worker/poc-baseline/`、`poc-sqlalchemy/` | POC 遗留目录（含旧 pylock，未跟踪） | 可清理；**仍挂 TODO F7（POC 目录部分 ⏳）** |
| `backend/.tools/`（脚本 + 删除前备份 CSV） | gitignored；**备份目录** `backup-kaas-v2-test-20261020/`（13 CSV）、`backup-kaas-v2-test-records-20261020/`（7 CSV） | 留作回查；确认无需后可删 |
| 本机 Docker 容器 | `kaas-postgres` / `kaas-redis` / `kaas-minio` 运行中（开发环境） | `docker compose stop` 可停 |
| `.env.local` | 含 Neon 生产 DSN、`DATABASE_URL_PPG`（**已废弃**，可删）、`RESEND_API_KEY` | 勿提交（已 gitignored） |
| 本地 `/health` 开发入口 | 未常驻启动（按需 `docker compose up -d` / `local_run.py`） | — |

## 9. 自检

- [x] 代码/脚本/workflow 全部提交推送（main = 见 `git log`）
- [x] 三环境隔离实测（生产断言 PASS；预览前缀/派生；开发本地）
- [x] 云资源清单核对（保留/删除均有记录；非本项目资源未动）
- [x] 预览链 dispatch 部署 + PR 关闭 teardown 均实测通过
- [x] 依赖钉版入库；工具链坑落盘 AGENTS.md
- [ ] 生产发布（等用户指令）
