# 交接文档 · 2026-10-20 最终版（S5 预览交付 + 云资源治理 + 发布待命）

> **本文是当前主交接文档**。历史口径见 `PROBLEM_STATUS_2026-10-11.md`（滚动状态）与
> `README.md`（架构/环境矩阵/门禁唯一权威）。本文日期区间：**2026-10-20 全天**。

## 0. 一句话状态

**S5 预览环境已全量交付并在 CI 端到端验证通过**（自动建库/部署/评论/回收，无需人工批准）；
**生产与预览、开发三环境隔离核验到位**；本轮清理了 2 个废弃库 + 1 个废弃 Neon 分支 + 1 个 PPG
Hyperdrive，并给 worker 依赖钉版入库。**前端 UI 优化 P0/P1/P2 已于 2026-10-20 下午全部收口**
（详见 `UI_UX_OPTIMIZATION_2026-10-20.md` §11）；**待办账本 = [`docs/TODO.md`](./TODO.md)**（2026-10-20 晚
口径修订：原「触发条件制」项全部恢复为活跃待办——单证内容专项 / 产品配置化 / 原 I-1~I-7 /
发布窗口项，由用户排期执行）。**后端 5 项已完成**（见 §0.1；`UI_BACKEND_DEPENDENCIES_2026-10-20.md` 转为验收基线）。
**开发已于 2026-10-20 晚按用户指令停止**，停止点与剩余工作见 **§0.2**。

## 0.2 停止点交接：当前状态与剩余工作（**交接 agent 必读**）

### 0.2.1 停止点（2026-10-20 晚）

- **用户指令**：停止继续开发；把现状与剩余工作写进交接文档；归档过时文档；推送远程。
- **代码位置**：分支 `feat/trade-doc-content-a`（独立 worktree
  `D:\projects\kaas-platform\.agents\worktrees\feat\trade-doc-content-a`；主工作树是并行 UI 线在用，**未改动**）。
