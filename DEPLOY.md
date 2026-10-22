# KaaS Platform 部署指南

> 📌 **口径对齐（2026-10-19 · 决策 1 已确认）**：本文的 **Neon 口径正确**
> （放弃 PPg 后生产库回 Neon，与 main 生产实配一致：Hyperdrive config `f53fed49705043008737032e4bfa2b8e`
> 指向 Neon 生产分支）。
> 三环境隔离矩阵、硬规则、部署防污染断言见 **[README.md](README.md)（主交接文档）§2**。
>
> **【历史，勿再执行】Neon 根分支改名段（2026-09/10 旧计划）**：原计划把根分支 `production`
> 改名为受保护 Root 分支 `main`；**该改名未执行，且已被 U-S5 裁决取代**
> （Neon Protected 是付费功能、Free 套餐不可用 ⇒ 用户裁决不升级，改用「预览脚本删分支双保险」，
> 见 `docs/PROBLEM_STATUS_2026-10-11.md` U-S5 与根 README §2）。**现行命名以根 README §2 矩阵为准**，
> 本文执行时不再改名。
>
> 🚫 **发布纪律（2026-10-20 用户裁决，仍有效）**：`deploy.yml` **仅 `workflow_dispatch`**（不再随 push
> 自动部署），且 GitHub Actions 额度/权限不稳 ⇒ **最终发布优先走本机 `pywrangler deploy`**。
> 未收到用户明确部署指令**不发布**。
>
> 🧹 **CI 瘦身（2026-10-22）**：已把 e2e（push 时）、真 PG 集成（push 时）、PR 预览（改为 `preview` label 触发）
> 移出高频路径，并加 `concurrency` 取消过期 run；**门禁未删**。同日仓库已转 **public** ⇒ GitHub-hosted 标准 runner
> 免费无限（瘦身保留用于减冗余/提速；若以后转回 private 需重新看 2,000 分钟/月额度）。
> 实测与回滚方法见 [`docs/CI_OPTIMIZATION_2026-10-22.md`](docs/CI_OPTIMIZATION_2026-10-22.md)。
>
> ✅ **2026-10-21 生产发布已完成（§0.4 记录）**：迁移 生产 `202610180010` → **`202610200005`**（6 条），
> Worker 三次部署（`dae596a5` → `cd15e9a5` → `9d497628`），冒烟通过；**回滚版本见
> [docs/HANDOVER_2026-10-20_FINAL.md](docs/HANDOVER_2026-10-20_FINAL.md) §0.4**。
> 后续发布沿用本文 §1/§3/§4 与 HANDOVER §5 检查单，按「发布预案」逐次执行。
>
> ✅ **2026-10-20 口径更新（方案 B S4 + 技术栈升级后）**：
> - **单应用**：运行时唯一实现 = `backend/worker/src/main.py`；orchestrator 只剩 `app/db` + `alembic`（不可运行后端）。
>   `docker compose` 的 `backend` 服务跑 `worker/local_run.py`，**不再自动执行迁移**（需手动 `alembic upgrade head`）。
> - **迁移 head = `202610200005`**（自 `202610180010` 共 6 条：`202610190020` 幂等补列 / `202610200001` 内容版本 /
>   `002` 对账表 / `003` 询盘阶段 / `004` 单证事实表 / `005` 文件当前版本唯一索引 `NULLS NOT DISTINCT`）。
>   **2026-10-21 已在生产应用**（`202610180010` → `202610200005`）；以 `alembic heads` 为准。
>   migrate job 依赖 secret `PROD_DATABASE_URL`；当前未配置则告警跳过（手动迁移）。
> - **前端 = Next 16.4.2**：`NEXT_EXPORT=1 pnpm build` → `frontend/out`；**不要再设 `NEXT_DIST_DIR`**（会改导出落点）。
> - 完整交接与发布前检查单见 [docs/HANDOVER_2026-10-20_FINAL.md](docs/HANDOVER_2026-10-20_FINAL.md)
>   （§0.2 停止点与剩余工作、§0.4 生产发布记录、§2/§3 三环境、§5 发布检查单）。

## 架构

```
浏览器 ──> Cloudflare Worker "kaas" (单 Worker · Python FastAPI + 静态资产)
              ├─ kaas.powervoy.com      → 前端页面 + /api/v1/*（同源，无 CORS）
              ├─ api.kaas.powervoy.com  → 仅 API（历史域名，保留兼容）
              │
              │  /api/*  → FastAPI（asgi）
              │  /health → FastAPI（健康检查）
              │  其余     → [assets] Next.js 静态导出 + SPA 回退
              │
              ▼  Hyperdrive (连接池/聚合)
          Neon PostgreSQL (project falling-salad-31662168 · 分支 production / 开发用 dev)
```

