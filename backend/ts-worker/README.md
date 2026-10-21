# kaas-edge（KaaS TS 门面）

> **定位（ADR-008 两层架构）**：TS Worker(Hono) = 对外唯一门面；Python Worker = 内核。
> 当前进度：Phase 1 工程骨架 + Phase 2 前三域（**auth 9 / customers 20 / teams 15 = 44 条**）已接线，
> 全部只做鉴权 / 参数校验 / 协议转换；业务规则仍在 Python 内核与 `backend/kaas_common/`。

## 铁纪律（违反即回退）

1. **门面禁写业务逻辑**：业务规则只在 Python 内核一处实现；本 Worker 只做
   **鉴权 / 参数校验 / 协议转换**，禁止任何业务 if。
2. **zod schema 代码生成约定**：TS 侧 zod schema 从 Python pydantic 模型**代码生成**，
   禁止手抄。当前手写处均标 `TODO(TODO:TS1)`（见 src/env.ts 的 BROWSER 类型、
   src/index.ts 的 OPENAPI、src/routes/*.ts 的入参 schema）。
3. **跨层契约变更**（Service Binding 请求/响应形状）必须**同 PR** 并通过金标 harness
   （[`backend/ts-migration/golden/`](../ts-migration/golden/README.md)）全绿。
4. secret 一律 `wrangler secret put`，**绝不入仓/打印**；密钥读取**无公开默认值**
   （2026-10-19 生产实证：JWT_SECRET 回退默认串 = 可伪造管理员 token）。

## 目录

| 文件 | 说明 |
|---|---|
| `src/index.ts` | Hono app：CORS 中间件（语义对齐 `backend/worker/src/main.py` cors_middleware）、三域挂载、`GET /health`、`GET /openapi.json`（显式 JSON） |
| `src/env.ts` | Bindings 类型 + `getEnv` / `requireSecret`（缺失即报错，不回退默认） |
| `src/db.ts` | postgres.js 请求级连接封装（每请求建/释，不池化；ADR-004 与 Python `platform/db.py` 同语义） |
| `src/http.ts` | FastAPI 风格错误信封（`{"detail": ...}`）、zod body/query/path 解析、int8→number/timestamptz→iso 规范化 |
| `src/auth.ts` | JWT 校验（jose/HS256，对齐 pyjwt decode）+ bcryptjs 校验（$2b$ 互通）——**只函数，不接路由** |
| `src/session.ts` | 当前用户装载（`_get_current_user`）、JWT 签发（`_create_token`）、bcrypt 哈希、`_auth_payload`/`_profile_payload` |
| `src/rules.ts` | `kaas_common/workstation/*` 纯函数的逐行镜像（**临时**，`TODO(TODO:TS3)` 换 KERNEL） |
| `src/serializers.ts` | 行 → API 投影（客户/询盘/联系人/阶段日志/团队/邀请/订阅） |
| `src/kernel.ts` | Python 内核 Service Binding 调用封装 + 统一错误形状（契约纪律写在头注释） |
| `src/routes/auth.ts` | auth 域 9 条 |
| `src/routes/customers.ts` | customers 域 20 条 |
| `src/routes/teams.ts` | teams 域 15 条（团队 12 + 团队订阅 3） |
| `src/proxy.ts` | 引擎域透传（quotes / trade-docs / ai；并行迁移线，门面不重写业务） |
| `tests/` | vitest：CORS、/health、JWT、bcrypt、**auth/customers/teams 路由**；`helpers.ts` 提供 env 注入 + sql 桩 |

## 端点进度表（route-inventory.md 口径）

> 状态均为 **✅ 已接线**（TS 路由已注册并通过 `pnpm test`）；“测试”列 = 本次新增路由测试是否直接覆盖。

### auth（9 / 9）

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | POST | `/api/v1/auth/bootstrap-admin` | main.py:295 `bootstrap_admin` | — |
| 2 | POST | `/api/v1/auth/login` | main.py:335 `login` | ✅ 成功/401/403/422 |
| 3 | GET | `/api/v1/auth/me` | main.py:387 `get_me` | ✅ 带 token/无 token/坏 token |
| 4 | POST | `/api/v1/auth/logout` | main.py:406 `logout` | — |
| 5 | PATCH | `/api/v1/auth/me` | main.py:447 `update_me` | — |
| 6 | POST | `/api/v1/auth/change-password` | main.py:479 `change_password` | — |
| 7 | POST | `/api/v1/auth/forgot-password` | main.py:668 `forgot_password` | —（TODO TS2 不发信） |
| 8 | POST | `/api/v1/auth/reset-password` | main.py:704 `reset_password` | — |
| 9 | POST | `/api/v1/auth/register` | main.py:796 `register` | — |

### customers（20 / 20）

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/customers` | main.py:1368 `list_customers` | ✅ 401/租户过滤/管理员范围 |
| 2 | POST | `/api/v1/customers` | main.py:1429 `create_customer` | — |
| 3 | GET | `/api/v1/customers/{customer_id}` | main.py:1502 `get_customer` | — |
| 4 | POST | `/api/v1/customers/{customer_id}/contacts` | main.py:1533 `add_contact` | — |
| 5 | PATCH | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | main.py:1565 `update_contact` | — |
| 6 | DELETE | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | main.py:1597 `delete_contact` | — |
| 7 | DELETE | `/api/v1/customers/{customer_id}` | main.py:1615 `soft_delete_customer` | — |
| 8 | POST | `/api/v1/customers/{customer_id}/inquiries` | main.py:1646 `add_inquiry` | — |
| 9 | PATCH | `/api/v1/customers/{customer_id}/stage` | main.py:1675 `update_stage` | — |
| 10 | PATCH | `/api/v1/customers/{customer_id}` | ws_crm_ext.py:166 `update_customer` | — |
| 11 | GET | `/api/v1/customers/{customer_id}/inquiries` | ws_crm_ext.py:216 `list_customer_inquiries` | — |
| 12 | GET | `/api/v1/inquiries` | ws_crm_ext.py:259 `list_inquiries` | — |
| 13 | PATCH | `/api/v1/inquiries/{inquiry_id}` | ws_crm_ext.py:301 `update_inquiry` | — |
| 14 | GET | `/api/v1/inquiries/{inquiry_id}/stage-log` | ws_crm_ext.py:413 `list_inquiry_stage_log` | — |
| 15 | GET | `/api/v1/customers/{customer_id}/records` | ws_customer_records.py:36 `customer_records` | — |
| 16 | GET | `/api/v1/capability-customers` | main.py:3096 `list_capability_customers` | — |
| 17 | GET | `/api/v1/capabilities` | main.py:3118 `list_capabilities_api` | — |
| 18 | POST | `/api/v1/capabilities` | main.py:3140 `upsert_capability_api` | — |
| 19 | GET | `/api/v1/customer/{customer_id}/capabilities` | main.py:3180 `get_customer_capabilities` | — |
| 20 | PATCH | `/api/v1/customer/{customer_id}/capabilities` | main.py:3198 `patch_customer_capability` | — |

### teams（15 / 15）

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | POST | `/api/v1/teams` | ws_teams.py:160 `create_team` | ✅ 201/默认全工位/409 |
| 2 | GET | `/api/v1/teams/me` | ws_teams.py:221 `my_team` | ✅ 无团队/有团队 |
| 3 | GET | `/api/v1/teams` | ws_teams.py:246 `list_teams` | ✅ 403 闸门/管理员 200 |
| 4 | PATCH | `/api/v1/teams/{team_id}` | ws_teams.py:308 `update_team` | ✅ 非管理员 403 |
| 5 | GET | `/api/v1/teams/{team_id}/members` | ws_teams.py:335 `list_members` | — |
| 6 | DELETE | `/api/v1/teams/{team_id}/members/{user_id}` | ws_teams.py:355 `remove_member` | — |
| 7 | POST | `/api/v1/teams/{team_id}/invites` | ws_teams.py:385 `create_invite` | — |
| 8 | GET | `/api/v1/teams/{team_id}/invites` | ws_teams.py:422 `list_invites` | — |
| 9 | DELETE | `/api/v1/teams/{team_id}/invites/{invite_id}` | ws_teams.py:439 `revoke_invite` | — |
| 10 | POST | `/api/v1/teams/join` | ws_teams.py:460 `join_team` | ✅ 空码 422 |
| 11 | POST | `/api/v1/teams/{team_id}/transfer` | ws_teams.py:507 `transfer_team` | — |
| 12 | PUT | `/api/v1/teams/{team_id}/members/{user_id}/console-access` | ws_teams.py:547 `set_console_access` | — |
| 13 | GET | `/api/v1/teams/{team_id}/subscriptions` | ws_workstations.py:155 `list_team_subscriptions` | ✅ 非管理员 403 |
| 14 | PUT | `/api/v1/teams/{team_id}/subscriptions/{code}` | ws_workstations.py:169 `set_team_subscription` | — |
| 15 | DELETE | `/api/v1/teams/{team_id}/subscriptions/{code}` | ws_workstations.py:200 `revoke_team_subscription` | — |

## 与 Python 侧的对齐点（金标差异登记）

| 项 | Python 侧现状 | TS 门面口径 |
|---|---|---|
| `GET /openapi.json` | 被 CF SPA fallback 成 `text/html`（golden harness「已知发现」） | **显式返回 application/json**（登记为金标差异，有意的修正）；paths 仍只覆盖 /health |
| CORS | `ALLOWED_ORIGINS` 白名单 + 非法 Origin 回退默认来源 + OPTIONS 204 | 逐条同语义（含 `127.0.0.1:3000`、`Max-Age: 86400`、`Vary: Origin`） |
| DB 连接 | 每请求 `asyncpg.connect` + 关闭，无池（ADR-004） | 每请求 postgres.js 客户端 `sql.end()`，`max: 1` |
| JWT | pyjwt HS256，校验 exp，401 envelope `{"error","message"}` | jose jwtVerify（默认校 exp/nbf/iat），同 envelope |
| 密码哈希 | bcrypt `$2b$` | bcryptjs 互通（测试用 Python 实生成哈希验过） |
| 登录缺字段 | Pydantic 校验失败 → **422**（`test_parity_auth.py:536`） | 同 422；detail 数组形状为近似（见下条），**不是 400** |
| Pydantic 422 detail | `[{type,loc,msg,input,url}...]`，message 逐字由模型生成 | `http.ts` 生成近似形状（`TODO(TODO:TS1)` 待 zod 代码生成后逐字对齐） |
| 时间戳精度 | `datetime.isoformat()`：微秒为 0 时输出 `...+00:00` | JS `Date.toISOString()`：恒带 3 位毫秒（`...00.000+00:00`），且丢失微秒；金标白名单已登记 |
| forgot-password 发信 | Resend REST 发送重置邮件 | **不发送**，只落库 token 并记录 `password_reset_email_deferred` 日志；响应体同 Python（`TODO(TODO:TS2)`） |
| 团队/订阅规则判定 | `kaas_common/workstation/{teams,scope,subscriptions}.py` | `rules.ts` 逐行镜像（KERNEL 目前无 `/internal/rules/*` 端点；`TODO(TODO:TS3)` 后切 Service Binding） |
| `expires_at` 解析 | `datetime.fromisoformat`（严格 ISO） | JS `Date` 解析更宽松（登记为输入宽容度差异；非法值仍 422） |
| 邀请码撞码重试 | 事务内重试 5 次（唯一约束冲突） | 同语义逐行直译（撞码概率可忽略，保留兜底） |

## TODO 标记位置

| 标记 | 位置 | 内容 |
|---|---|---|
| `TODO(TODO:TS1)` | `src/index.ts`（OPENAPI paths）、`src/env.ts`（BROWSER 类型）、`src/routes/*.ts` 头注释 | 手写 zod schema / OPENAPI 待由 Python pydantic 模型代码生成（生成器见 `scripts/generate-zod.mjs`，输出 `src/generated/schemas.ts`） |
| `TODO(TODO:TS2)` | `src/routes/auth.ts` forgot-password 段（约 :258） | 接入 Resend 发信；RESEND_API_KEY 配到 edge 后走真实链路验证 |
| `TODO(TODO:TS3)` | `src/rules.ts` 头注释、`src/routes/teams.ts` 头注释、`src/session.ts` 头注释 | `rules.ts` 镜像待 KERNEL 暴露 `/internal/rules/*` 后删除改走 kernel.ts；此前不得在别处重写判定 |

## 本地开发

```powershell
cd backend/ts-worker
pnpm install        # 本机若拦 pnpm.ps1，用 pnpm.cmd
pnpm dev            # wrangler dev（本地起 Worker；DB 需可达 Hyperdrive 或本地 PG）
```

## 测试与门禁

```powershell
cd backend/ts-worker
pnpm.cmd typecheck  # tsc --noEmit
pnpm.cmd test       # vitest run
```

当前口径（2026-10-21）：**typecheck 0 error；vitest 8 files / 45 tests 全绿**。
其中 Phase 1 原有 17 条（cors 5、health 1、JWT 8、bcrypt 3）**未回退**；
本次新增 21 条：auth 7 / customers 3 / teams 11；另有并行迁移线的 proxy 7 条（quotes/trade-docs/ai 透传）。
测试用 `app.request(path, init, TEST_ENV)` 注入 env，`tests/helpers.ts` 的 `resetDb(handler)`
按 SQL 片段打桩 `withDb`（不触网、不建真实 postgres.js 连接）。

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

- 剩余域按 `backend/ts-migration/route-inventory.md` 继续迁移；每域金标 diff 全绿为 DoD。
- Service Binding `KERNEL` 绑定（wrangler.jsonc 里已留注释槽）；`/internal/rules/*` 就绪后删除 `rules.ts` 镜像。
- forgot-password 接 Resend（TODO:TS2）。
