# kaas-edge（KaaS TS 门面）

> **定位（ADR-008 两层架构）**：TS Worker(Hono) = 对外唯一门面；Python Worker = 内核。
> 当前进度（2026-10-24 复核）：Phase 1 工程骨架 + Phase 2 波 A/B/C 完成；M1-f/M3/P0-A/C29/R-D 收口、
> 旧单产品导入 3 条端点下线后
> **门面注册 193 条 + 内核透传 85 条（12 个前缀 mount）= 278 业务路由**（+4 内置 = **282**）
> （auth 9 / customers 21 / teams 19 / orders 24 / files 9 / outreach 12 / admin 11 /
> workstations 35 / intel 37 / dashboard 3 / misc 12 / meta 1）。
> 透传实现统一为 `src/proxy.ts:forwardKernelRequest`（前缀 mount 与显式透传路由共用一份）。
> 测试 **305 条 / 26 文件全绿**；route-surface **193 直接** 0 缺 0 多；openapi **278 = 193 + 85** 全覆盖。
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
| `src/index.ts` | Hono app：CORS 中间件（语义对齐 `backend/worker/src/main.py` cors_middleware）、三域挂载、`GET /health`（`?deep=1` 经 KERNEL Service Binding 探内核）、`GET /openapi.json`（显式 JSON） |
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
| `src/routes/orders.ts` | orders 域 16 条（订单 9 + 实际成本 3 + 出运 4） |
| `src/routes/imports.ts` | 历史订单批量导入 2 条（C29；显式注册 + `forwardKernelRequest` 原样透传，multipart 不解析不重写） |
| `src/routes/files.ts` | files 域 9 条（文件对象 + R2 落点 + 渲染直链） |
| `src/routes/outreach.ts` | outreach 域 12 条（邮箱 / 活动 / 消息 / webhook 桩） |
| `src/routes/admin.ts` | admin 域 11 条（feature flag / 租户 / 审计 / 账号 / 提案） |
| `src/proxy.ts` | 引擎域透传（quotes / trade-docs / ai；并行迁移线，门面不重写业务） |
| `tests/` | vitest：CORS、/health、JWT、bcrypt、**auth/customers/teams/orders/files/outreach/admin 路由**；`helpers.ts` 提供 env 注入 + sql 桩 |

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

### orders（16 / 16）

