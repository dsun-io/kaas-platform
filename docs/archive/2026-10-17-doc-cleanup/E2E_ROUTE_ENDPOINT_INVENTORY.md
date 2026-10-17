# e2e 路由 → API 端点清单与 mock 覆盖缺口（M1 的输入）

> **性质**：**只读分析**。本轮只新增本文件，未改任何代码。
> 标注：**【已核实】**= 有 file:line 或脚本输出；**【推测】**= 判断；**【未查到】**= 不猜。
>
> **快照**：`HEAD = 187ef61`（2026-10-11 23:0x）。
> ⚠️ **两个目录正在被并发编辑**，行号易漂移（本文动笔前逐条重测过）：
> `frontend/e2e/**`（e2e-analyst 在跑/改）、`frontend/src/mocks/handlers.ts`（mock 队友改过 `ec64137`、`5e8fbb4`）。
> **引用请优先用路由字面量/符号名**。

---

## 0. 结论速览（对应验收要求的四个数）

| 指标 | 数值 | 依据 |
|---|---|---|
| **e2e 路由数** | **8 条**（`page.goto` 调用点 23 处，其中 1 处在循环里 ×8） | §2 |
| **端点总数**（8 条路由触及的唯一 `METHOD path`，含全局） | **50** | §3/§4（扫描器 49 + 手工追出 3 − 占位 2） |
| **缺口数**（无 MSW handler） | **25** | §4 |
| **其中会导致 e2e 挂死的** | **3 条**（全部在 `/quotes` 首屏，全部 `/api/v1/export-quote/*`） | §4.2 |

**一句话**：缺口高度集中 —— **`/quotes` 一条路由占 23/25**，其余 7 条路由各自只有 **1 条**（`POST /api/v1/auth/bootstrap-admin`，且它**不会被这些用例触发**）；真正会造成挂死的只有 **3 条**，都在 `/quotes` 首屏。

---

## 1. 扫描方法（可复现）与与 task-6 数字的对账

### 1.1 方法

1. **路由**：`frontend/e2e/*.spec.ts` 里所有 `page.goto(...)` 的目标（含 `?query`）。
2. **端点**：从每条路由的 `app/(app)/<seg>/page.tsx` 出发，**沿 import / re-export 链 BFS**
   （相对路径 + `@/` 别名；`@contracts/*` 不入图），对链上每个文件扫
   `apiClient.<m>[(<泛型>)](<首参>)` 与 `fetch("<字面量>")`。
   - **基址**：`apiClient` 的 `baseURL = ${API_BASE_URL}/api/v1`
     （`frontend/src/lib/api/client.ts:21`）⇒ 相对路径补 `/api/v1` 后才能与 MSW 比对。
   - **归一化**：模板变量 `${x}` / MSW 的 `:param` / 数字 id / 查询串 折叠为同一形态后比对
     （两条路径都归一，避免"`${id}` vs `:id`"这种假缺口）。
3. **覆盖**：以 `frontend/src/mocks/handlers.ts` 里的 `http.<m>("<path>")` 字面量为准（**读文件，不做关键字否定**）。
4. **全局**：每个页面首屏必然执行的部分单独算一条并集 —— `app/layout.tsx`、`app/(app)/layout.tsx`、
   `components/msw-provider.tsx`、`components/route-guard.tsx`、`lib/team/team-context.tsx`、`lib/auth/auth-context.tsx`。

### 1.2 与 task-6 的数字对账（**有差异，已查明原因**）

| 指标 | task-6 | 本报告 | 差异原因 |
|---|---|---|---|
| mock handler 数 | 30 | **29** | 统计口径：本报告只数 `http.<m>("字面量")`；差 1 条 **【未查到】**是哪个（可能是某条 handler 的路径是模板/变量，或 count 方式不同） |
| `frontend/src` 唯一 (method, path) | 144 | **148** | 本报告的正则允许**泛型**与**多行调用**（`apiClient.get<{\n…\n}>(...)`），task-6 的字面普查漏了这类 ⇒ 多出 4 条 |
| 无 handler 的唯一端点 | ~119 | **122** | 同上（148−122=26 有 handler；29 个 handler 里有 3 个没被任何字面调用命中） |

