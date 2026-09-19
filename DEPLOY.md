# KaaS Platform 部署指南

## 架构

```
浏览器 ──> Cloudflare Worker "kaas" (单 Worker · Python FastAPI + 静态资产)
              ├─ kaas.powervoy.com      → 前端页面 + /api/v1/*（同源，无 CORS）
              ├─ api.kaas.powervoy.com  → 仅 API（历史域名，保留兼容）
              │
              │  /api/*  → FastAPI（asgi）
              │  其余     → [assets] Next.js 静态导出 + SPA 回退
              │
              ▼  Hyperdrive (连接池/聚合)
          Neon PostgreSQL (project falling-salad-31662168 · branch production)
```

> **2026-09-19 合并**：原 `kaas-intel-api`（后端 API）+ `kaas-platform`（前端静态资产）
> 已合并为单 Worker `kaas`。工位独立是系统设计层面（表前缀 / API 命名空间 / 路由隔离），
> 与 Worker 数量无关——所有工位（含未来报价/订单/票据/市场/询盘）都跑在这一个 Worker 里。

## 1. 部署（单 Worker，前后端一体）

前置：uv 已安装；wrangler 已登录（`npx wrangler whoami` 验证）。

```bash
cd backend/worker

# 本地开发（Hyperdrive 本地模拟指向 Neon）
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://neondb_owner:<pwd>@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require"
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

数据库迁移（Neon schema 变更，本地 venv 执行，需 DATABASE_URL 指向 Neon）：

```bash
cd backend/orchestrator
alembic upgrade head
```

当前迁移头：`20260919_workstation_links` —— 为报价 / 订单 / 外贸票据工位
建立数据库口子（`quote_*` / `orders_*` / `trade_doc_*` 主表 + 跨工位 `*_refs`
关联表）。仅建表，业务逻辑后续按 `docs/WORKSTATION_DESIGN.md` 填充。

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
NEXT_PUBLIC_API_BASE_URL=https://kaas.powervoy.com   # 同源，无 CORS

npm install --legacy-peer-deps
npm run build          # 输出到 out/
```

`backend/worker/wrangler.jsonc` 的 `assets.directory` 指向 `../../frontend/out`，
部署 Worker 时自动带上最新构建产物。

## 3. 验证清单

- [ ] `https://api.kaas.powervoy.com/health` 返回 200
- [ ] `https://kaas.powervoy.com/login` 可登录
- [ ] 登录后侧边栏「数据 → 商情雷达」可见（内部管理员账号）
- [ ] 货运记录页能看到导入/采集的数据
- [ ] `POST /api/v1/intel/import/csv` 上传 CSV 成功