> **2026-09-19 合并**：原 `kaas-intel-api`（后端 API）+ `kaas-platform`（前端静态资产）
> 已合并为单 Worker `kaas`。工位独立是系统设计层面（表前缀 / API 命名空间 / 路由隔离），
> 与 Worker 数量无关——所有工位（含未来报价/订单/票据/市场/询盘）都跑在这一个 Worker 里。
>
> **2026-09-22 修正**：`/health` 原先由静态资产层接管，被 SPA 回退成 index.html
> （状态码 200 但内容不是健康检查结果），导致冒烟测试形同虚设。
> 现已在 Worker 入口显式把 `/health` 交给 FastAPI。

## 0. 运维速查（事故时先看这里）

### 0.1 一键回滚 / 前滚到指定版本（秒级，无需重新构建）

```bash
cd backend/worker
npx wrangler deployments list --name kaas      # 看版本历史（含时间与版本 ID）
npx wrangler versions deploy <version-id>@100% --name kaas --yes
```

生产事故（例如发布后大面积 5xx）时，这是**最快的恢复手段**。

### 0.2 已知特性：发布后有数分钟的错误窗口

Python Worker（Pyodide）冷启动开销较大（`pywrangler deploy` 会报告
`Worker Startup Time`，曾观测到 ~2.8s）。新版本发布后，新 isolate 启动期间
**部分请求会返回 5xx**（实测约 1/5），几分钟后自行恢复。

应对：
- CI 冒烟测试**带重试**等待 Worker 就绪（见 §3），不会误报失败
- 前端 axios 对**幂等请求**（GET/HEAD/OPTIONS）自动指数退避重试 3 次
- 降低启动开销的手段：裁剪 `pyproject.toml` 中运行时未使用的依赖
  （2026-09-22 移除 `httpx` / `pydantic-settings`，包体 586→508 模块）

> ⚠️ **回滚也会重置冷启动窗口**（2026-09-22 实测踩坑）：
> `wrangler versions deploy` 无论前滚还是回滚，都会让全部 isolate 失效，
> 重新经历数分钟的冷启动窗口。**连续反复回滚会把短故障拖成长故障。**
>
> 判定规则：
> 1. 错误**间歇性**、且 5 分钟内自愈 → **不要操作**，等待即可。
> 2. 仅当 **100% 请求持续失败 > 5 分钟** 时才考虑 §0.1 回滚。
> 3. 回滚后若仍有间歇性 5xx，属于预期，不要再次回滚（会再次重置窗口）。

### 0.3 常见误判

| 现象 | 真相 |
|------|------|
| `curl /health` 返回 200 但内容是 HTML | 说明请求被静态资产 SPA 回退接管（不是 Worker 响应）；2026-09-22 后 `/health` 应返回 JSON |
| 冒烟测试通过 ≠ Worker 健康 | 旧版冒烟只查状态码；现版会断言 `/health` 内容与 `/api/*` 的 401 |
| `api.kaas.powervoy.com` 正常但主域名 5xx | 多为发布窗口的间歇性失败，重试即可；必要时用 §0.1 回滚 |
| 主域名 5xx 但静态页面（`/research`）仍 200 | 静态资产由边缘直接服务、**不经过 Python Worker**；说明坏的是 Worker isolate，不是站点 |
| 用浏览器 fetch 测 `api.kaas.powervoy.com/health` 得到 `ERR` | `/health` 不带 CORS 头，跨域读取会被浏览器拦截；**不是宕机**。判断 api 域名健康度请用 `/api/v1/*`（有 ACAO） |
| 线索池里出现 `E2E_*` 测试行 | 中断的 E2E 无法自清理：线索池**没有 DELETE 端点**，需直接改库（见 §0.4） |
| 改了 secret 却“不生效” | Worker 绑定值**只能在请求期读**，import 期读一定是空（见 §0.5） |

### 0.4 测试数据清理（无端点，需改库）

`lead_candidates`（线索池）**没有 DELETE 端点**（`DELETE /api/v1/leads/{id}` → 405），
异常中断的 E2E 测试线索只能直接改库清理。可复用脚本：