- **PR [#5](https://github.com/dsun-io/kaas-platform/pull/5)**：`mergeable_state=clean`，
  head = 本提交（含与 `origin/main` 的合并）；四条 workflow（backend:test / contracts:check /
  Frontend CI / preview）在上一代码 head `743bce5` 全绿；纯文档提交后以 **`743bce5` 为代码门禁证据**。
- **预览**：`https://kaas-preview-pr-5.dspro0124.workers.dev`（PR 关闭自动回收）。
- **仓库可见性**：用户口径 = CI 跑绿后转回 **private**（转回后 GitHub Actions 会再次不可用，
  门禁以本地命令为准；本地各门全绿数字见 §0.1）。
- **未合并即是当前状态**：PR 未合入 `main`；合并动作由用户决定（合并后生产部署仍需手动 dispatch，`deploy.yml` 仅 `workflow_dispatch`）。

### 0.2.2 已完成（本分支 + 已合入 main 的 UI 线）

- 用户点名的**后端 5 项**：F1 签发自动上传、F2 内容版本、F3 个人信息、F4 询盘状态机、F5 报价/订单 1:N —— 全部 ✅（细节/证据见 §0.1）。
- 单证内容专项 A 组：A1（内容版本）、A3（字段体检）、A8/A9（指纹对账 cron + 列表标识）✅；
  顺手修线上 `GET /trade-docs` 500。
- 迁移 head：`202610200003`（三条新增迁移，幂等；生产尚未应用，发布窗口一并上）。
- 配置：两把 Resend key 已入 GitHub repo secrets（`RESEND_API_KEY_PROD` / `RESEND_API_KEY_PREVIEW`），换设备不失；
  生产 key 待发布窗口注入 Cloudflare（`docs/TODO.md` D1）。

### 0.2.3 剩余工作（全部登记在 [`docs/TODO.md`](./TODO.md)，按建议顺序）

| 组 | 项 | 前置 / 备注 |
|---|---|---|
| A4 | 单证图片素材库（公章/产品图走对象存储 + 可复用素材库） | 与发布窗口 R2 新密钥同批更顺；现状 base64 内联（一张 PI ≈1.4MB） |
| A5 | 单证编辑体验（行项批量编辑、条款模板、金额联动校验） | **需先与用户过方案**（🧭） |
| A6 | 模板逐字段对照真实出口单据 | **需用户提供样例单据**（🧭），是单证内容的最终验收标准 |
| A7 | 单证加固 P1/P2（事实层/一致性引擎/收款容差/回执登记/导出自检） | 口径已拍板（`UNCERTAIN.md` #17），设计在归档的 `TRADE_DOC_HARDENING_PLAN_2026-10-12.md`，可直接施工 |
| A8-① | PDF 归档「端到端真实跑一次」 | 需已部署环境（Browser Rendering 依赖生产 binding），归发布后 P4 |
| A9-补充 | preview ensure 对 Neon 423 短重试（TODO D7） | 低优先；本次靠 rerun 通过 |
| B1 | 租户级产品定义配置化（运行时新增产品，现状要写 Python + 重启） | 无前置 |
| B2 | 产品可视化编辑器收尾（运行时生效链路） | 依赖 B1 |
| B3 | 租户开通报价工位 UI 交互 | 无前置 |
| C1 | 「流失」拒绝文件链路（订单新增 `lost`） | 🧭 需业务设计 + 用户拍板 |
| C2 | 文件存储收尾 3 项（真实 DB 用例 / 公章 PI 视觉 QA / 排序过滤测试） | 发布后验证更完整 |
| C3 | Cloudflare agent 接入 | 🧭 价值未明，待用户排优先级 |
| C4 | 30/90 天客户自动沉寂 | 🧭 用户曾裁「先手动」，要做需重新设计 |
| C5 | 本地 mock 刷新丢数据（MSW 限制） | 开发体验项 |
| C6 | e2e 数据层不稳根治 | 历史 e2e 假红根因治理 |
| D1–D6 | 发布窗口项（RESEND 注入 / R2 新密钥 / Hyperdrive 缓存 / 生产测试数据清理 / 仓库转 private / 发布检查单 §5） | **等用户下令发布**；D3/D4 执行前需弹窗确认 |

### 0.2.4 恢复工作的最短路径

1. 进入 worktree：`cd D:\projects\kaas-platform\.agents\worktrees\feat\trade-doc-content-a`
   （或在主工作树 `git worktree list` 找回；分支 `feat/trade-doc-content-a`）。
2. 先读：`docs/README.md`（检索入口）→ 本文件 §0.2 → `TODO.md` → `PROBLEM_STATUS` 顶部。
3. 改完代码同步文档（`PROBLEM_STATUS` 顶部 + `TODO.md` 销账），推送分支；PR #5 自动更新。
4. 门禁命令（本机实测可用，注意 AGENTS.md 的工具链坑）：
   - worker：`cd backend/worker; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q`（现 **1008+5**）
   - orchestrator：`cd backend/orchestrator; uv run --extra migrations pytest tests -q`（现 **247**）
   - 前端：`pnpm typecheck` / `pnpm lint` / `pnpm test`（现 **474**）/ `pnpm contracts:check`；构建与 e2e **不要同时跑**（共用 `.next`）
   - 静态：`scripts/check-runtime-deps.py`、`check-schema-coverage.py`、`check-schema-drift.py`、`scripts/sync-shared.ps1 -Check`
5. 改 `backend/kaas_common/**` 后必须 `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1`（否则 worker 镜像是旧的）。

### 0.2.5 本轮文档整理

- 新归档批：[`docs/archive/2026-10-20-backend-closeout/`](./archive/2026-10-20-backend-closeout/README.md)
  （`ENV_VERIFICATION_2026-10-19.md`：迁移 head/预览状态已过时，当前看根 README §2 + 本文件 §2/§3/§5）。
- `E2E_GUIDE.md` 已就地更新到 2026-10-20 口径（27 条：23 passed + 4 skipped、`pnpm dev`）。
- **前端线文档一律未动**：`UI_UX_OPTIMIZATION_2026-10-20.md`、`UI_BACKEND_DEPENDENCIES_2026-10-20.md`、
  `docs/ui-redesign/**`。
- 检索入口仍是 [`docs/README.md`](./README.md)（已同步状态与归档批次）。

### 0.3 新设备 / 新 agent 接手清单（**设备无关**，换机也能完整接手）

> 前提：PR #5 已合并到 `main` ⇒ 新设备 `git clone` 即拥有**代码 + 全部交接文档**。

**0.3.1 仓库与文档在哪**

- 仓库：`https://github.com/dsun-io/kaas-platform`；交接文档全在 `docs/`，检索入口 `docs/README.md`。
- 分支 `feat/trade-doc-content-a` 可能仍保留（历史分支）；**合并后以 `main` 为准**，无需切分支。

**0.3.2 本机有、Git 里没有（换设备会缺，必须重建）**

| 本机东西 | 为什么不入库 | 新设备怎么办 |
|---|---|---|
| `.env.local` | **含密钥**，`.gitignore` 明确忽略 | 新建该文件，按下表变量名填值；值从 GitHub repo secrets / Neon / Resend / 用户处取 |
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
- `.env.local` 需要的变量名（**只写名，不写值**）：`DATABASE_URL`（Neon 生产只读/读写 DSN）、
  `RESEND_API_KEY`（本地开发用）、`RESEND_API_KEY_PROD`、`RESEND_API_KEY_PREVIEW`；旧字段
  `DATABASE_URL_PPG` 已废弃可删。

**0.3.4 新设备首次接手步骤**

1. `git clone https://github.com/dsun-io/kaas-platform && cd kaas-platform`
2. 装依赖：`cd frontend && pnpm install`；`cd backend/worker && uv sync`；`cd backend/orchestrator && uv sync --extra migrations`
3. 建 `.env.local`（变量名见 0.3.3；值找用户/控制台，不要提交）
4. 本地起环境：`docker compose up -d`；`cd backend/orchestrator && uv run --extra migrations alembic upgrade head`（空库快径）
5. 读交接：`docs/README.md` → 本文件 §0.2/§0.3 → `docs/TODO.md` → `PROBLEM_STATUS` 顶部
6. 跑门禁确认环境正常（命令与当前数字见 §0.2.4）；工具链坑见 `AGENTS.md`
7. 剩余工作：本文件 §0.2.3 + `docs/TODO.md`（两者都在 `main` 上，可直接检索到）

**0.3.5 需要的账号/权限**

GitHub 仓库写权限（含 Actions secrets 可见）· Cloudflare 账号（Worker/R2/KV/Hyperdrive/Browser Rendering）·
Neon 项目权限 · Resend 账号（`send.powervoy.com` 域名）· 生产域名 DNS（`kaas.powervoy.com` / `api.kaas.powervoy.com`）。
缺权限时先只做本地开发（不触云），发布相关项（D 组）等权限齐再动。

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

- 迁移 head：**`202610200003`**（新增结构，幂等）。
- 门禁：worker **1008 passed + 5 skipped** / orchestrator **247** / frontend vitest **474** ·
  typecheck 0 · lint 0 error / contracts R0–R6 / schema-coverage、drift、runtime-deps、sync-shared PASS。
- 配置：两把 Resend key 已持久化到 GitHub repo secrets（`RESEND_API_KEY_PROD` / `RESEND_API_KEY_PREVIEW`），
  换设备不失；生产 key 待**发布窗口**浇入 Cloudflare Worker secret（D1）。
- 合并纪律：与并行 UI 线的冲突（README / PROBLEM_STATUS / `trade-docs/page.tsx`）已解决 ——
  采用 UI 线新版页面布局后，重新接回 F1/A1/A3/A8/A9 的前端改动。
- 剩余（`docs/TODO.md`）：A4 图片素材库、A5 编辑体验（需方案确认）、A6 真单据对照（需用户样例）、
  A7 单证加固 P1/P2、B1–B3 产品配置化、C1–C6；D 组发布窗口项待用户下令。

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

## 5. 发布检查单（迁移自旧交接 §7，**待用户下令**）

1. 迁移：`DATABASE_URL=<PROD_DATABASE_URL> uv run --extra migrations alembic upgrade head`
   → 期望 head **`202610200003`**（本分支新增 `202610200001` 内容版本表、`202610200002` 对账表、
   `202610200003` 询盘阶段表/列；均为**新增**结构，幂等执行，不改既有列语义）。
2. 补 secret：`cd backend/worker; npx wrangler secret put RESEND_API_KEY --name kaas`
   （值取本机 `.env.local` 的 **`RESEND_API_KEY_PROD`** —— 生产专用 key，2026-10-20 用户提供；
   本地开发继续用 `RESEND_API_KEY`，预览**不配**发信。版本管理未部署状态下普通 put 会被拦，
   须与部署同窗口或 `versions secret put`）。
   同窗口可顺带（需单独批准）：S3 新密钥替换 + `npx wrangler hyperdrive update f53fed49… --caching-disabled`。
3. 构建：`cd frontend; $env:NEXT_EXPORT="1"; pnpm build` → `out/` 267 文件。
4. 部署：`cd backend/worker; npx pywrangler deploy`（或 GitHub `deploy.yml` workflow_dispatch）。
5. 冒烟：`/health` 200（JSON+shared.loaded）、登录、客户列表、`export-quote/products`、crons 在 Dashboard 可见。
6. 冷启动基线：CF Dashboard → Workers → kaas → Metrics 读 p50 写入 `backend/worker/coldstart-baseline.json`（验收线 ≤2,950ms）。
7. 回滚：`wrangler versions deploy <上一版>`；库回滚走 Neon PITR/分支（**不要** `alembic downgrade base`）。
8. 留痕：更新 `PROBLEM_STATUS`「迁移 head / 部署版本」并 push；发布后进入 P4 观察期（1 周）。

## 6. 待办（用户触发项；**活跃待办账本 = [`docs/TODO.md`](./TODO.md)**）

| # | 事项 | 触发条件 |
|---|---|---|
| 1 | **UI/UX 优化任务收尾**（另一会话，并行线；写范围 `frontend/**` + `docs/ui-redesign/`） | 用户/该线完成 |
| 2 | **用户在预览验收**（UI 任务产出 → PR → 预览自动部署 → 用户点验） | UI 收尾后 |
| 3 | **生产发布**（按 §5 检查单） | 用户下令 |
| 4 | 发布后 P4 观察期（冷启动/5xx/延迟，1 周） | 发布后 |
| 5 | 仓库转回 private（当前 public；用户自转） | 用户决定 |

**口径修订（2026-10-20 晚，用户裁决）**：原「触发条件制（不活跃跟踪，到点自动执行）」的
U-B1/U-B5 发布窗口项、Hyperdrive 缓存关闭、生产测试数据清理（执行当次需用户确认）、批次 7
（I-1~I-7）**已全部恢复为活跃待办**，统一登记在 [`docs/TODO.md`](./TODO.md)（另含单证内容专项
A1–A9、产品配置化 B1–B3），由用户排期执行。Neon Protected 维持「付费不升级、删分支双保险
校验替代」（U-S5，README §2.2）。

## 7. 交接提醒（给下一个会话）

- **并行写纪律**：本工作区同时有 UI 任务在写；**截至 2026-10-20 22:1x 其未提交改动已扩大到后端**：
  `backend/kaas_common/workstation/customer_records.py`、`backend/worker/src/ws_customer_records.py`
  （另含 `frontend/**` 多处 + 未跟踪 `docs/ui-redesign/phase1/`）。**不要提交别人的这些改动**；
  其中 `kaas_common` 改动**必须跑 `scripts/sync-shared.ps1`** 才会进 worker 镜像——由该线自己负责。
- **预览触发**：PR 打开/推送 → 自动部署并评论 URL；PR 关闭 → 自动 teardown；手动演示用
  `gh workflow run preview.yml -f pr_number=<伪号>`（可加 `-f no_kv=true` 实验）。
- **发布**：push main **不会**自动部署（`deploy.yml` 仅 workflow_dispatch）。
- **分支保护已配置**（用户 2026-10-20）：限制删除 + 合并需 PR；之后所有改动走 PR。
- 门禁、迁移、回滚口径见 README §14/§15（唯一权威）。

## 8. 遗留物与本地环境清单（交接时状态）

| 项 | 状态 | 处理建议 |
|---|---|---|
| 分支 `feat/convergence-aprime`（本地 worktree `.agents/worktrees/feat/convergence-aprime`） | **保留**（决策 1：其 PPG 改动不得合并；可用部分已由 `88132af` 收编） | 历史存档，勿合并；确认无用后可删 |
| 分支 `feature/intel-workstation-v1` | 远端已删（gone），本地保留 | 同上 |
| `backend/worker/poc-baseline/`、`poc-sqlalchemy/` | POC 遗留目录（含旧 pylock，未跟踪） | 可清理；未动以免影响并行线 |
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
