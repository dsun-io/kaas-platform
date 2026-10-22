# KaaS 平台全项目性能优化审计报告（2026-10-22）

> **约束**：部署方式不变 —— GitHub Actions 发布链路（push main 自动触发，wait-for-ci 全绿后 build-frontend → migrate → deploy-kernel → deploy-edge）、双 Worker（`kaas-edge` TS 门面 + `kaas` Python 内核）、前端 Next 16 静态导出。本报告所有建议均在此约束内，不引入新基础设施（除可选的 Sentry / uptime 外部服务，已单独标注需用户提供）。
>
> **方法**：全仓只读代码审计（前端 / TS 门面 / Python 内核 / 稳定性四路并行）+ 既有实测基线（2026-10-21 生产体检、`frontend/out` 产物体积实测、2026-10-22 CI 口径）。证据均带 `文件:行号`，可复跑。
>
> **关联文档**：[PROD_PERFORMANCE_AUDIT_2026-10-21.md](./PROD_PERFORMANCE_AUDIT_2026-10-21.md)（生产体检）、[CI_OPTIMIZATION_2026-10-22.md](./CI_OPTIMIZATION_2026-10-22.md)（CI 口径）、[OPTIMIZATION_PLAN_2026-10-21.md](./OPTIMIZATION_PLAN_2026-10-21.md)（结构债计划）、[STRUCTURAL_DEBT.md](./STRUCTURAL_DEBT.md)。

## 0. 结论速览（TL;DR）

**当前主瓶颈排序（全部可在不动部署的前提下摘除）：**

| # | 瓶颈 | 位置 | 量级 | 可摘性 |
|---|---|---|---|---|
| 1 | Python 内核**每查询新建 DB 连接 + 全串行访问**（全仓 0 处 `asyncio.gather`） | `backend/worker/src` | 热点端到端 **450–600ms** 纯 RTT 叠加 | ★★★★★ 收益最大 |
| 2 | 前端 quotes 页首屏被单证模板 JSON 撑爆 + products 页 2N 请求瀑布 | `frontend/src` | quotes 首屏 **436KB gzip** 含 ~31KB 死重；products 首屏 24 请求 | ★★★★ |
| 3 | **可观测性为零**：Sentry DSN 为空、无 uptime 监控——生产故障只能靠用户报告 | 全局 | 稳定性盲飞 | ★★★★★ 半天搞定 |
| 4 | TS 门面 MCP 单调用 3 条 DB 连接、bcrypt 无限流、无 statement_timeout | `backend/ts-worker` | MCP +2 连接、登录 200–500ms CPU/次 | ★★★ |
| 5 | 数据/文档债务：三处文档数字互相矛盾、WAF 限流无留痕、备份链缺失 | `docs/` + CF dashboard | 误导后续会话、故障无网 | ★★★★ |

**一句话结论**：数据库本身完全健康（最大表 304KB、RTT 75ms），慢的**全是访问模式与交付路径**——内核连接模型是最大单点收益，前端首屏与可观测性是最高性价比的感知/稳定性收益。

**已验证的健康项（无需动作）**：`/_next/static/*` immutable 缓存头已生效；exceljs / pdfjs / msw / react-query-devtools 均已正确懒加载且不进生产首屏；字体自托管；react-virtual 真实使用；侧边栏 `prefetch={false}` 已修复；TS 门面静态资产不进 Worker（Cloudflare 资产层直接伺服）；内核事务/回滚/连接 finally 关闭规范；CI 冒烟与域名门禁质量高于常见水平。

## 1. 现状基线（审计复核过的事实）

- **架构（ADR-008）**：`kaas-edge`（TS/Hono）持两个生产域名 + UI 资产 + 鉴权 + MCP/REST；`kaas`（Python/FastAPI on Pyodide）为内核（报价/单证引擎、AI、cron 3 条），仅经 Service Binding 调用。业务规则只在 Python 内核一处实现。
- **冷启动**：门面 ~25ms；内核 ~4.7s（Pyodide 引导 + ~920KB 源码编译；ws_* 路由注册无法整体惰性化，属结构性成本）。
- **数据库**：Neon 新加坡（`cold-king-20466417`），经 Hyperdrive；本机实测 RTT 75ms；全库 127 行/最大表 304kB；索引基本在位。
- **前端**：Next 16.4.2 + React 19.3，`NEXT_EXPORT=1` 静态导出；`public/_headers` 已对 `/_next/static/*` 设 immutable；React Query staleTime 30s、retry 1、无轮询；axios 对幂等请求 3 次指数退避。
- **已闭环的历史问题**（本次不再列为待办）：导航挂死（prefetch）、Windows 构建逐段预取 404、`refetchOnWindowFocus`、DB 迁亚太、CI 瘦身、登录 429（CF zone 规则放宽至 5 次/10s/IP）。

