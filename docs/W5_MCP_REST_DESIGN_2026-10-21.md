# W5 对外能力设计：MCP + REST 双暴露（2026-10-21）

> **进度**：M1 ✅（api_tokens 迁移+门面管理端点，生产实测通过）；M2 ✅（`src/openapi.ts` 自动生成 OpenAPI 3.1：
> 141 path/227 operation、12 透传 mount、bearerAuth+apiToken 双 scheme，生产 `/openapi.json` 301KB + `/docs` 可用）；
> M3 ✅（MCP server + token 接入业务路由，生产验证通过）；M4 ✅（对外文档 `W5_EXTERNAL_USAGE_2026-10-21.md`）；
> **UI 令牌管理页 ✅（2026-10-21 上线 `/settings/api-tokens`：列表/创建/一次性明文/撤销，前端门禁全绿 + e2e 27 过）**。
> **W5 全部完成**。剩余登记项：token 逐次审计日志、MCP SSE、更多 tools/resources（后续按需）。
> 实施细节与实测坑见 PROBLEM_STATUS 与 backend/ts-worker/README。

> 用户拍板（2026-10-21）：对外能力形态 = **MCP + REST 双暴露**；建在 **TS 门面**（ADR-008），
> 复用门面鉴权，不在 Python 内核另起一套。本设计在 W3 Phase 2 完成后开工。

## 1. 场景

- 脚本/CI 调用系统功能：REST（OpenAPI 文档 + API token）。
- AI agent 发现并调用工位能力：MCP（tools/resources/prompts）。
- 两者共用同一套鉴权与同一批业务端点（REST 是底座，MCP 是对 REST 的语义化封装）。

## 2. 鉴权模型（新增 API token，不动 JWT 体系）

| 项 | 设计 |
|---|---|
| token 形态 | `kaas_oat_<随机32字节base64url>`（oat = outbound access token），**只存哈希**（sha256）+ 前缀明文用于识别 |
| 存储 | 新表 `api_tokens`（id/tenant_id/team_id/name/scopes/token_hash/prefix/created_by/created_at/expires_at/last_used_at/revoked_at）；迁移走 alembic |
| 权限范围 | `scopes`：如 `customers:read,customers:write,quotes:calc,trade_docs:read,...`；映射到工位（workstation）粒度 |
| 鉴权中间件 | 门面新增 `requireApiToken(scopes)`：`Authorization: Bearer kaas_oat_...` → 查哈希 → 校验 scope → 注入 tenant/team 上下文 |
| 与 JWT 关系 | 同一 Bearer 头；有 `kaas_oat_` 前缀走 API token，否则走 JWT（UI 会话） |
| 管理入口 | UI 设置页「API 令牌」：创建（一次性显示）/吊销/看 last_used；对应门面 REST `/api/v1/api-tokens` |
| 铁律 | token 明文只显示一次、不入日志；破坏性操作（吊销）在 UI 内自我服务，不需 DSH 干预 |

**scope 映射实现口径（M3；2026-10-24 补充）**：规则表在 `backend/ts-worker/src/scope-map.ts`，
按「method + path 前缀」**有序**匹配（更具体的前缀必须排在泛前缀之前），**未命中任何规则
= 403 `SCOPE_NOT_DECLARED`**。注意**读/写语义按端点是否落库判断，不能按 method 一刀切**：
`POST /api/v1/trade-docs/preview-render-data` 只装配渲染数据、**不落库**，所以映射
`trade_docs:read`（否则只读 token 调预览会被误判为写操作而 403）；其余
`POST /api/v1/trade-docs*`（建单/签发等）仍是 `trade_docs:write`。新增端点时先确认
它是否写库，再决定映射哪个 scope。

## 3. REST 规整（OpenAPI 真源）

- 用 `@hono/zod-openapi` 从**生成的 zod schema**（`src/generated/schemas.ts`）产出 OpenAPI 3.1；
- `/openapi.json` 由门面显式服务（Python 版在 CF 下退化成 text/html，金标已登记为有意差异）；
- `/docs` 用轻量 swagger-ui 静态页（CDN 或本地资产，二选一，避免 worker 内跑重 UI）；
- 分页/错误信封沿用现有契约（`{items,total,page,page_size}` / `{detail:...}`），不另造。

## 4. MCP 实现（Cloudflare 原生）

| 项 | 设计 |
|---|---|
| 传输 | Streamable HTTP（`/mcp`，POST/GET SSE），Cloudflare Agents SDK 的 MCP 支持为候选 |
| 鉴权 | 同 §2 API token（MCP client 用 Bearer）；scope 决定可见 tools |
| Tools（首期 8 个） | `customers.list/search/create`、`inquiries.list/create`、`quotes.calculate`（透传 KERNEL）、`trade_docs.list/get`、`orders.list` |
| Resources | `kaas://workstations`（工位清单）、`kaas://customers/{id}`（只读档案） |
| 输入 schema | 复用 zod（REST 同一模型）→ MCP tool inputSchema，不手写第二份 |
| 安全 | 默认只读 scope；写工具需显式 scope；所有调用写审计（复用 events 表/审计日志） |

## 5. 里程碑

1. M1（0.5 周）：`api_tokens` 表 + 鉴权中间件 + 管理 REST + UI 设置页 → 可用 REST token 调通现有门面端点。
2. M2（0.5 周）：`@hono/zod-openapi` 接线 + `/openapi.json` + `/docs`。
3. M3（1 周）：MCP server 首期 8 tools + 2 resources + 审计；按 scope 裁剪工具可见性。
4. M4：文档（外部调用示例：curl / MCP client 配置）+ 验收。

## 6. 验收

- REST：外部脚本用 token 调 `GET /api/v1/customers` 成功、超 scope 403、吊销后 401。
- MCP：MCP inspector / Claude 类客户端连 `/mcp`，`tools/list` 只见 scope 允许项，`customers.list` 返回与 REST 同形状。
- 审计：每次 token 调用在 events/审计日志可查（actor=token id）。

---

*草案由 lead 起草 2026-10-21；开工前若涉及新表/新端点需按 AGENTS 规则先落 ADR 与 TODO 登记。*