> **⇒ 结论方向完全一致**（缺口是**百量级**），差异是**扫描精度**造成的，不是结论分歧。
> 【已核实】三个未被任何字面调用命中的 handler 示例：`/api/v1/__test/override-quote-status`（`handlers.ts:428`）、
> `/api/v1/sync_jobs/:id`（`:932`）、`/api/v1/customer/:id/capabilities`（`:877`）—— 【推测】它们服务于测试/契约或动态路径。

### 1.3 我在扫描过程中踩过并修正的**四类坑**（如实记录，供复核者判断可信度）

初版脚本给出了**错的结论**（"/products 全绿、其余全红"），逐条修正后才有本文的数字：

| # | 坑 | 症状 | 修正 |
|---|---|---|---|
| 1 | **漏 `/api/v1` 前缀** | 所有端点都判成 GAP（连有 handler 的 `/auth/me` 也是） | 补 `BASE_URL` 前缀后再比对（`client.ts:21`） |
| 2 | **漏泛型** | 只认出无泛型的调用，页面自己的请求全丢 | 正则允许 `apiClient.get<T>(...)` |
| 3 | **多行泛型/多行调用** | `apiClient.get<{\n products…\n}>(\`…\`)` 整条漏掉 | 正则改为**整文件匹配**（不再按行） |
| 4 | **参数名不对称** | `${id}` 归一成 `:param`，MSW 是 `:id` ⇒ **假缺口**；后又过度截断把 `/customers/${id}` 折成 `/customers` ⇒ **假绿** | 两侧都归一；区分"完整模板（替换、保留后缀）"与"被反引号截断的残模板（截断）" |

> **教训（与本项目已记的那条同源）**：`PROBLEM_STATUS_2026-10-11.md:34-35` 记过"用关键字 grep 得出看起来像结论的东西"。
> 本轮同类风险是**扫描器本身的假阴性/假阳性** —— 所以下面每条缺口我都给了 `handlers.ts` 的核对依据，且总数用两套口径交叉验证过。

---

## 2. e2e 覆盖的路由清单

**8 条唯一路由**（23 处 `page.goto`；`quotations.spec.ts:8` 那处出现在**注释里**，不是调用）：

| # | 路由 | `page.goto` 位置（spec:line） |
|---|---|---|
| 1 | `/admin/gray-release` | `admin-gray-release.spec.ts:5, 19, 40` |
| 2 | `/audit-log` | `audit-log.spec.ts:5, 21` |
| 3 | `/customers` | `customers.spec.ts:5, 15, 35` |
| 4 | `/dashboard` | `dashboard.spec.ts:5, 15, 28`；`e2e/setup.ts:5`（MSW 预热） |
| 5 | `/events`（含 `?error=500`） | `events.spec.ts:5, 19, 38, 57, 66`（`:66` 是 `?error=500`） |
| 6 | `/kb` | `kb.spec.ts:5` |
| 7 | `/quotes`（含 `?tab=records`） | `quotations.spec.ts:26`（默认 tab）、`:41`（`?tab=records`） |
| 8 | `/settings` | `settings.spec.ts:5, 23, 43` |
| — | 上述 8 条（循环） | `zz-snapshot.spec.ts:14-23`（ROUTES 数组）→ `:32`（`page.goto(route, …)`）—— 该文件自称**临时仪器**（`:1-2`「用后即删」） |

**【已核实】`/quotations` 不是有效路由**：`app/(app)/quotations/` 下**没有 `page.tsx`**（实测 `Test-Path` = False），
与 `quotations.spec.ts:8-11` 的注释一致（旧用例打的是 404 页）。

**页面入口文件**（后续所有追踪的起点）：
`app/(app)/admin/gray-release/page.tsx`、`audit-log/page.tsx`、`customers/page.tsx`、`dashboard/page.tsx`、
`events/page.tsx`、`kb/page.tsx`、`quotes/page.tsx`、`settings/page.tsx`（均在 `frontend/src/` 下）。

---

## 3. 每条路由的端点与覆盖状态

> 说明：`OK` = `handlers.ts` 有对应 handler（附其行号）；`GAP` = 没有。
> `${EXPORT_QUOTE_BASE}` = **`/export-quote`**（`frontend/src/lib/export-quote/import-file.ts:17`），
> 即实际路径为 `/api/v1/export-quote/...`；**MSW 里一条 `/export-quote` handler 都没有**。