## 2. 响应速度

### 2.1 Python 内核（收益最大：热点端到端延迟预计降 50–70%）

#### P0-1 每查询一条新连接 + 全串行 DB 访问

**证据**：`platform/db.py:31-49` 与 `main.py:282-299` 的 `acquire` 每次调用都 `asyncpg.connect` 到 Hyperdrive；`db.fetch/fetchval/fetchrow/execute` 各自独立开关连接。全仓 grep **0 处 `asyncio.gather`** —— 所有可并行的查询全部串行。以 Neon SG、RTT ~75ms 估算：

| 端点 | 连接数 | 串行 RTT |
|---|---|---|
| `get_order_api`（main.py:3925-3967） | auth 1 + 6 | ~525ms |
| `list_quote_orders`（quote_api.py:1764-1792） | auth + count + rows + 计数 + 2 锁查询 | ~450ms |
| `dashboard/summary`（main.py:1962-1984） | 7（单连接内串行） | ~525ms |
| `get_trade_doc_render_data`（main.py:5458-5530） | 6–10 | ~600ms |

**修复**：端点内统一 `async with _acquire(request) as conn`，独立查询改 `asyncio.gather`；`dashboard` 的 6 个 `COUNT(*)` 合成 1 条标量子查询 SQL。属纯连接管理重构，不碰业务规则（ADR-008 边界内）。
**风险**：低——需守金标 harness 全绿（`backend/ts-migration/golden/`）；连接生命周期变化要防泄漏（沿用现有 finally close 模式）。

#### P1-1 三处 N+1（被新连接模型放大）

| 位置 | 问题 | 修复 |
|---|---|---|
| `ws_crm_ext.py:262-272` | `list_customer_inquiries` 每询盘一次 `db.fetchval`（每次新连接）→ 20 询盘 = 20 连接 | `SELECT DISTINCT inquiry_id FROM quote_orders WHERE inquiry_id = ANY($1)` 一条 |
| `main.py:4753-4770` | trade-docs 列表每行一次存在性查询 | 同上，ANY 半连接一条 |
| `quote_api.py:1894-1896` | `/quotes/batch` 最多 200 组 × 每组 `create_quote_order`（2 连接 + 事务内 ~5 查询）≈ **1000+ 顺序 RTT**，必然撞 Worker 时限 | 批量只锁一次汇率、共享连接、`gather` + 信号量限流 |

#### P1-2 列表 SELECT * 拉大列

- `main.py:4749`（trade-docs 列表拉 `raw_payload` JSONB）、`main.py:2896`（events payload）、`ws_files.py:993-998`（`resolve_photo_refs` 每张图 SELECT `content` bytea，即使走签名 URL 不需要字节——一张 PI 曾内联 1.4MB，代码注释自述）。
- **修复**：列表显式列；photo 先取 URL 所需列，仅回退路径取字节。

#### P1-3 缺 3 个复合索引（对照 83 个 alembic 迁移）

- `cust_inquiries` 列表 `WHERE tenant_id ORDER BY customer_id, created_at DESC`（ws_crm_ext.py:288-310）无复合索引，现有 `(tenant_id,status)`/`(customer_id,status)` 不覆盖排序 → 每页 sort。
- `quote_orders`/`orders` 列表 `ORDER BY created_at DESC` 无 `(tenant_id, created_at)` → count(*) 全扫描 + sort（现有 `(customer_id, created_at)` 只在带 customer 过滤时命中）。
- **修复**：新增 alembic 迁移补索引（生产库几 MB，`CREATE INDEX CONCURRENTLY` 秒级；migrate 已在发布链路内，无需改部署）。

#### P1-4 贸易文档内核 eager import（冷启动）