> 真源：`backend/worker/src/main.py`（订单 9）+ `ws_extras.py`（实际成本 3）+ `ws_shipments.py`（出运 4）。

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/orders` | main.py:3394 `list_orders_api` | ✅ 401/422 INVALID_ENUM/成员范围谓词 + 投影 |
| 2 | POST | `/api/v1/orders` | main.py:3472 `create_order_api` | ✅ 缺客户 422 CUSTOMER_REQUIRED |
| 3 | GET | `/api/v1/orders/{order_id}` | main.py:3688 `get_order_api` | ✅ 不可见 404（detail 字符串）/四个关联块 |
| 4 | PATCH | `/api/v1/orders/{order_id}` | main.py:3741 `update_order_api` | — |
| 5 | POST | `/api/v1/orders/{order_id}/status` | main.py:3854 `change_order_status` | ✅ 409 ILLEGAL_TRANSITION/422 STATUS_REQUIRED |
| 6 | GET | `/api/v1/orders/{order_id}/payment-schedules` | main.py:3946 `list_schedules` | — |
| 7 | POST | `/api/v1/orders/{order_id}/payment-schedules` | main.py:3964 `create_schedule` | — |
| 8 | PATCH | `/api/v1/payment-schedules/{schedule_id}` | main.py:4011 `update_schedule` | — |
| 9 | GET | `/api/v1/receivables` | main.py:4105 `list_receivables` | — |
| 10 | GET | `/api/v1/actual-costs` | ws_extras.py:262 `list_actual_costs` | — |
| 11 | POST | `/api/v1/actual-costs` | ws_extras.py:284 `create_actual_cost` | — |
| 12 | POST | `/api/v1/actual-costs/resolve` | ws_extras.py:311 `resolve_actual_cost` | — |
| 13 | GET | `/api/v1/shipments` | ws_shipments.py:171 `list_shipments` | — |
| 14 | POST | `/api/v1/shipments` | ws_shipments.py:213 `create_shipment` | — |
| 15 | GET | `/api/v1/shipments/{shipment_id}` | ws_shipments.py:314 `get_shipment` | — |
| 16 | PATCH | `/api/v1/shipments/{shipment_id}` | ws_shipments.py:323 `update_shipment` | — |

### files（9 / 9）

> 真源：`backend/worker/src/ws_files.py`；上传校验 / key 规划 / 版本化在 `kaas_common/files/rules.py`（镜像进 `rules.ts`）。

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | PATCH | `/api/v1/file-objects/{file_id}` | ws_files.py:496 `patch_file` | ✅ 422 SORT_ORDER_OUT_OF_RANGE/404 FILE_NOT_FOUND |
| 2 | DELETE | `/api/v1/file-objects/{file_id}` | ws_files.py:545 `retire_file` | — |
| 3 | GET | `/api/v1/file-objects/{file_id}/content` | ws_files.py:558 `get_file_content` | — |
| 4 | GET | `/api/v1/file-objects` | ws_files.py:574 `list_files` | ✅ 401/403 NO_TEAM/200 + 团队谓词 |
| 5 | GET | `/api/v1/file-objects/{file_id}/render-content` | ws_files.py:977 `get_file_render_content` | ✅ 401 RENDER_TOKEN_INVALID/合法令牌 200 字节 |
| 6 | POST | `/api/v1/file-objects/presign` | ws_files.py:1037 `presign_upload` | —（恒 `{configured:false}`，见差异登记） |
| 7 | POST | `/api/v1/file-objects/register` | ws_files.py:1053 `register_upload` | — |
| 8 | GET | `/api/v1/file-objects/_r2_debug` | ws_files.py:1066 `r2_debug` | — |
| 9 | GET | `/api/v1/file-objects/{file_id}/url` | ws_files.py:1111 `get_file_url` | — |

### outreach（12 / 12）

> 真源：`backend/worker/src/chain.py`；订阅闸门 `_require_sub`（无订阅 = **404** SUBSCRIPTION_REQUIRED）。

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/outreach/mailboxes` | chain.py:1685 `mb_list` | ✅ 401/404 订阅闸门/200 掩码形状 |
| 2 | POST | `/api/v1/outreach/mailboxes` | chain.py:1695 `mb_create` | ✅ 409 DUPLICATE_MAILBOX/422 detail 数组 |
| 3 | PATCH | `/api/v1/outreach/mailboxes/{mailbox_id}` | chain.py:1719 `mb_patch` | — |
| 4 | POST | `/api/v1/outreach/mailboxes/{mailbox_id}/test` | chain.py:1752 `mb_test` | — |
| 5 | GET | `/api/v1/outreach/campaigns` | chain.py:1790 `camp_list` | — |
| 6 | POST | `/api/v1/outreach/campaigns` | chain.py:1800 `camp_create` | — |
| 7 | POST | `/api/v1/outreach/generate` | chain.py:1814 `camp_generate` | —（KERNEL 透传，见差异登记） |
| 8 | POST | `/api/v1/outreach/campaigns/{campaign_id}/send` | chain.py:1822 `camp_send` | — |
| 9 | GET | `/api/v1/outreach/messages` | chain.py:1899 `msg_list` | — |
| 10 | GET | `/api/v1/outreach/messages/{message_id}` | chain.py:1928 `msg_get` | — |
| 11 | POST | `/api/v1/outreach/messages/{message_id}/retry` | chain.py:1941 `msg_retry` | — |
| 12 | POST | `/api/v1/outreach/webhook` | chain.py:1977 `outreach_webhook` | ✅ 501 INBOUND_WEBHOOK_RESERVED |

### admin（11 / 11）

> 真源：`main.py:2824-3077`（6 条）+ `ws_admin_accounts.py`（2 条）+ `ws_admin_proposals.py`（3 条）。
> **两种闸门错误体不同**：平台运营 = `{error,message}`；账号治理 = `{error}`（逐字对齐）。