```powershell
cd backend/orchestrator
uv run --extra migrations python ..\..\.tools\cleanup_orphan_lead.py   # 删 E2E_PROD_CHECK% / E2ELOCAL% / E2EZZ%
```

- Neon DSN 与 psycopg2 连法见 `backend/.tools/*.py`（`?sslmode=require`，缺它会报
  `invalid connection option "ssl"`）。
- `research_runs` 是审计流水，**刻意保留**（记录何时挑选了哪些线索）。
- 写路径 E2E 必须用 `try/finally` 保证清理；否则一旦中途 5xx，数据会残留在生产库。

### 0.5 Worker 环境变量：只能在请求期读（重要，曾导致生产鉴权漏洞）

> **2026-09-22 生产实证：import 期用 `os.environ` 读绑定值为空。**

后果（修复前）：

| 表现 | 后果 |
|------|------|
| `JWT_SECRET` 回退到**公开默认串** `kaas-dev-jwt-secret-change-in-prod` | **任何人可伪造管理员 token**（严重） |
| `ADMIN_SETUP_TOKEN` 失效 | `bootstrap-admin` 恒返回 503 |
| `HYPERDRIVE` 正常 | 因为它走的是 `request.scope["env"]`（请求期） |

正确做法：

- 一律在**请求期**取值：`request.scope["env"]`；`main.py` 的 `_binding()` 已封装
  （优先级：显式 `request` → 中间件写入的 ContextVar → `os.environ` 兜底），
  中间件 `bind_worker_env` 对每个请求写入 ContextVar，供无 `request` 参数的深层函数使用。
- **禁止保留任何公开默认值**：缺失时直接 503（`JWT_SECRET` / `ADMIN_SETUP_TOKEN`）。
- 修复后**所有旧 token 失效**（它们是用默认串签发的）—— 用户需重新登录一次，属预期。

验证绑定是否可读（不泄露 secret）：

```bash
# 403 = 绑定读到了；503 = 读不到
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.kaas.powervoy.com/api/v1/auth/bootstrap-admin \
  -H "Authorization: Bearer wrong" -H "Content-Type: application/json" \
  -d '{"email":"a@b.co","password":"xxxxxxxx"}'
```

## 1. 部署（单 Worker，前后端一体）

### 1.1 本地 Docker 开发环境（2026-10-20 更新：单应用入口）

> ⚠️ **新 clone / 换设备必做：先 `scripts/sync-shared.ps1`**。`backend/worker/src/kaas_common/`
> 是 gitignored 生成镜像，跳过会 `ModuleNotFoundError: No module named 'kaas_common.preview'`；
> `GET /health` 返回 `shared.loaded=true` 才说明镜像同步成功。完整顺序见根 `README.md` §3。

本地开发**不需要**碰生产 Worker：`docker compose up -d` 起
Postgres / Redis / MinIO / backend（= `worker/local_run.py`，与生产同一份 app），前端在宿主用 `next dev` 直连。

```powershell
cd D:\MyProject\kaas-platform
# 0) 首次：同步共享内核镜像（改 backend/kaas_common 后也要重跑）
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1

docker compose up -d
# 首次建表（不再自动迁移；与生产同一套 Alembic）
cd backend/orchestrator
uv sync --extra migrations
$env:DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@localhost:5432/kaas_dev"
uv run --extra migrations alembic upgrade head
# 健康检查：http://localhost:8000/health -> {"status":"ok","shared":{"loaded":true}}

cd ..\..\frontend
pnpm dev                      # http://localhost:3000（.env.development=real → localhost:8000）
```

说明（替代旧 orchestrator 镜像）：
- 镜像 = `backend/worker/Dockerfile.local`（python:3.13 + worker 依赖 + uvicorn；**不进生产 bundle**）。
- 构建上下文 = `./backend`（`backend/.dockerignore` 排除 orchestrator 与测试）。
- 热重载：`LOCAL_RELOAD=1`（默认）+ 挂载 `./backend/worker/src:/app/src`。
- 首次管理员：`POST /api/v1/auth/bootstrap-admin`（`Authorization: Bearer $ADMIN_SETUP_TOKEN`）。
- 改了依赖或 Dockerfile 后：`docker compose build backend && docker compose up -d backend`。

### 1.2 Hyperdrive 查询缓存（写后读一致性，**必须知道**）

Cloudflare Hyperdrive **默认缓存只读查询 60 秒**（`stale_while_revalidate=15s`），
且**写后不失效**。表现：新建/修改客户后立即 GET 可能读到旧值（「新建的客户刷新后消失」）。