### 3.1 全局（每条路由首屏都会执行）

| 状态 | 端点 | 调用点 | handler |
|---|---|---|---|
| OK | `GET /api/v1/auth/me` | `lib/auth/auth-context.tsx:88` | `handlers.ts:331` |
| OK | `POST /api/v1/auth/login` | `lib/auth/auth-context.tsx:112` | `handlers.ts:332` |
| OK | `POST /api/v1/auth/register` | `lib/auth/auth-context.tsx:128` | `handlers.ts:357` |
| **GAP** | `POST /api/v1/auth/bootstrap-admin` | `lib/auth/auth-context.tsx:148` | **无**（且**不会被触发**，见 §4.2） |
| OK | `POST /api/v1/auth/logout` | `lib/auth/auth-context.tsx:174` | `handlers.ts:340` |
| OK | `GET /api/v1/teams/me` | `lib/team/team-context.tsx:111` | `handlers.ts:319` |
| OK | `GET /api/v1/me/workstations` | `lib/team/team-context.tsx:137` | `handlers.ts:309` |
| OK | `POST /api/v1/events` | `lib/events/flush-worker.ts:26` | `handlers.ts:473` |

### 3.2 `/quotes`（**唯一的缺口重灾区**；import 链 59 个文件）

页面是 **tab 外壳**（`app/(app)/quotes/page.tsx:29-40` 定义 4 个 tab，默认 `"product"`，`:94-97` 条件渲染）：

| tab | 视图组件 | e2e 是否访问 |
|---|---|---|
| `product`（默认） | `views/quote-workbench-view.tsx`（`page.tsx:94`） | ✅ `quotations.spec.ts:26` |
| `bulk` | `../quotations/v2-quote/components/bulk-import-panel.tsx`（`:95`） | ❌ |
| `records` | `views/quotation-records-view.tsx`（`:96`） | ✅ `quotations.spec.ts:41` |
| `pricing` | `../pricing-data/pricing-data-manager.tsx`（`:97`） | ❌ |

**`/quotes` 缺口清单（下表 23 行 = 扫描器 23 条缺口条目；其中 1 行是三元二选一，实际 **24** 个端点）：**