`kaas_common/trade_doc/__init__.py:17-182` 一次性 import 全部 13 个子模块（共 232KB）。Python 语义决定：任何 `from kaas_common.trade_doc.X import Y`（main.py:4569、ws_cron.py:51 等）都会先执行包 `__init__` —— **报价引擎已惰性化，贸易文档内核没有**。
**修复**：`__init__` 改 PEP 562 `__getattr__` 懒导出，预计冷启动省 100–200ms 解析 + 相应 CPU。
**注意**：`backend/kaas_common/` 是唯一源，改完必须跑 `scripts/sync-shared.ps1`。

#### P2 项（内核）

- `quote_api.py:1359-1381` `_insert_quote_items` 逐行 INSERT（上限 2000 行）→ `executemany` 或单条多 VALUES。
- `ws_workstations.py:326-362` 每请求解两次 JWT（中间件 + `_get_current_user`），user 挂 `request.state` 复用。
- `ws_cron.py` cron 无并发保护（CF 不保证同一 cron 不重叠）：`pg_try_advisory_lock` 守卫；`archive_events_for_day`（:344-400）无 LIMIT/分批，整日 events 载入内存再 gzip——当前 246 行无感，增长后会爆，改 id 游标分批。
- 无瞬时错误重试：Hyperdrive/Neon 故障切换期连接失败直接 500 → 只读端点包 1–2 次指数退避。
- `scan_replied_leads`（*/15）对 0 新增是浪费：改事件驱动（触达回复触发）或先 `EXISTS` 预检。
- `main.py:259` 一处 `traceback.print_exc` 改 `logger`。

### 2.2 前端（Next 16 静态导出内可做的最大感知收益）

#### P0-1 quotes 页首屏被单证模板 JSON 撑爆

**证据**：`quote-workbench-view.tsx:42` 静态 `import { getAvailableTemplates } from "@/lib/trade-doc/render"`；而 `render.ts:28-29` 顶层静态 import `manifest.json`（59.8KB）+ `assets.json`（71.4KB）——quotes 页只用模板名清单，18 份 HTML 模板正文完全用不到。实测 `out/_next/static/chunks/1bvmklhoht6qe.js` = **150.7KB raw / 30.8KB gzip** 以 `<script async>` 出现在 quotes.html 首屏；**quotes.html 首屏 JS 合计 1.42MB raw / 436KB gzip**（login 页 860KB/277KB 为框架基线）。同源问题影响 `settings/company-profile/components/clause-templates-card.tsx:32`。
**修复**：render.ts 拆出 `templates-meta.ts`（仅名称数组 <2KB），quotes 与 company-profile 改引 meta 模块；`quotes/page.tsx:8-12` 静态并列 import 的四个 tab 中 records/bulk/pricing 三个用 `next/dynamic` 懒挂载。预计 quotes 首屏 **-31KB gzip 死重 + 再省 60–100KB gzip**。

#### P0-2 products 页 N+1 请求风暴 + 原图全量下载

**证据**：`product-card.tsx:29` `useProductMedia(product.key)` 与 `:32` `useFileObjectUrl(primary?.id)`——**每个产品卡各发 2 个请求**；`products/page.tsx:111-131` 对全部产品 map。12 个产品 → 首屏 **24 个请求** + 最多 12 张 R2 原图（手机拍照级可能数 MB）；`images.unoptimized=true` 无缩放；`product-card.tsx:50-54`、`product-images.tsx:183` 的 `<img>` 无 `width/height`、无 `loading="lazy"`（CLS + 带宽）。
**修复**：卡片缩略图改可见时才取（IntersectionObserver + enabled 门控）或列表接口直接带主图 presigned URL（`ProductRow.media_count` 已存在，后端可扩展）；img 补 `loading="lazy" decoding="async"` 与尺寸。

#### P1-1 Sentry SDK 在 DSN 为空时仍进每个页面首屏

**证据**：`global-error.tsx:3` 顶层静态 `import * as Sentry from '@sentry/nextjs'`（根错误边界 chunk 必进首屏）；实测 `chunks/3tq7diqiehq3y.js` = 11KB raw / **3.8KB gzip** 出现在 index.html 及所有页面；`.env.production:3` `NEXT_PUBLIC_SENTRY_DSN=` 为空 ⇒ `instrumentation-client.ts:8` 与 `lib/error/sentry.ts` 的懒加载设计全部落空。
**修复**：global-error.tsx 改用 `@/lib/error/sentry` 的懒加载 `captureException`（封装已存在）。每页省 3.8–5KB gzip 死代码。（配 DSN 的完整方案见 §4 P0-1。）