| # | Method | Path | Python 真源 | 测试 |
|---|---|---|---|---|
| 1 | GET | `/api/v1/admin/feature_flag` | main.py:2824 `get_feature_flag` | ✅ 401/403/200 形状/404 TENANT_NOT_FOUND |
| 2 | POST | `/api/v1/admin/feature_flag` | main.py:2858 `set_feature_flag` | ✅ 422 detail 字符串 |
| 3 | GET | `/api/v1/admin/tenants` | main.py:2910 `list_tenants` | — |
| 4 | POST | `/api/v1/admin/tenants/reload` | main.py:2927 `reload_tenants` | — |
| 5 | GET | `/api/v1/admin/audit-log` | main.py:2956 `get_audit_log` | — |
| 6 | GET | `/api/v1/admin/archive-logs` | main.py:3024 `get_archive_logs` | — |
| 7 | GET | `/api/v1/admin/accounts` | ws_admin_accounts.py:53 `list_accounts` | ✅ 403 仅 error 键/200 白名单 |
| 8 | PATCH | `/api/v1/admin/accounts/{user_id}` | ws_admin_accounts.py:80 `update_account_status` | ✅ 409 SELF_PROTECT/422 validation_error |
| 9 | GET | `/api/v1/admin/spec/attribute-proposals` | ws_admin_proposals.py:71 `list_attribute_proposals` | ✅ 200 items 投影 |
| 10 | GET | `/api/v1/admin/spec/attribute-proposals/recommended` | ws_admin_proposals.py:91 `list_recommended_proposals` | — |
| 11 | PATCH | `/api/v1/admin/spec/attribute-proposals/{proposal_id}` | ws_admin_proposals.py:108 `review_attribute_proposal` | ✅ 不存在提案 = 200 + {error:not_found} |

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
| 重置密码请求 IP | `request.client.host` | Workers 无 client 对象，取 `CF-Connecting-IP` 头（同义数据源） |
| **金额/汇率计算** | Python `Decimal` + `ROUND_HALF_UP` 到分 | TS 用 IEEE754 double + `round2()`（`Math.round(x*100)/100`）；同一数量级下误差 ≤1e-9，仅在「分」边界可能相差 0.01（登记为差异，未引入 decimal 库） |
| **订单状态机 allowed 列表** | `kaas_common/workstation/state_machines.py:ORDER_NEXT`：`producing → shipped`（不含 cancelled）；worker `main.py` **直接 import 同一张表** | 门面按 worker 实际行为镜像（409 的 `allowed` 是前端契约）。**2026-10-23 F2-1 已收敛**：共享表去掉 producing→cancelled、worker 删除本地第二份表 |
| **SigV4 预签名（files）** | `kaas_common/files/s3.py` 生成 PUT/GET 预签名 URL | **未实现**（`TODO(TODO:TS5)`）：`POST /file-objects/presign` 恒 `{configured:false}`、`GET /{id}/url` 回同形状 `{configured:false,reason}` ⇒ 前端回退代理上传；配了 S3 密钥时 Python 会返回真 URL |
| **文件字节落点** | S3 预签名 → R2 binding → inline | R2 binding → inline（S3 段同上缺口）；`_load_bytes` 的读取优先级与失败兜底逐行对齐 |
| **渲染直链令牌** | `kaas_common/files/token.py`（HMAC-SHA256，`<exp>.<hex>`） | `files.ts` 用 WebCrypto HMAC 逐行镜像（常量时间比较；同 `JWT_SECRET`，TTL 900s） |
| **outreach/generate** | `chain.py:1814` 调 `run_ai_task`（AI 任务链在内核） | 门面**不重写 AI 链**：走 `KERNEL` Service Binding 原样透传（`TODO(TODO:TS4)` 接线前回 503 kernel_error） |
| **outreach 发信** | `chain.py:1608 _send_one` 直连 Resend REST + 回写消息/邮箱/线索 | 同语义逐行直译（`fetch` 代替 Pyodide 的 JS fetch；每日限额/状态回写/幂等抢占一致） |
| **询盘阶段联动** | `inquiry_stage.advance_for_order`（订单创建/完成、出运创建、收款） | **未镜像**（`TODO(TODO:TS6)`）：门面在这些路径上 no-op；手动订单在 Python 侧本来也 no-op，但报价转订单/出运创建会少一次阶段推进 |
| **审计筛选分页** | `page/page_size` 越界**钳位**（audit-log/archive-logs） | 同钳位；但 `accounts` 的 `limit/offset` 越界按 Python 的 `Query(ge/le)` 走 **422** |
| **admin 提案审核错误** | 提案不存在 / action 非法 → **200 + `{error:...}`** | 逐字对齐（不是 4xx —— 前端按 body.error 分支） |
| **query 数值参数的宽容度** | FastAPI `int` 解析：`?page=` / `?campaign_id=` 空串 → **422** | `z.coerce.number()` 把空串读成 0：`page` 类被钳位回 1（结果等价），`campaign_id/lead_id` 则退化为「过滤 0」⇒ 空列表。登记为输入宽容度差异 |

## TODO 标记位置