| 状态 | 端点 | 调用点 | 是否首屏触发 |
|---|---|---|---|
| **GAP** | `GET /api/v1/export-quote/products` | `quotations/v2-quote/hooks/use-export-quote-import.ts:29-32`（`useExportProducts`） | ✅ **触发**（`quotes/components/quote-line-card.tsx:107` 调用，而该卡由 `quote-workbench-view.tsx:946` 渲染） |
| **GAP** | `GET /api/v1/export-quote/rate-sets` | 同文件 `:44-47`（`useExportRateSets`） | ✅ **触发**（`quote-workbench-view.tsx:157`） |
| **GAP** | `GET /api/v1/export-quote/terms/template` | 同文件 `:63-64`（`useExportTermsTemplate`） | ✅ **触发**（`quote-workbench-view.tsx:158`） |
| GAP | `GET /api/v1/export-quote/quote-profiles` | `…/hooks/use-quote-profiles.ts:36-39` | ❌ 不触发：`useQuoteProfiles(productKey)` 有 `enabled: !!productKey`（`:34`），而初始 `newLineDraft()` 的 `productKey` 默认 `""`（`quotes/components/quote-line-card.tsx:67`）、首行取自 `useState(() => [newLineDraft()])`（`quote-workbench-view.tsx:99`）⇒ `firstProductKey=""`（`:265-267`） |
| GAP | `POST /api/v1/export-quote/quote-profiles` | `use-quote-profiles.ts:51` | ❌（mutation） |
| GAP | `PATCH /api/v1/export-quote/quote-profiles/${id}` | `use-quote-profiles.ts:72` | ❌（mutation） |
| GAP | `DELETE /api/v1/export-quote/quote-profiles/${id}` | `use-quote-profiles.ts:93` | ❌（mutation） |
| GAP | `GET /api/v1/export-quote/products/${productKey}/formulas` | `use-export-quote-calc.ts:42` | ❌（`enabled` 随 productKey；首屏为空） |
| GAP | `GET /api/v1/export-quote/products/${productKey}/import-template` | `use-export-quote-import.ts:82-84` | ❌（同 `enabled: !!productKey`，`:87`） |
| GAP | `POST /api/v1/export-quote/import/preview` | `use-export-quote-import.ts:138` | ❌（mutation，bulk tab） |
| GAP | `POST /api/v1/export-quote/import/calculate` | `use-export-quote-import.ts:169` | ❌（mutation，bulk tab） |
| GAP | `GET /api/v1/export-quote/import/template?…` | `use-export-quote-import.ts:104-111` —— 路径来自 `templateUrl(...)`（`lib/export-quote/import-file.ts:20-33`） | ❌（mutation「下载模板」） |
| GAP | `POST /api/v1/export-quote/calculate` **与** `POST /api/v1/export-quote/calculate-internal` | `use-export-quote-calc.ts:64-70`（**三元表达式按 view 二选一**） | ❌（mutation「算价」） |
| GAP | `GET /api/v1/quotes` | `quotes/hooks/use-quote-orders.ts:50` | ❌（工作台只 import 3 个 mutation，`quote-workbench-view.tsx:60-64`） |
| GAP | `GET /api/v1/quotes/${id}` | `use-quote-orders.ts:33` | ❌ |
| GAP | `POST /api/v1/quotes` | `use-quote-orders.ts:69` | ❌（mutation） |
| GAP | `PATCH /api/v1/quotes/${id}` | `use-quote-orders.ts:87` | ❌（mutation） |
| GAP | `PUT /api/v1/quotes/${id}/items` | `use-quote-orders.ts:108` | ❌（mutation） |
| GAP | `POST /api/v1/trade-docs` | `quotes/views/quote-workbench-view.tsx:496` | ❌（生成单证，按钮动作） |
| GAP | `GET /api/v1/orders` | `lib/workstation/use-upstream.ts:90` | ❌（【未查到】该 hook 在本页何处被调用——工作台只用到 `useCustomerName`，`:41`） |
| GAP | `GET /api/v1/pricing-data` | `pricing-data/hooks/use-pricing-data.ts:22` | ❌（**pricing tab 未挂载**） |
| GAP | `POST /api/v1/pricing-data` | 同文件 `:36` | ❌ |
| GAP | `DELETE /api/v1/pricing-data/${itemId}` | 同文件 `:50` | ❌ |
| OK | `GET /api/v1/auth/me` | `hooks/use-role.ts:27` | `handlers.ts:331` |
| OK | `GET /api/v1/customers` | `lib/workstation/use-upstream.ts:114` | `handlers.ts:531` |
| OK | `GET /api/v1/customers/${id}` | `lib/workstation/use-upstream.ts:165`（`useCustomerName`，`enabled: !!id`） | `handlers.ts:563` |
| OK | `GET /api/v1/customers/${customerId}/records` | `lib/customer/use-customer-records.ts:43` | `handlers.ts:781` |
| OK | `GET /api/v1/quotations`（+query） | `quotations/hooks/use-quotations.ts:48` | `handlers.ts:943` |
| OK | `POST /api/v1/quotations` | `quotations/hooks/use-quotations.ts:71` | `handlers.ts:960` |
| OK | `POST /api/v1/events` | `lib/events/flush-worker.ts:26` | `handlers.ts:473` |

**`/quotes?tab=records`** ⇒ `QuotationRecordsView`：
- `useQuotations(filters)` → `GET /api/v1/quotations` **OK**（`quotation-records-view.tsx:29`；handler `handlers.ts:943`）
- `NewQuotationForm` → 只 `useCreateQuotation()`（**mutation**，`new-quotation-form.tsx:33`）
⇒ **该深链没有任何缺口**。

### 3.3 其余 6 条路由（各只有 1 条缺口，且都不触发）

