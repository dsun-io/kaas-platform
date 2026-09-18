# KaaS Platform 部署指南

## 架构

```
浏览器 ──> Cloudflare Pages (frontend · kaas.powervoy.com)
              │  /api/v1/* (HTTPS)
              ▼
          Cloudflare Worker (Python · kaas-intel-api · api.kaas.powervoy.com)
              │  Hyperdrive (连接池/聚合)
              ▼
          Neon PostgreSQL (project falling-salad-31662168 · branch production)
```

> 后端已改为 Cloudflare Workers 部署（Python Worker + Hyperdrive），不再使用 VPS/Docker。
> `backend/orchestrator` 保留为本地开发/数据迁移工具（alembic、采集脚本）。

## 1. 后端部署（Cloudflare Workers）

前置：uv 已安装；wrangler 已登录（`npx wrangler whoami` 验证）。

```bash
cd backend/worker

# 本地开发（Hyperdrive 本地模拟指向 Neon）
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgres://neondb_owner:<pwd>@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require"
uv run pywrangler dev

# 生产密钥（JWT_SECRET 用随机值；ADMIN_SETUP_TOKEN 仅在首次初始化管理员时需要）
"$(python -c 'import secrets; print(secrets.token_urlsafe(48))')" | uv run pywrangler secret put JWT_SECRET
"<one-time-setup-token>" | uv run pywrangler secret put ADMIN_SETUP_TOKEN

# 部署（wrangler.jsonc 已含 Hyperdrive binding + api.kaas.powervoy.com 自定义域名）
uv run pywrangler deploy
```

Worker 运行时：`compatibility_flags = ["python_workers"]`（open beta），
数据库访问为**每请求 asyncpg 连接 + Hyperdrive 聚合**（连接池模式在 Workers 中不可用）。

数据库迁移（Neon schema 变更，本地 venv 执行，需 DATABASE_URL 指向 Neon）：

```bash
cd backend/orchestrator
alembic upgrade head
```

初始化管理员（一次性，对线上 Worker 执行；当前线上已初始化，会返回 403）：

```bash
curl -X POST https://api.kaas.powervoy.com/api/v1/auth/bootstrap-admin \
  -H "Authorization: Bearer <ADMIN_SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kaas.dev","password":"<强密码>","display_name":"系统管理员"}'
```

## 2. 前端部署（Cloudflare Pages）

前置：wrangler 已登录（`wrangler whoami` 验证）。

```bash
cd frontend

# 生产环境变量（写入 .env.production 或 Pages 项目 Settings → Environment Variables）
NEXT_PUBLIC_API_MODE=real
NEXT_PUBLIC_API_BASE_URL=https://api.kaas.powervoy.com

npm install --legacy-peer-deps
npm run build
npx wrangler pages deploy .next --project-name=kaas-platform
```

> 注意：`wrangler.toml` 中的 `pages_build_output_dir` 用于 CI 自动构建；
> 手动部署用上面的 `pages deploy .next` 命令。

Pages 项目 Settings → Custom domains 绑定 `kaas.powervoy.com`。

## 3. 验证清单

- [ ] `https://api.kaas.powervoy.com/health` 返回 200
- [ ] `https://kaas.powervoy.com/login` 可登录
- [ ] 登录后侧边栏「数据 → 商情雷达」可见（内部管理员账号）
- [ ] 货运记录页能看到导入/采集的数据
- [ ] `POST /api/v1/intel/import/csv` 上传 CSV 成功
