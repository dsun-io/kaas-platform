# KaaS Platform 部署指南

## 架构

```
浏览器 ──> Cloudflare Pages (frontend · kaas.powervoy.com)
              │  /api/v1/* (HTTPS)
              ▼
          FastAPI 后端 (Docker · 任意 VPS, 建议 api.kaas.powervoy.com)
              │
              ▼
          Neon PostgreSQL (project falling-salad-31662168 · branch production)
```

## 1. 后端部署（Docker）

前置：任意 Linux 服务器 + Docker + Docker Compose（或单容器运行）。

```bash
cd backend/orchestrator
cp .env.production.template .env   # 填入 Neon URL、JWT_SECRET 等
docker build -t kaas-backend .
docker run -d --name kaas-backend --restart unless-stopped \
  -p 8000:8000 --env-file .env kaas-backend
```

数据库迁移（在容器内或本机 venv 执行，需 DATABASE_URL 指向 Neon）：

```bash
alembic upgrade head
```

初始化管理员（一次性）：

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/bootstrap-admin \
  -H "Authorization: Bearer <ADMIN_SETUP_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@kaas.dev","password":"<强密码>","display_name":"系统管理员"}'
```

建议用 Caddy/Nginx 反代 `api.kaas.powervoy.com` → `127.0.0.1:8000`（自动 HTTPS），
并在 Cloudflare DNS 添加 A/CNAME 记录。

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