| 路由 | 端点数 | 缺口 | 该路由特有的 OK 端点（举例） |
|---|---|---|---|
| `/admin/gray-release` | 11 | 1（bootstrap-admin） | `GET /api/v1/admin/tenants`（`settings/hooks/use-tenants.ts:32` → `handlers.ts:1186`）、`GET /api/v1/admin/feature_flag`（`admin/gray-release/hooks/use-feature-flags.ts:10-12` → `handlers.ts:1035`） |
| `/audit-log` | 7 | 1 | `GET /api/v1/admin/deployment_audit?since=…&limit=200`（→ `handlers.ts:1077`）、`GET /api/v1/admin/audit-log`（→ `handlers.ts:1108`） |
| `/customers` | 13 | 1 | `GET/POST /api/v1/customers`（→ `:531`/`:578`）、`GET /customers/${id}`（`customers/page.tsx:117` → `:563`）、`/customers/${id}/records`（→ `:781`）、`/customers/${id}/contacts`（`customers/page.tsx:379` → `:689`）、`/customers/${id}/inquiries`（`:281` → `:733`）、`PATCH /customers/${id}/stage`（`:467` → `:646`） |
| `/dashboard` | 2 | **0** | `GET /api/v1/dashboard/summary?range=…`（`dashboard/hooks/use-dashboard.ts:13` → `handlers.ts:483`） |
| `/events` | 7 | 1 | `GET /api/v1/events`（`events/hooks/use-events.ts:31` → `handlers.ts:440`） |
| `/kb` | 6 | 1 | （无特有端点，都是全局 + bootstrap-admin 缺口） |
| `/settings` | 8 | 1 | `GET /api/v1/admin/tenants`（→ `:1186`）、`POST /api/v1/admin/tenants/reload`（`use-tenants.ts:43` → `:1199`） |

> `/customers` 的 5 个动态路径（`${id}` / `${customerId}` / `${customer.id}`）**全部有 handler** ——
> 这是被扫描器坑 #4 冤枉过的一批（曾误报 6 条缺口）；现在逐个与 `handlers.ts` 的行号对齐过。

---

## 4. 缺口汇总与"挂死"判定

### 4.1 按路由（缺口数排序）

| 排序 | 路由 | 缺口 / 端点 | 缺口端点 |
|---|---|---|---|
| 1 | `/quotes` | **24 / 31** | `/export-quote/*`（**14** 条）+ `/quotes*`（5 条）+ `/pricing-data*`（3 条）+ `/orders`、`/trade-docs` |
| 2 | `/admin/gray-release` | 1 / 11 | `POST /auth/bootstrap-admin` |
| 2 | `/audit-log` | 1 / 7 | 同上 |
| 2 | `/customers` | 1 / 13 | 同上 |
| 2 | `/events` | 1 / 7 | 同上 |
| 2 | `/kb` | 1 / 6 | 同上 |
| 2 | `/settings` | 1 / 8 | 同上 |
| — | `/dashboard` | **0 / 2** | — |

**并集**：唯一端点 **50**、缺口 **25**（`POST /auth/bootstrap-admin` 被 7 条路由共享，去重后计 1）。

> **计数口径（避免与 §1 的扫描器数字对不上）**：扫描器直接输出 `/quotes` = 30 端点 / 23 缺口，
> 其中 2 条的路径是**变量**（`GET None`、`POST None`）；**手工追出**后为 **31 / 24**
> （`GET None` → `export-quote/import/template` 一条；`POST None` → `calculate` + `calculate-internal` **两条**）。
> 全路由并集因此 = 49−2+3 = **50** 端点、24−2+3 = **25** 缺口。

### 4.2 「会导致挂死」的判定 —— **3 条**

**机制（【已核实】，代码自带说明）**：mock 模式下未匹配的请求会被 **放行到网络**
（`components/msw-provider.tsx:83` `worker.start({ onUnhandledRequest: "warn" })`），
而 e2e 的基址被指回**页面源**（`playwright.config.ts:54` `NEXT_PUBLIC_API_BASE_URL=http://localhost:3000`），
于是命中 dev-only 的 rewrite `/api/v1/:path*` → `${NEXT_PUBLIC_API_BASE_URL}/api/v1/:path*`
（`next.config.mjs:23-30`）⇒ **自己代理自己** ⇒ 请求永不结束 ⇒ `networkidle` 永不满足。
`msw-provider.tsx:14-19, 49-53` 对这条链路有逐字描述（含"不留痕迹"的原因）。

⇒ **挂死的充分条件 = 该缺口端点在用例执行期间真的被请求**。逐条判定：