- 需要「写后立即见」的场景，关闭该 Hyperdrive 配置的查询缓存：

  ```powershell
  npx wrangler hyperdrive update f53fed49705043008737032e4bfa2b8e --caching-disabled
  ```

- 或按官方建议建第二个 `--caching-disabled` 配置，只给「写后立即读」的接口用
  （`wrangler.jsonc` 可同时绑两个 Hyperdrive binding）。
- **注意**：本地 Docker/Postgres 没有这层缓存；该问题只在生产 Worker 出现。

### 1.3 部署命令

前置：uv 已安装；wrangler 已登录（`npx wrangler whoami` 验证）。

```bash
cd backend/worker

# 本地开发（Hyperdrive 本地模拟指向 Neon 分支 dev）
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://neondb_owner:<pwd>@ep-wandering-frost-b5d9zoaq-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require"
uv run pywrangler dev

# 生产密钥（一次性；Worker 更换后需重新设置并重新初始化管理员）
"<随机 JWT secret>" | uv run pywrangler secret put JWT_SECRET
"<one-time-setup-token>" | uv run pywrangler secret put ADMIN_SETUP_TOKEN

# 部署（wrangler.jsonc 已含 Hyperdrive + ASSETS + 两个自定义域名）
uv run pywrangler deploy
```

> **重要**：更换 Worker 名称（如本次合并）后，旧 Worker 的 secrets **不会**自动迁移，
> 必须重新 `secret put` 并重新执行管理员初始化（bootstrap-admin），否则登录报 401。

Worker 运行时：`compatibility_flags = ["python_workers"]`（open beta），
数据库访问为**每请求 asyncpg 连接 + Hyperdrive 聚合**（连接池模式在 Workers 中不可用）。

路由（`wrangler.jsonc`）：`/api/*` 与 `/health` 在 assets 的 `run_worker_first` 中**显式声明**，
不再依赖“资产未命中才落到 Worker”的隐式行为（历史上它把 `/health` 让给了 SPA 回退，
导致冒烟测试形同虚设）。其余路径由边缘直接返回静态资产、**不执行 Python 代码**——
这也是“静态页面 200 但 Worker 路由 5xx”现象的成因。

数据库迁移（Neon schema 变更，仓库本地执行，需 DATABASE_URL 指向 Neon）：

```powershell
cd backend/orchestrator
uv sync --extra migrations
$env:DATABASE_URL="<生产 Neon psycopg2 形式 DSN>"
uv run --extra migrations alembic upgrade head
uv run --extra migrations alembic check        # 可选：metadata ↔ schema 零漂移
```

当前迁移头**以 `alembic heads` 为准**（2026-10-21 = **`202610200005`**；
生产已于 2026-10-21 从 `202610180010` 一次升到 `202610200005`，**6 条迁移**：内容版本 / 对账表 / 询盘阶段 /
单证事实表 / 文件当前版本唯一索引 `NULLS NOT DISTINCT` + 幂等补列段）。发布前确认库已到 head，
否则新列缺失会让单证/港口等页面 500；**回滚版本与快照见
[docs/HANDOVER_2026-10-20_FINAL.md](docs/HANDOVER_2026-10-20_FINAL.md) §0.4**。
**deploy.yml 的 migrate job**：配置 secret `PROD_DATABASE_URL` 时自动 `alembic upgrade head`；
未配置时告警跳过（保持手动迁移）。

初始化管理员（一次性，对线上 Worker 执行；当前线上已初始化，会返回 403）：

```bash
curl -X POST https://api.kaas.powervoy.com/api/v1/auth/bootstrap-admin \
  -H "Authorization: Bearer <ADMIN_SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kaas.dev","password":"<强密码>","display_name":"系统管理员"}'
```

## 2. 前端构建（静态导出，随 Worker 一起部署）

前端是 **Next.js 16.4.2 静态导出**（`NEXT_EXPORT=1 pnpm build` → `frontend/out`），
由 `kaas` Worker 的 `assets` 直接服务，**不再需要单独部署 Pages/前端 Worker**。

```powershell
# 生产环境变量（写入 .env.production）
#   NEXT_PUBLIC_API_MODE=real
#   NEXT_PUBLIC_API_BASE_URL=https://api.kaas.powervoy.com

# monorepo 根目录安装（pnpm workspace：frontend + shared 单锁）
cd D:\MyProject\kaas-platform
pnpm install --frozen-lockfile

# 静态导出（Next 16：out/ 为产物；**不要设 NEXT_DIST_DIR**，否则产物会落到该目录）
cd frontend
$env:NEXT_EXPORT="1"
pnpm build
```