| 标记 | 位置 | 内容 |
|---|---|---|
| `TODO(TODO:TS1)` | `src/index.ts`（OPENAPI paths）、`src/env.ts`（BROWSER 类型）、`src/routes/*.ts` 头注释 | 手写 zod schema / OPENAPI 待由 Python pydantic 模型代码生成（生成器见 `scripts/generate-zod.mjs`，输出 `src/generated/schemas.ts`） |
| `TODO(TODO:TS2)` | `src/routes/auth.ts` forgot-password 段（约 :258） | 接入 Resend 发信；RESEND_API_KEY 配到 edge 后走真实链路验证 |
| `TODO(TODO:TS3)` | `src/rules.ts` 头注释与波 B 段、`src/routes/{teams,orders,files}.ts` 头注释、`src/session.ts` 头注释 | `rules.ts` 镜像待 KERNEL 暴露 `/internal/rules/*` 后删除改走 kernel.ts；此前不得在别处重写判定（波 B 新增：枚举表、ORDER_NEXT/SHIPMENT_NEXT、files 上传校验与 key 规划） |
| `TODO(TODO:TS4)` | `src/routes/outreach.ts` `POST /outreach/generate` | KERNEL Service Binding 接线（wrangler.jsonc `services` 仍注释）后改成 `callKernel`；未接线时回 503 `kernel_error` |
| `TODO(TODO:TS5)` | `src/routes/files.ts` 头注释、`presign`/`url` 端点 | 实现 SigV4 预签名（对齐 `kaas_common/files/s3.py`）；同时补 S3 读写分支 |
| `TODO(TODO:TS6)` | `src/routes/orders.ts`（status=completed、shipments create） | `inquiry_stage.advance_for_order` 询盘阶段联动未镜像（等内核 `/internal/rules/*`） |

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

当前口径（2026-10-21，Phase 2 波 B 收口实测）：**typecheck 0 error；vitest 12 files / 77 tests 全绿**。
其中波 A 的 45 条（Phase 1 原有 17 + auth 7 / customers 3 / teams 11 + proxy 7）**未回退**；
波 B 新增 **32 条**：orders 8 / files 7 / outreach 6 / admin 11
（每域覆盖：401 鉴权、关键闸门 403/404/409、成功形状与 SQL 谓词/投影）。

> 并行迁移线（workstations / intel / dashboard）的用例与本表**分开计**：工作区里多线并行时，
> 以上数字只代表「波 A+B 自身未回退」，总量以当时 `pnpm.cmd test` 实测为准。
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

- 剩余域按 `backend/ts-migration/route-inventory.md` 继续迁移：**workstations 35 / intel 34 / dashboard 1 / meta 1**
  （门面移植类，共 71 条）；每域金标 diff 全绿为 DoD。
- Service Binding `KERNEL` 绑定（wrangler.jsonc 里已留注释槽）；`/internal/rules/*` 就绪后删除 `rules.ts` 镜像。
- forgot-password 接 Resend（TODO:TS2）。
- 波 B 遗留三项：SigV4 预签名（TODO:TS5）、KERNEL 接线后的 outreach/generate（TODO:TS4）、
  询盘阶段联动（TODO:TS6）。
- ~~上游一致性待内核侧收敛：`ORDER_NEXT` 在 `main.py` 与 `kaas_common/state_machines.py` 不一致~~
  —— **2026-10-23 F2-1 已收敛**：worker 改为 import 共享表，producing 只允许 → shipped（见「语义差异登记」）。

## Phase 2 波 C 语义差异登记（workstations / intel / dashboard，2026-10-21）

| 项 | Python 真源 | TS 门面 | 备注 |
|---|---|---|---|
| 数字类型 | asyncpg：int8→int、numeric→Decimal(float) | postgres.js：BIGINT→string（主键 id 已归一为 number，其余 *_id 保持 string）、Numeric 仍是 string | 根治需在 `src/db.ts` 注册 int8/numeric parser（TODO:TS7） |
| 小型规则镜像 | chain.py:234-250 SUB_CODES / ws_products.py:148-177 订阅 union / ws_workstations.py:77-95 校验 / company_rules.py:15-31 normalize_swift | 暂写在路由文件内并标 Python 行号 | 后续提升进 rules.ts（TODO:TS8） |
| `/api/v1/enums` | kaas_common/domain/enums.py 常量表 | 数据镜像 | 纳入 generate-zod 同一条生成链（TODO:TS1） |
| 历史怪形状保留 | `/spec/categories/{id}` 未命中 → 200 `{error:not_found}`；`/intel/shipments/{id}` 404 detail 为字符串 | 逐字保持 | 未顺手纠正（金标优先保真） |
| render-content 鉴权 | 不挂登录态（走令牌） | 同样不做门面鉴权直接转发 | 与 Python 一致 |
| 36 条引擎透传 | 内部依赖 AI/抓取/ProductSpec/价格生命周期/difflib/PNG | 只鉴权后原样转发 KERNEL（信封同 proxy.ts） | 内核暴露 /internal/* 后才能改移植 |