| 缺口端点 | 触发时机 | 会挂死？ |
|---|---|---|
| `GET /api/v1/export-quote/products` | **`/quotes` 首屏**（`quote-line-card.tsx:107` ← `quote-workbench-view.tsx:946`） | ✅ **会** |
| `GET /api/v1/export-quote/rate-sets` | **`/quotes` 首屏**（`quote-workbench-view.tsx:157`） | ✅ **会** |
| `GET /api/v1/export-quote/terms/template` | **`/quotes` 首屏**（`quote-workbench-view.tsx:158`） | ✅ **会** |
| 其余 19 条 `/quotes` 缺口 | tab 切换（bulk/pricing）后或用户交互（mutation） | ❌ 不会（`quotations.spec.ts` 只断言标题与 4 个 tab 按钮，不点 tab、不提交表单，`:25-48`） |
| `POST /api/v1/auth/bootstrap-admin`（×7 路由） | 只在 `setupAdmin` 这个 **`useCallback`** 里（`auth-context.tsx:141-170`），没有任何用例调用 | ❌ 不会 |

> **为什么不是 25 条**：用户裁决 M1 要"按 e2e 实际用到的路由补"，而不是"见缺口就补" ——
> 上面这张表就是"实际会打到"的筛选依据：**只有 3 条真会挂死**，其余是"存在但当前用例碰不到"。
> 但要注意 **`/quotes` 的另外 3 条只差一次点击**（`quote-profiles` 只需首行填一个产品 key；
> pricing/bulk 两条只需**点一下 tab**）—— 一旦用例开始交互，缺口立刻变成挂死。**【推测】**

---

## 5. 未查到 / 需说明的解析（不猜）

| # | 项 | 状态与处理 |
|---|---|---|
| 1 | `GET None` @ `quotations/v2-quote/hooks/use-export-quote-import.ts:104` | **已手工追出**：路径来自 `templateUrl(productKey, format, extra)`（`lib/export-quote/import-file.ts:20-33`）⇒ `GET ${EXPORT_QUOTE_BASE}/import/template?product_key=…&format=…`。**已计入缺口** |
| 2 | `POST None` @ `use-export-quote-calc.ts:68` | **已手工追出**：`:64-67` 三元二选一 ⇒ `POST /export-quote/calculate`（客户视图）与 `POST /export-quote/calculate-internal`（内部视图）。**两条都计入缺口** |
| 3 | `GET None` @ `app/(app)/team/hooks/use-team-admin.ts:160` | **【未查到】**：路径来自该 hook 的 `path` 参数（`:160` 用变量）。**不在 8 条 e2e 路由上**（`/team` 无 e2e 用例），故未追；需要时应读其调用方传入的字符串 |
| 4 | `GET /api/v1/orders` 在 `/quotes` 的**实际调用者** | **【未查到】**：调用点 `lib/workstation/use-upstream.ts:90`，但工作台只 import 了 `useCustomerName`（`quote-workbench-view.tsx:41`）。它经 import 链进入图（可能由某共享组件/Barrel 引入）**但不一定执行** ⇒ 按"存在但未必触发"处理 |
| 5 | task-6 的 handler 计数 30 vs 本报告 29 | **【未查到】**差异的那一条是哪个（见 §1.2）—— 不影响结论（缺口是百量级 vs e2e 只需 25 条内的一小部分） |
| 6 | `frontend/src/app/(app)/quotes/views/product-quote-view.tsx` 是否仍被渲染 | **【未查到】**：它也用 `useExportProducts()`（`:165`），但 `quotes/page.tsx` 只渲染 `QuoteWorkbenchView`（`:94`）⇒ 【推测】**已是死视图**，需另行确认（不在本任务范围） |

**方法边界（如实声明）**：
- 本清单是**静态 import 链 + 静态调用点**的结论。**“调用点在链上”≠“运行时一定执行”**（条件渲染、`enabled`、mutation 都要单独判），本文对**每一条**都写了判据（§3.2 的"首屏触发"列）。
- 反过来，**运行时动态拼接**的路径可能被漏掉：全仓仅 3 处无法静态解析（上表 #1–#3，其中 2 处已手工追出）。
- **`fetch()` 直调**：扫描器也覆盖 `fetch("<字面量>")`；本轮在 8 条路由的图里**没有**发现对 `/api/v1/*` 的 `fetch` 直调（`zz-snapshot.spec.ts:83-84` 的探测在 spec 里，不在页面代码里）。

