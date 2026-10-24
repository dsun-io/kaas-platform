# 路由分类：门面移植 vs 内核透传（W3 Phase 2 执行口径；2026-10-23 复核）

> 依据：docs/OPTIMIZATION_PLAN_2026-10-21.md §2.0（ADR-008 两层架构）+ route-inventory.md（278 业务路由 + 4 内置 = 282）。
> 分类原则：**UI 面 CRUD/鉴权/配置类 → 门面（Hono）逐端点移植；引擎/渲染/AI/cron → Python 内核，
> 门面只做「鉴权 + 协议转换 + 透传」（KERNEL service binding），不逐端点重写**。
> 铁纪律：透传层不得改写业务语义；错误信封统一为 `{error:"kernel_error",message,status}`（5xx）/ 原样透传（4xx）。

## 1. 汇总

| 种类 | 域 | 路由数 | 处理 |
|---|---|---|---|
| **门面注册/移植** | auth 9 / customers 21 / teams 19 / orders 24 / files 9 / outreach 12 / admin 11 / workstations 32 / intel 37 / dashboard 3 / meta 1 / misc 12 | **193** | 业务端点逐条注册；其中 M1/M3/P0-A 新增的 inquiries 详情、item-change、notifications（除 unread-count）、team/approvers、dashboard funnel、dashboard receivables 走**显式透传**（`forwardAuthenticatedKernelRequest`），业务仍在内核；C29 历史订单导入 2 条走**显式透传**（`forwardKernelRequest`，multipart 原样转发）。**P0（2026-10-24）**：products 3 条 GET + notifications/unread-count + approvals 列表共 **5 条只读 GET** 改为「灰度开关 `AUTH_DB_SPLIT`：on 时**门面直连 Hyperdrive（TS-DB）**、off 时仍原样透传」，路由路径/method 不变 |
| **内核透传（前缀 mount）** | quotes 37 / trade-docs 38 / ai 8 / cron 2（events 前缀） | **87** | 12 个前缀 mount（quotes/trade-docs/ai/clause-templates/events/export-quote/external-docs/fx-rates/pricing-data/product-tax-rates/quotations/tax-archives）→ KERNEL.fetch |
| FastAPI 内置 | /openapi.json /docs /redoc 等 4 条 | 4 | 门面自实现（openapi）或不做（docs 内部用） |

合计 **280 业务路由（193 门面注册 + 87 前缀透传）+ 4 内置 = 284**（与 route-inventory.md /
routes.json 核对一致；机检见 tests/route-surface.test.ts 与 tests/openapi.test.ts 的 193/87/280 断言；
2026-10-23 口径：M1 询盘/订单/审批通知 + M3 funnel 落地后由 249 增长；
P0-A A3 再加 1 条 dashboard 应收聚合 ⇐ 274；
C36 #19 再加品名对照 GET/PATCH/DELETE 3 条 ⇐ 277；
C29 再加历史订单导入 POST /imports/orders{,/preview} 2 条 ⇐ 279；
R-D 再加整单导入 GET /import/order/template-info + POST /import/order/preview 2 条 ⇐ 281；
2026-10-24 旧单产品导入端点下线 GET /import/template、POST /import/preview、
POST /import/calculate 3 条 ⇐ 278；
2026-10-24 第三轮 A 客户英文名偏好 2 条显式透传 ⇐ 280）。

> **P0（2026-10-24）计数口径：只改实现分布，不改路由面。**
> `AUTH_DB_SPLIT` 灰度把 **5 条只读 GET** 从「门面注册 + 显式透传内核」改为「门面注册 +
> 开关 on 直连 Hyperdrive」：`GET /products`、`GET /products/{key}/profile`、
> `GET /products/{key}/media`（新文件 `src/routes/products.ts`）、
> `GET /notifications/unread-count`（`src/routes/notifications.ts`）、
> `GET /approvals`（`src/routes/approvals.ts` 内直连读）。
> 因此 **193 直接注册 / 87 前缀透传 / 280 业务 / 284 合计全部不变**；变化的只是这 5 条
> 在「直接注册」里由「透传实现」变为「TS-DB 直连实现（off 回退透传）」。
> 设计依据：`docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md` §3.2 / §8。

## 2. 为什么透传而不是移植

- **禁止第二份实现**（AGENTS 铁纪律）：quotes/trade-docs 的核心是 kaas_common 引擎（报价计算/单证 facts/render），
  在 TS 重写即第二份实现，必然漂移。
- 透传层只做三层职责：① 复用门面鉴权（JWT 校验后转发）；② 路径/头转换（保留 Authorization）；③ 错误信封归一。
- 迁移收益仍兑现：UI 的所有请求都先过门面（冷启动 ~50ms），透传一跳 ~5ms 内，用户无感。

## 3. 透传实现契约（Phase 2 落地）

