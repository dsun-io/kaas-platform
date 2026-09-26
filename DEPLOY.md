# KaaS Platform 部署指南

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

```bash
cd backend/orchestrator
uv run python ..\..\.tools\cleanup_orphan_lead.py   # 删 E2E_PROD_CHECK% / E2ELOCAL% / E2EZZ%
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

数据库迁移（Neon schema 变更，本地 venv 执行，需 DATABASE_URL 指向 Neon）：

```bash
cd backend/orchestrator
alembic upgrade head
```

当前迁移头：`20260922_research_workstation` —— 市场调研工位（`research_products` /
`research_runs`）+ 地图源工位产品字段（`lead_candidates` 补 11 列）。

初始化管理员（一次性，对线上 Worker 执行；当前线上已初始化，会返回 403）：

```bash
curl -X POST https://api.kaas.powervoy.com/api/v1/auth/bootstrap-admin \
  -H "Authorization: Bearer <ADMIN_SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kaas.dev","password":"<强密码>","display_name":"系统管理员"}'
```

## 2. 前端构建（静态导出，随 Worker 一起部署）

前端已改为 **Next.js 静态导出**（`NEXT_EXPORT=1 next build` → `out/`），
由 `kaas` Worker 的 `[assets]` 直接服务，**不再需要单独部署 Pages/前端 Worker**。

```bash
cd frontend

# 生产环境变量（写入 .env.production）
NEXT_PUBLIC_API_MODE=real
# 生产实际走独立 API 域名（跨域，Worker 已放行 https://kaas.powervoy.com 来源）。
# 主域名 kaas.powervoy.com 的同源 /api/* 仅为历史兼容，前端并不依赖。
NEXT_PUBLIC_API_BASE_URL=https://api.kaas.powervoy.com

pnpm install --frozen-lockfile   # monorepo 单锁装齐 shared + frontend（pnpm 12 口径）
cd frontend && npm run build     # 输出到 out/
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
- [ ] 货运记录页能看到导入/采集的数据
- [ ] `/research` 页面可加载（列表/统计/挑选/运行记录三个标签）
- [ ] `POST /api/v1/intel/import/csv` 上传 CSV 成功

## 4. CI 自动部署

`.github/workflows/deploy.yml`：push 到 `feature/intel-workstation-v1` →
TypeScript 构建前端 → `pywrangler deploy` → 生产冒烟测试（`concurrency: deploy-production` 串行）。

**路径过滤（2026-09-22 加）**：`**.md` / `docs/**` / `.tools/**` / `**/.tools/**` 的**纯文档提交
不触发部署**——因为每次部署都会让全部 isolate 失效、重新经历一次冷启动窗口（§0.2），
不适当地触发部署等于凭空制造一次生产风险窗口。

需要强制部署（例如只改了文档但要同步 Worker）时：Actions 页面手动 `Run workflow`。

其他工作流：`backend-test.yml`（orchestrator 单测 + DB 测试 + Worker 纯函数单测，
已带 `paths: backend/**`）、`frontend-ci.yml`、`contracts-check.yml`。