#### P1-2 customers 页巨型 client 组件 + 双份 DOM

`customers/page.tsx` 共 **1675 行、`"use client"`**；`:1580` 桌面表格与 `:1629` 移动端卡片对同一 `listData.items` 各 map 一遍（CSS 隐藏但 DOM 双份），无虚拟化、无分页。100 客户 → 200 个行节点 + 双份事件绑定；筛选/搜索输入触发整页重渲染。
**修复**：抽出行组件 + `React.memo`；移动端列表改 CSS 生成或单数据源双视图；客户量大时分页（后端 `/customers` 已支持分页参数）。

#### P1-3 上游选项接口全量拉取

`use-upstream.ts:90`（orders `page_size: 100`）、`:104`（quotes 100）、`:115`（customers 200）。orders 页列表本身只展示 20 条/页，却额外拉 100 条报价 + 100 条订单 → 每页多 50–200KB JSON（随数据增长）。
**修复**：下拉选项专用轻量接口（id+名称两列）或下调 page_size + 服务端搜索（`useCustomerSearch` 已有正确范式）。

#### P2 项（前端）

- `auth-context.tsx:233-243` value 未 memo，每次渲染新建对象 → 全部消费者连带重渲染（改 `useMemo`）。
- 品牌 PNG 未优化：`public/assets/brand/logo.png` 58.7KB、`logo-lockup.png` 64.9KB，侧边栏每页加载 → SVG/WebP。
- 非侧边栏 Link 用默认 prefetch（如 `customers/page.tsx:1204`）：静态导出 auto-prefetch 会后台拉目标路由 RSC+JS，可能预拉 150KB+ 的 quotes chunk → 重型跨页链接显式 `prefetch={false}`。
- `flush-worker.ts:22-35` 事件逐条串行 POST（10 条 = 10 个串行请求）→ `Promise.allSettled`。
- `use-products.ts:328-330` 不回收 objectURL，长时间停留产品页有内存泄漏。
- `(app)` 下 26 个路由只有 6 个有分段 error.tsx（见 §4 P2-2）。

### 2.3 TS 门面（kaas-edge）

**架构面健康**：全局中间件仅 CORS + apiTokenScopeMiddleware（非 `/api/` 立即放行）；静态资产由 Cloudflare 资产层直接伺服、不进 Worker；jose HS256 验签 μs 级无需缓存；`/health?deep=1` 深探针设计良好（默认浅探针不放大内核冷启）。

#### P1-1 MCP 每次工具调用建立 3 条 DB 连接且 `last_used_at` 双写

链路：`mcp.ts:490 authenticate → resolveActor → resolveApiTokenActor`（actor.ts:70，withDb #1：SELECT api_tokens + UPDATE last_used_at）→ `callRest` 用 `app.request()` 内部回打 REST（mcp.ts:104）→ scope 中间件**再次** `resolveApiTokenActor`（scope-map.ts:191，withDb #2 + 第二次 UPDATE）→ 业务路由 `requireUser → requireUserForApiToken`（session.ts:84，withDb #3）。每次 `withDb` 都 `postgres()` 新建 TCP 连接再 `sql.end()`（db.ts:22-50）。
**修复**（协议层，合规）：MCP handler 内把已解析 actor 经内部凭据随 `app.request` 传入，让 scope 中间件识别"已验证内部调用"跳过二次查库——与 `proxy.ts:32-49` 已有的内部 JWT 凭据转换同一模式。

#### P1-2 登录无速率限制 + bcryptjs cost 12

`session.ts:20` `BCRYPT_ROUNDS = 12`；login/register/change-password/reset-password/bootstrap 均跑 bcryptjs（纯 JS，Workers 上 cost 12 ≈ **200–500ms CPU/次**，无原生 bcrypt 属客观约束）。且全仓 **0 处 rate limit**：口令爆破直接烧 Workers CPU 配额 + 邮箱枚举可低成本进行。
**修复**：CF Rate Limiting 规则/WAF 或 wrangler ratelimit binding（配置层，不碰业务）；forgot/reset 按 email 限次。**注意**：zone 侧现有 5 次/10s/IP 规则只存在于 CF dashboard，仓库无留痕（见 §4 P1-4）。

#### P1-3 postgres 连接无 `statement_timeout` / `connect_timeout`