`backend/worker/wrangler.jsonc` 的 `assets.directory` 指向 `../../frontend/out`，
部署 Worker 时自动带上最新构建产物。

## 3. 验证清单

> 部署后立即执行时，请记得 §0.2 的冷启动窗口：连续失败请**重试**，不要马上判定失败。

- [ ] `https://api.kaas.powervoy.com/health` 返回 200 **且 body 为**
      `{"status":"ok","service":"kaas-intel-worker"}`（不是 HTML！）
- [ ] 匿名访问 `/api/v1/leads`、`/api/v1/research/categories`、`/api/v1/research/stats`、
      `/api/v1/ai/tasks`、`/api/v1/events` 均返回 **401**（401 = 路由存在且已鉴权；200 = 鉴权漏洞）
- [ ] 登录仍可用（验证 `JWT_SECRET` 请求期可读；若登录 503 就是绑定没读到，见 §0.5）
- [ ] `https://kaas.powervoy.com/login` 可登录
- [ ] 登录后侧边栏「情报体系 → 进出口情报 / 市场调研 / 地图源客户信息获取」三项可见（内部管理员账号）
- [ ] **QA 测试账号**可登录且单证/公章功能正常（账号由 `scripts/seed_qa.py` 落库，设计与越权审计清单见 `docs/QA_TEST_ACCOUNTS.md`）
- [ ] 货运记录页能看到导入/采集的数据
- [ ] `/research` 页面可加载（列表/统计/挑选/运行记录三个标签）
- [ ] `POST /api/v1/intel/import/csv` 上传 CSV 成功

## 4. CI 部署（手动 dispatch）

> **现行口径（2026-10-20 用户裁决，2026-10-21 已按此发布三次）**：`deploy.yml` **仅 `workflow_dispatch`**
> （**不再随 push 自动部署**）；用户下达发布指令后，优先本机 `pywrangler deploy`
> （Actions 额度/权限不稳，见 §4.1）。生产已发布（迁移 `202610200005` + worker `9d497628`），
> 后续发布按「发布预案」逐次执行。

`.github/workflows/deploy.yml`：手动 dispatch →
TypeScript 构建前端 → **同步共享内核并校验** → （若配了 `PROD_DATABASE_URL`）migrate job `alembic upgrade head` → `pywrangler deploy` → 生产冒烟测试
（`concurrency: deploy-production` 串行）。

> ### ⚠️ 「同步共享内核」这一步不能删（2026-09-28 补上，此前完全缺失）
>
> `backend/worker/.gitignore` 忽略了 `src/kaas_common/` —— 那是
> `scripts/sync-shared.ps1` 从 `backend/kaas_common/`（含 `export_quote/`、`domain/enums.py`）
> **复制**出来的镜像（37 + 20 + 1 个文件），**不进版本控制**，runner 上必须现生成。
>
> 该工作流此前只有 `pywrangler deploy`，于是线上 bundle 里根本没有这个目录：
> `/health` 的 `shared.loaded` 长期是 `false`，报价引擎整包缺失。
> 现在流程是「`sync-shared.ps1` → `sync-shared.ps1 -Check`」，
> 且冒烟测试会断言 `shared.loaded=true` 与报价 4 条路由返回 401 ——
> 这两条断言就是针对这个事故加的探针（只查 `status:ok` 是发现不了的）。

分支策略（2026-09-28 切换）
-------------------------
| 分支 | 角色 |
|---|---|
| **`main`** | **生产分支** —— 生产代码基线；发布 = 手动 `workflow_dispatch` 或本机 `pywrangler deploy`（**push 不触发部署**） |
| ~~`feat/trade-doc-templates`~~ | **已于 2026-10-17 删除**：该分支 tip（`4fc5a6e`）的树里仍带着历史硬编码的生产 DSN（`backend/.tools/*.py`），且它已落后 `main` 279 个提交、**没有独有提交**（是 `main` 的祖先）⇒ 删除无内容损失，只关掉一个"当前可读"的泄露入口 |
| ~~`feature/intel-workstation-v1`~~ | 已归档（旧部署分支，内容已全部包含在开发分支里） |