```
// src/proxy.ts（示意）
app.all('/api/v1/quotes/*', auth, async (c) => {
  const res = await c.env.KERNEL.fetch(new Request(c.req.raw)); // 原样转发（含 body/headers）
  return new Response(res.body, { status: res.status, headers: normalizeCors(res.headers) });
})
```
- 鉴权：透传前门面校验 JWT（与 Python 同一 secret/claims）；**内核仍会二次校验**（双保险，不依赖单层）。
- 金标：透传路由的 diff 应为 0（除 CORS 头统一），纳入 golden harness 清单。
- 禁止：在透传层做参数改写、缓存、重试换语义。

## 4. 门面移植域的执行顺序（每域完成判据）

1. auth ✅（进行中）/ customers ✅（进行中）/ teams（进行中）
2. orders → files → outreach → admin
3. workstations → intel → dashboard/meta

每域 DoD：① 端点与 Python 形状一致（zod schema 从 pydantic 生成，禁止手抄）；② vitest 覆盖关键分支；
③ 金标 harness 对应 case 全绿；④ README 进度表更新。

## 4.1 波 C 注记（2026-10-21）

- workstations(35) 与 intel(34) 中有 **26 条**按路径属该域、按语义属引擎（AI run/抓取/需求指数/ProductSpec 注册表/
  spec 校验与 fingerprint/价格生命周期/option overrides/difflib 近似名/PNG 校验）→ 归入**内核透传**，
  不计入门面移植数。当时（2026-10-21）按路径口径统计的门面移植 188，实际移植 = 188 − 26 = **162 条**，
  透传 = 86 + 26 = **112 条**；最新计数见 §1。
- 内核暴露 `/internal/{product-registry,spec-validate,price-lifecycle,rules/*}` 后，这 26 条可转为门面移植。

## 4.2 P0 热读直连注记（2026-10-24）

事故背景：内核 Pyodide 初始化缺陷导致带 JWT 的只读请求成片 502
（`docs/INCIDENT_2026-10-24_KERNEL_502.md`）。P0 把这 5 条**只读热路径**搬到门面直连
Hyperdrive，SQL / 序列化**逐条直译**自 Python 内核（禁止改写语义）：

| 路由 | Python 真源（SQL + 投影） | 门面实现 | 灰度 id |
|---|---|---|---|
| `GET /api/v1/products` | `ws_files.py:385-431`（注册表 keys + 图片数 + 资料） | `src/routes/products.ts` + `src/product-registry.ts`（标量数据镜像） | `products.list` |
| `GET /api/v1/products/{key}/profile` | `ws_files.py:438-463`（+ `product_names.py` 读时投影、`product_scope.py` 可见性） | `src/routes/products.ts` | `products.profile` |
| `GET /api/v1/products/{key}/media` | `ws_files.py:503-512`（排序 `is_primary DESC, sort_order, id`） | `src/routes/products.ts` | `products.media` |
| `GET /api/v1/notifications/unread-count` | `ws_approvals.py:618-629` | `src/routes/notifications.ts` | `notifications.unread-count` |
| `GET /api/v1/approvals` | `ws_approvals.py:478-572`（view=pending/mine/done + affected_docs） | `src/routes/approvals.ts`（直连读段；写动作仍透传） | `approvals.list` |

- 纯函数镜像（机械直译，TODO(TS3) 待内核暴露 `/internal/rules/*` 后删除）：
  `src/rules.ts` 的 `productInfoAccess` / `nameEnListFromInfo` / `normalizedProductInfo`；
  团队行级谓词在 `src/hot-read.ts`（`ws_files.py:79-107` 两把尺）。
- 错误映射：TS-DB 失败 → `503 {error:"db_unavailable",retryable:true}`（与
  `502 kernel_unavailable` 分开，运维一眼区分「库有问题」与「内核没起来」）。
- **开关**：`AUTH_DB_SPLIT=off|on`（默认 off = 全透传，回退路径）+
  `AUTH_DB_SPLIT_ROUTES` 逗号白名单（按路由 id 前缀段放量）。判定每请求求值，
  路由注册静态 ⇒ 路由面计数不受开关影响。

## 5. 待办

- [x] 透传层（proxy.ts）唯一实现 + 12 个前缀挂载（2026-10-23：`forwardKernelRequest` 统一；intel/workstations 两份重复删除）
- [x] P0 热读直连（2026-10-24）：products 3 条 GET + notifications/unread-count + approvals 列表
      → `AUTH_DB_SPLIT` 灰度（见 §4.2）；off 仍全透传，可一键回退
- [ ] P1：认证域（login/me/logout/change-password/…）+ 剩余显式透传项迁 TS-DB（`docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md` §10）
- [ ] 产品注册表镜像（`src/product-registry.ts`）改为生成物，或内核暴露只读 `/internal/product-registry` 后改走 RPC
- [ ] golden harness 请求清单扩至全部门面域的只读端点（无副作用；需双端环境）
- [ ] W5：MCP server 建立在门面（暴露工位能力 → 映射到上述路由）