`db.ts:24-35` 只设 `max:1 / prepare:false / fetch_types:false`。慢 SQL（如 `dashboard.ts:53-67` 的 7 条全表 `count(*)`）或异常查询会无限期占用连接；Hyperdrive 侧不兜底语句超时。
**修复**：`postgres({ connection: { statement_timeout: "10s" } })`——一行改动，连接管理壳参数。

#### P2 项（门面）

- 单请求多次 `withDb`（login = users + teamNameOf 两条连接；`GET /customers` = requireUser + 业务查询两条）→ handler 外层一个 withDb 包住。
- **4 份内核转发实现且行为不一致**（proxy.ts / intel.ts:151 / workstations.ts:87 / outreach.ts:409）：intel/workstations/outreach 转发**原始 Authorization**，API token 请求会把 `kaas_oat_` 发给内核 → 401（token 用不了引擎端点）；proxy.ts 则铸造内部 JWT。收敛到 `kernel.ts` 单一 `forwardKernelRequest(c)`。
- 内核 5xx 时把错误原文 `text.slice(0,500)` 塞进响应 message（proxy.ts:128-131 等 4 处）→ 统一 `kernel_error` 信封，原文进 `console.error`。
- `kernel.ts:65`/`proxy.ts:121` 无超时/重试/熔断：内核冷启 ~4.7s 边缘同步等待（Service Binding 无客户端超时控制）。**不建议** TS 侧重试（POST 不幂等）；守边界做法 = 内核 cron 自探温 + 对 502/503 `kernel_error` 比例告警。
- 日志无请求上下文（`console.error(err)` 无 URL/method/request id）→ 中间件生成 request id 写 `X-Request-Id` + 结构化日志；可选 Sentry Workers SDK。
- MCP `resources/read kaas://openapi` 每次全量重建 OpenAPI（mcp.ts:326-345）→ 复用 `/openapi.json` 已有惰性单例（index.ts:172-177）。
- API GET 响应无 `Cache-Control`/ETag（租户/团队隔离下共享缓存不可用——`caches.default` 全仓未用是对的）；可加 `private, max-age=60~300` 浏览器级缓存；file-objects content 已有 sha256 列，可补 ETag→304。
- `db.ts:47-49` `finally { await sql.end() }` 若 end() 抛错会掩盖业务异常 → 包 try/catch。

### 2.4 数据库

**体检结论不变**：Neon SG 健康（最大表 304kB、连接 12/901、无锁竞争），Hyperdrive 代池模式正确。动作只有两项：补 §2.1 P1-3 的 3 个复合索引；`pg_stat_statements` 免费档未装，热点 SQL 定位靠上面的静态分析 + 上线后 `wrangler tail` 抽样。

## 3. 用户体验

**已闭环（2026-10-21/22）**：导航挂死（prefetch）、静态导出预取 404、回到标签页不刷新（`refetchOnWindowFocus: true` + `refetchOnReconnect: true`）、UI/UX 方案 P0/P1/P2、a11y 路由自动发现。本节只列**仍影响体感**的项。

| ID | 问题 | 证据 | 修复 | 收益 |
|---|---|---|---|---|
| U-1 | **登录过期硬跳转丢表单**：JWT TTL 24h 无 refresh，到期后任意请求 401 → toast + `window.location.href` 跳登录，正在填的表单/未保存内容丢失 | `session.ts:34`（TTL 24h）、`error-handler.ts:81-89` | 短期：401 时把当前 URL + 未保存表单态带上去，登录后恢复；中期：sliding refresh token 或延长 TTL + 静默续期 | 消除"填半天丢半天"的最差体验 |
| U-2 | products 页加载体验：2N 请求瀑布 + 原图慢 + 无 lazy/尺寸（= §2.2 P0-2） | 同左 | 同左 + 骨架屏已在则确认不被瀑布拉长 | 首屏可见时间与 CLS |
| U-3 | quotes 页首屏慢（= §2.2 P0-1） | 同左 | 同左 | 最重页面首屏 -60~130KB gzip |
| U-4 | rememberMe 名不副实：cookie 30 天但 token 只有 24h | `token-store.ts:99` vs `session.ts:34` | 勾选 remember 时签发长 TTL token（或 refresh 机制落地后自动解决） | 少一次被迫重新登录 |
| U-5 | 多标签页 session 不同步：单标签登出不传染其他标签；各标签各自 401 各自跳转 | session 模块级缓存，无 `storage` 事件监听 | 登出时写 localStorage 广播，其他标签监听后清跳 | 少一次"幽灵会话" |
| U-6 | 无离线态提示：仅 flush-worker 监听 `online`，网络中断无 UI 反馈 | `flush-worker.ts:85` | 全局离线 banner（navigator.onLine + online/offline 事件） | 断网不再像"卡死" |
| U-7 | 错误边界覆盖不足：`(app)` 26 个路由只有 6 个有分段 error.tsx，其余靠根边界整页替换 | §4 P2-2 | 热点路由（customers/orders/quotes/trade-docs/research）补分段边界 + 全部接 Sentry | 局部错误不整页赶走用户 |