> 切换前的历史：部署曾挂在 `feature/intel-workstation-v1` 上，它是开发分支的祖先，
> 因没人做 fast-forward 而落后 16 个提交 —— 于是“改了但线上没动静”。
> 现在生产分支 = `main`，部署分支不再兼作开发分支。
>
> **上线门禁**：部分功能的前端已完成、但后端接口尚未在 Worker 落地，
> 它们以 `workstations.ts` 的 `status: 'planned'` / `'hidden'` 挡在侧边栏之外。
> **现行清单与放开条件见 [`docs/TODO.md`](docs/TODO.md)（活跃待办唯一账本）+ `shared/contracts/workstations.ts`**，
> 发布检查单见 [`docs/HANDOVER_2026-10-20_FINAL.md`](docs/HANDOVER_2026-10-20_FINAL.md) §5；
> 旧的 `CURRENT_IMPLEMENTATION_MAP.md` 已归档 `docs/archive/2026-10-20-p2-closeout/`，不再作当前口径。

**路径过滤（2026-09-22 加，历史保护）**：`**.md` / `docs/**` / `.tools/**` / `**/.tools/**` 的**纯文档提交
不触发部署**——因为每次部署都会让全部 isolate 失效、重新经历一次冷启动窗口（§0.2），
不适当地触发部署等于凭空制造一次生产风险窗口。
> 注：**2026-10-20 起 push 已完全不触发部署（仅手动 dispatch）**，本节路径过滤只在「将来恢复 push 自动部署」时才有意义；
> 当前要发布一律 Actions `Run workflow` 或本机 `pywrangler deploy`。

需要强制部署（例如只改了文档但要同步 Worker）时：Actions 页面手动 `Run workflow`。

### 4.1 部署没跑起来怎么排查（2026-10-17 实战）

> 注：2026-10-20 起 push **本就不触发部署**；下表适用于「手动 dispatch 未生效」或历史 push 期间的情形。

| 现象 | 判据 / 处理 |
|---|---|
| Actions 里**没有新 run** | 提交是否只改了 `**.md` / `docs/**` / `.tools/**`（`paths-ignore` 故意跳过，避免冷启动窗口）？需要强制发布 ⇒ Actions 页面 `Run workflow`（`workflow_dispatch`）。 |
| 有 run，但 job **2 秒内失败、steps 为空、runner_id=0** | **GitHub Actions 额度/账单**。annotation 原文：`The job was not started because recent account payments have failed or your spending limit needs to be increased`。私有仓库 Free 每月约 2,000 分钟，用尽后**所有** workflow 都会被挡在启动前。解法：Settings → Billing 处理支付/额度，或把仓库改为 **public**（公开仓库标准 runner 免费）。 |
| run 正常但线上没变 | 看 `deploy-worker` 的 `Sync shared kernel` / `pywrangler deploy` / `Smoke test` 哪步红；再用 `npx wrangler deployments list --name kaas` 核对线上版本时间。 |

> **2026-10-17 部署记录**：仓库改 public 后以 `workflow_dispatch` 触发 run `39010179425`，两个 job 全绿；
> 线上 Worker `b6c2d701`（`2026-10-17T06:33:07Z`），对应提交 `2a355c4`；生产库迁移执行到
> `202610170004`；冒烟与浏览器验证通过（`/health` JSON、匿名 API 401、页面 200、
> 无凭据深链直接 `/login` 且全程不出现系统 UI）。
> 同日 16:1x 又部署一次（提交 `272a683`，含 rate-sets 内嵌兜底、派生建单/方案物化两处产品修复），
> deploy 与冒烟均绿；`backend:test` 首次全绿（run `39016277997`）。
> 同日 17:0x–19:0x 连续多次 push 自动部署，最后一次代码部署为提交 **`b7f97a0`**（deploy 冒烟绿）；
> 之后 `f04c716` 仅文档。本轮上线内容：新建客户 500 修复、汇率实时拉取、Excel 模板前端生成、
> 客户阶段改由订单状态推导、流失强制上传拒绝文件（R2）。详见 `docs/archive/2026-10-20-closeout/HANDOVER_2026-10-17.md`。

其他工作流：`backend-test.yml`（S4 后 = 迁移/模型测试 + schema 双门禁 + 依赖断言 + worker 全量 + 真 PG 集成；
`paths: backend/**`、`scripts/**`）、`frontend-ci.yml`（typecheck/lint/test/build + e2e）、
`contracts-check.yml`（R0–R5；R6 已退役）。route-parity 与 export_openapi 已归档 `scripts/archive/`。
