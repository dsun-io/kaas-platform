# kaas-edge（KaaS TS 门面骨架）

> **定位（ADR-008 两层架构）**：TS Worker(Hono) = 对外唯一门面；Python Worker = 内核。
> 本目录是 **W3 Phase 1 工程骨架**，目前只有探针/契约基础设施，未接业务路由。

## 铁纪律（违反即回退）

1. **门面禁写业务逻辑**：业务规则只在 Python 内核一处实现；本 Worker 只做
   **鉴权 / 参数校验 / 协议转换**，禁止任何业务 if。
2. **zod schema 代码生成约定**：TS 侧 zod schema 从 Python pydantic 模型**代码生成**，
   禁止手抄。当前手写处均标 `TODO(TODO:TS1)`（见 src/env.ts 的 BROWSER 类型、
   src/index.ts 的 OPENAPI）。
3. **跨层契约变更**（Service Binding 请求/响应形状）必须**同 PR** 并通过金标 harness
   （[`backend/ts-migration/golden/`](../ts-migration/golden/README.md)）全绿。
4. secret 一律 `wrangler secret put`，**绝不入仓/打印**；密钥读取**无公开默认值**
   （2026-10-19 生产实证：JWT_SECRET 回退默认串 = 可伪造管理员 token）。

## 目录

| 文件 | 说明 |
|---|---|
| `src/index.ts` | Hono app：CORS 中间件（语义对齐 `backend/worker/src/main.py` cors_middleware）、`GET /health`、`GET /openapi.json`（显式 JSON） |
| `src/env.ts` | Bindings 类型 + `getEnv` / `requireSecret`（缺失即报错，不回退默认） |
| `src/db.ts` | postgres.js 请求级连接封装（每请求建/释，不池化；ADR-004 与 Python `platform/db.py` 同语义） |
| `src/auth.ts` | JWT 校验（jose/HS256，对齐 pyjwt decode）+ bcryptjs 校验（$2b$ 互通）——**只函数，不接路由** |
| `src/kernel.ts` | Python 内核 Service Binding 调用封装 + 统一错误形状（契约纪律写在头注释） |
| `tests/` | vitest 单测：CORS、/health、JWT（通过/过期/错签）、bcryptjs↔Python 哈希互通 |

## 与 Python 侧的对齐点（金标差异登记）

| 项 | Python 侧现状 | TS 门面口径 |
|---|---|---|
| `GET /openapi.json` | 被 CF SPA fallback 成 `text/html`（golden harness「已知发现」） | **显式返回 application/json**（登记为金标差异，有意的修正） |
| CORS | `ALLOWED_ORIGINS` 白名单 + 非法 Origin 回退默认来源 + OPTIONS 204 | 逐条同语义（含 `127.0.0.1:3000`、`Max-Age: 86400`、`Vary: Origin`） |
| DB 连接 | 每请求 `asyncpg.connect` + 关闭，无池（ADR-004） | 每请求 postgres.js 客户端 `sql.end()`，`max: 1` |
| JWT | pyjwt HS256，校验 exp，401 envelope `{"error","message"}` | jose jwtVerify（默认校 exp/nbf/iat），同 envelope |
| 密码哈希 | bcrypt `$2b$` | bcryptjs 互通（测试用 Python 实生成哈希验过） |

## 本地开发

```powershell
cd backend/ts-worker
pnpm install        # 本机若拦 pnpm.ps1，用 pnpm.cmd
pnpm dev            # wrangler dev（本地起 Worker；DB 需可达 Hyperdrive 或本地 PG）
```

## 测试与门禁

```powershell
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
```

CI 草稿：[`../../.github/workflows/ts-edge.yml`](../../.github/workflows/ts-edge.yml)
（`on:` 已注释，待 lead 接入触发）。

## 部署

```powershell
pnpm deploy         # wrangler deploy（routes 未配，不影响生产域名；切流由 lead 统一操作）
```

secrets 写入（遵循 AGENTS.md 铁律，禁用 PS 管道，写后必须真实链路验证）：

```powershell
# 推荐：Cloudflare API 精确写入（PUT .../workers/scripts/kaas-edge/secrets）
# 或 bash/CI 下 printf %s 管道；本地 wrangler：
npx wrangler secret put JWT_SECRET
```

## 未接线路线（下一步）

- Service Binding `KERNEL` 绑定（wrangler.jsonc 里已留注释槽）+ 首个内核调用域。
- 路由按 `backend/ts-migration/route-inventory.md` 分域迁移，每域金标 diff 全绿为 DoD。