## 4. 稳定性与可观测性

### P0-1 生产 Sentry 全盲（线上前端错误 0 上报）

**证据链**：`frontend/.env.production:3` `NEXT_PUBLIC_SENTRY_DSN=` 空 ⇒ `instrumentation-client.ts:8` 无 DSN 时**根本不加载 SDK** ⇒ `lib/error/sentry.ts` 的 `captureException` 全部静默丢弃。叠加：只有 `global-error.tsx:12` 一个边界会上报（6 个分段边界不上报）；`next.config.mjs:37-38` 读 `SENTRY_ORG/PROJECT` 但全仓无任何地方设置；`sourcemaps.disable:true`；**生产构建在 `deploy.yml` 的 build-frontend job，未注入 `SENTRY_AUTH_TOKEN`**（只有 frontend-ci.yml push 时注入，那条链路不产出上线产物）。
**影响**：线上 JS 错误、接口 5xx、渲染崩溃全部不可见——生产故障只能靠用户报告。
**修复（需用户提供 Sentry 项目）**：① 建 Sentry 项目（免费档 5k errors/月够用）拿 DSN；② `deploy.yml` build-frontend 步注入 `NEXT_PUBLIC_SENTRY_DSN` + `SENTRY_ORG/PROJECT/AUTH_TOKEN`；③ 开启 sourcemap 上传（`sourcemaps.disable:false`）；④ 6 个分段 error.tsx 补 `captureException`。**属构建期环境变量注入，不改变部署方式。**

### P0-2 无 uptime 监控/告警

全仓无 UptimeRobot/Healthchecks/Better Stack 痕迹；日志只有 `wrangler tail` 实时流，无留存无聚合。Worker 挂了我方不知道。
**修复**：任一免费外部探针打 `https://kaas.powervoy.com/health`（浅探针，不放大冷启）+ `?deep=1`（低频，如 5 分钟一次）→ 失败通知到邮件/IM。零代码。

### P1-1 两个 `/health` 都不查数据库

DB 挂了两个探针全绿（`docs/archive/2026-09-30-doc-cleanup/SYSTEM_AUDIT.md` 9 月已登记同类"监控失明"，双 Worker 后依然存在）。
**修复**：deep 探针加一条 `SELECT 1`（走 Hyperdrive），失败即 503。浅探针保持不动（避免放大内核冷启）。

### P1-2 无自动回滚 + 内核/门面混合版本窗口

smoke 失败只让 pipeline 变红，生产保持故障版本直至人工 `wrangler versions deploy`；回滚必须成对（先回门面再回内核，避免新门面调旧内核），命令散落在 README §5 / DEPLOY.md §0.1 / HANDOVER，无集中 runbook。
**修复**：DEPLOY.md 增「回滚 runbook」集中节（成对步骤 + 验证清单）；可选：deploy.yml smoke 失败后自动 `wrangler rollback`（需用户确认是否授权自动回滚——破坏性策略，按 AGENTS.md 规则 2 拍板）。

### P1-3 备份链缺失

`pg_dump → R2` 只存在于归档计划，scripts/ 内无任何备份脚本/cron；生产回滚依赖 Neon PITR/分支快照，免费档保留期无文档确认。
**修复**：内核 cron 已有触发器，加一条每日 `pg_dump -Fc → R2`（或用 Neon API branch 快照）+ DEPLOY.md 写明保留期。Worker cron 属现有部署方式内的改动。

### P1-4 WAF 限流规则无仓库留痕