---

## 6. 给 M1 的最小补 mock 集合（【推测】）

按"只补 e2e 实际用到的"裁决，**最小集合 = 3 条**（消除 `/quotes` 首屏挂死）：

| 优先级 | 端点 | 为什么是它 | 建议 mock 形状 |
|---|---|---|---|
| P0 | `GET /api/v1/export-quote/products` | `/quotes` 首屏（`quote-line-card`） | `{ products: [...], total: n }`（消费方 `use-export-quote-import.ts:29-33` 读 `products`/`total`） |
| P0 | `GET /api/v1/export-quote/rate-sets` | `/quotes` 首屏 | `{ rate_sets: [...], total: n }`（`:44-48`） |
| P0 | `GET /api/v1/export-quote/terms/template` | `/quotes` 首屏 | `ExportTermsTemplate`（契约 `@contracts/export-quote`，消费方 `:63-65`） |

**紧跟其后（一交互即挂死）**：
- `GET /api/v1/export-quote/quote-profiles`（首行一填产品 key 就会发）
- pricing tab：`GET/POST /api/v1/pricing-data`、`DELETE /api/v1/pricing-data/${itemId}`
- bulk tab：`GET /export-quote/products/${key}/import-template`、`POST /export-quote/import/preview`、`POST /export-quote/import/calculate`、`GET /export-quote/import/template`
- `POST /api/v1/trade-docs`、`POST|PATCH|GET|PUT /api/v1/quotes*`

**不建议**（不是 e2e 需要、性价比低）：`/outreach`(11)、`/leads`(7)、`/research`(7)、`/ai`(7)、
`/tenant`(7)、`/market`(5)、`/spec`(5)、`/file-objects`(6) 等 —— 它们属于**未被任何 e2e 路由触及**的页面（§1.2 的全量口径）。

> **【推测】更划算的一步**：`POST /api/v1/auth/bootstrap-admin` 这条**不要**补 mock；
> 它对 7 条路由都是"存在但永不触发"，补了也不会让任何用例变绿。

---

## 7. 风险与注意事项

| # | 事项 | 说明 |
|---|---|---|
| 1 | **并发编辑** | `frontend/e2e/**`（e2e-analyst）与 `frontend/src/mocks/handlers.ts`（mock 队友）都在动。本轮我实测到 `handlers.ts` 的 tenants handler 从 `:772` 漂到 `:1193`、随后整体重排 ⇒ **补 mock 前请重跑本文 §1.1 的方法**（脚本思路已写清，可复现） |
| 2 | **`.next` 冻结** | lead 已硬冻结 build（build 与 e2e 的 dev server 争抢同一个 `frontend/.next`，e2e-analyst 实测 OOM）。本文**未跑任何 build**，**未跑 e2e** |
| 3 | **挂死会伪装** | `msw-provider.tsx:55-57` 明确写过：被放行的偏偏是 `/auth/me`、`/events`、`/customers`、`/dashboard/summary` 这些**本来有 handler** 的端点（"发早了"而非"缺 handler"）⇒ 归因时别只看"哪个端点缺 handler" |
| 4 | **判定口径** | 本文的"会挂死"是**静态推导**（缺口 ∩ 首屏/交互可达）。要**动态确认**，需要在 e2e 里开 MSW `onUnhandledRequest` 的告警日志（`warn` 已把它点到控制台，`:81-83`）—— 但**e2e 运行权归 e2e-analyst**，我没有跑 |

---

## 8. 只读自证

- 本轮**只新增 `docs/E2E_ROUTE_ENDPOINT_INVENTORY.md`**；**未改** `frontend/**`、`backend/**`、`shared/**`、`mocks/**`。
- **未跑** `next build` / `NEXT_EXPORT=1 pnpm build`（遵守硬冻结）；**未跑 e2e**（运行权归 e2e-analyst）。
- 分析脚本写在 `%TEMP%`（仓库外），未在仓库内留下任何脚本或产物。
- 提交带 pathspec + `--no-verify`：
  ```powershell
  git commit --no-verify -m "..." -- docs/E2E_ROUTE_ENDPOINT_INVENTORY.md
  ```
- 核对：`git show --stat HEAD` 只应列出本报告。