2026-10-21 登录 429+26s 的根因（zone 侧 auth 端点限流）已放宽至 5 次/10s/IP，但**规则只存在于 CF dashboard**——未来会话不可见、可能漂移；`/health?deep=1` 无鉴权可触发内核冷启动（HANDOVER:62 登记为接受的风险，但未加 CF 限流）。
**修复**：把 WAF 规则口径写进 DEPLOY.md；deep 探针加 CF Rate Limiting。

### P1-5 文档债务（会误导后续会话）

**测试数字**：`README.md` 与 `docs/README.md` 已于 2026-10-22 并行刷新为实测值（ts-worker **232/23 文件**、worker **1616+12skip**、orchestrator 258、前端 **1051/125 文件**、e2e 27）——**唯一遗留矛盾是 `AGENTS.md`**（仍写 ts-worker 208/22、worker 1565+12、前端 934/110）。
**修复**：AGENTS.md §门禁按实测值更正并注明抓取日期（按 AGENTS.md 规则 1，这是文档债务不是小偏差）。

**部署口径**：`deploy.yml` 已于 `cea531d`（2026-10-22）恢复 **push main 自动部署**（wait-for-ci 全绿后发布）；`README.md:48` 已同步，但 **`DEPLOY.md:22,312-313,337,354` 仍写"自动部署冻结 / 仅 workflow_dispatch / push 不触发部署"**——口径过期，需同步。本审计报告的"保持部署方式不变"即按现行口径（push main 自动发布 + 手动 dispatch 排障，先内核后门面）。

### P2 项（稳定性）

- `wait-for-ci` 有 30 分钟超时与 CI 红拒部署，但 `sleep 120` + 3 次空轮询（90s）后**直接放行**（deploy.yml:89-95）——CI 注册延迟时可能未等先发，竞态。
- 冒烟无认证链路：只验 401，不跑登录/写路径，业务级回归靠人工。
- 无 DELETE 端点：`lead_candidates` 只能直接改库清理（DEPLOY.md:115-123），E2E 中断即残留。

## 5. 分级行动清单（汇总）

> 全部项均不改变部署方式：代码走现有 CI 门禁 + deploy.yml；CF dashboard 改动属配置；Sentry/uptime 需用户提供账号（已标注）。

### P0 包（建议先做，合计 ~2–3 人日；收益/成本比最高）

| # | 项 | 层 | 预期收益 | 风险 |
|---|---|---|---|---|
| 1 | 内核端点级单连接 + `asyncio.gather`（orders 详情 / quotes 列表 / dashboard / render-data）；dashboard 6 COUNT 合一 | worker | 热点端到端 **-50~70%**（450–600ms → 150–250ms 量级） | 低（金标 harness 兜底） |
| 2 | quotes 模板 meta 拆分 + records/bulk/pricing tab `next/dynamic` | frontend | quotes 首屏 **-60~130KB gzip** | 低 |
| 3 | products img `loading=lazy`+尺寸+可见性门控取媒体 | frontend | 首屏 24 请求 → 视口内请求；CLS 降 | 低 |
| 4 | global-error 改懒加载 captureException | frontend | 每页 -3.8~5KB gzip | 低 |
| 5 | **Sentry 打通**（DSN + deploy.yml 注入 + sourcemap + 分段边界上报） | frontend/CI | 生产错误从 0 可见 → 全可见（**需用户建 Sentry 项目**） | 低 |
| 6 | deep health 加 `SELECT 1` | ts-worker/worker | DB 故障不再被探针漏过 | 低 |

### P1 包（~1 周）

| # | 项 | 层 | 预期收益 |
|---|---|---|---|
| 7 | N+1 ×3 改 ANY 批量；`/quotes/batch` 共享连接 +  gather + 信号量 | worker | 询盘列表 20 连接 → 1；batch 从必超时 → 可完成 |
| 8 | 补 3 个复合索引（新 alembic 迁移） | worker/DB | 列表 count+sort 从全扫描 → 索引 |
| 9 | trade_doc `__init__` PEP 562 懒导出（改完跑 sync-shared.ps1） | worker | 冷启动 -100~200ms |
| 10 | MCP 单调用 3 连接 → 内部凭据传递跳过二次解析 | ts-worker | MCP -2 连接 + 去掉双写 |
| 11 | `statement_timeout: "10s"`；登录 CF Rate Limiting（含 deep 探针） | ts-worker/CF | 坏查询不再拖死；防爆破烧 CPU |
| 12 | JWT 401 携带返回点 + 短期表单恢复；评估 refresh | ts-worker/frontend | 消除过期丢表单（U-1） |
| 13 | pg_dump → R2 每日 cron + 保留期写入 DEPLOY.md | worker | 备份网 |
| 14 | 统一三处文档测试数字 + 部署口径（README/DEPLOY/HANDOVER） | docs | 后续会话不被误导 |

### P2 包（按需排期）

15. customers 页拆行组件 + memo + 分页（前端）｜16. options 轻量接口或降 page_size（前后端）｜17. 内核 4 份转发收敛 + 5xx 脱敏 + request id 日志（门面）｜18. OpenAPI 惰性单例复用、private Cache-Control、ETag 304（门面）｜19. cron advisory lock + archive 分批 + 只读重试 + replied-scan 预检（内核）｜20. logo→WebP/SVG、AuthContext memo、flush 并行、objectURL 回收（前端）｜21. 分段 error 边界补热点路由 + 离线 banner（前端）｜22. 回滚 runbook 集中 + 自动回滚拍板（部署文档）｜23. wait-for-ci 竞态修复（CI）｜24. items executemany、JWT 双解复用（内核）

## 6. 建议实施路线图（部署方式不变）

```
第 1 步（0.5 天）可观测性先行：P0-5 Sentry + P0-2 uptime + P0-6 deep SELECT 1
        ↓ 先看得见，再动手——后面每项优化都有前后对比数据
第 2 步（1–2 天）内核延迟摘桃：P0-1 单连接+gather → 上线 → wrangler tail 前后对比
        ↓ 最大单点收益，先摘
第 3 步（1 天）前端感知：P0-2/3/4 + P1-1（Sentry 死代码）
        ↓ 首屏与请求数
第 4 步（3–5 天）P1 包：N+1 / 索引 / 懒导出 / MCP / 限流 / JWT / 备份 / 文档统一
        ↓ 每项独立 PR，门禁全绿后随 deploy.yml 发布
第 5 步（按需）P2 包逐项
```

**发布方式不变**：所有代码改动合并 main 后由 deploy.yml 自动发布（wait-for-ci 全绿 → build → migrate → 先内核后门面）；docs-only 改动不触发部署。**回滚方式不变**：`wrangler versions` 成对回滚（先门面后内核）。

## 7. 验证口径（每项上线后复测）

| 指标 | 现状基线 | 目标 |
|---|---|---|
| 热点 API 端到端（orders 详情/quotes 列表/dashboard） | ~450–600ms（静态估算） | ≤250ms |
| quotes 页首屏 JS | 1.42MB raw / 436KB gzip | ≤360KB gzip |
| products 首屏请求数 | 2N+1 | 视口内 |
| 生产前端错误可见性 | 0（Sentry 盲） | 100% 上报 |
| DB 故障时 /health?deep=1 | 绿（漏报） | 503 |
| 内核冷启动 | ~4.7s | ~4.5s（P1-4 边际改善；根治挂起，见 STRUCTURAL_DEBT D6） |
| 登录 P95 | 4–7s（2026-10-21 实测） | <3s（随内核优化 + 限流） |

复测方法：`curl -w` 采样生产端点（每端点 ≥10 次取 P50/P95）；前端用 `out/` 产物体积 + Playwright 网络计数；Sentry 上线后以事件流验证。

## 8. 附录：本次审计未覆盖 / 明确不做

- **冷启动根治**（Pyodide 引导 + 920KB 源码编译）：结构性成本，已挂起待用户决定（STRUCTURAL_DEBT D6 / A-11）；本报告 P1-4 只做边际改善。
- **API 层迁 TS 重写**：大工程，需立项，不在本报告范围。
- **Cloudflare Cache Rules 静态资产长 TTL**：`_headers` immutable 已覆盖 `/_next/static/*`，收益边际；`/assets/*` 可一并加（P2）。
- **Smart Placement 实测**：一次部署可回滚，可作为 P2 实验项。
- 业务功能缺口（W5 MCP/REST 设计、询盘订单模型重构 M1–M3）：见各自计划文档，与性能无关不在本报告。

---

*审计人：lead（DSH AI），2026-10-22。全部为只读审计，未改动任何生产配置；引用的实测数据来自 2026-10-21 生产体检与本轮 `out/` 产物体积测量。*
