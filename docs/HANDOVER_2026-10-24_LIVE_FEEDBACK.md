# 交接 · 2026-10-24 线上反馈六项（产品英文名 / 在报价中显示 / 客户询盘·订单 / 单证页）

> **用途**：用户 2026-10-24 线上验收反馈 6 条的定位、修复与验收证据。当前状态文档仍是
> [`PROBLEM_STATUS_2026-10-11.md`](./PROBLEM_STATUS_2026-10-11.md)（顶部「交接摘要」已登记本批）；
> 待办账本 = [`TODO.md`](./TODO.md) §S。
> **结论**：6 项全部落地，门禁全绿（数字见 §4）。**历史业务快照不回改**（法律凭证口径）。

---

## 0. 一句话口径

| # | 用户反馈 | 结论 | 根因 |
|---|---|---|---|
| 1 | 产品基本信息英文名改完不能保存、无接口调用、无报错 | ✅ 修 | 基本信息「保存」只 PUT `/products/{key}/profile` 的 usage/origin/material_options，**英文名不在请求体**；系统产品的「保存」按钮又根本不存在 |
| 2 | 鹿网/牛栏网「在报价中显示」报 404 + 前端状态延迟 ~2s | ✅ 修 | 门面 `POST /tenant-product-status` 直连 SQL，要求 `tenant_products` 有行；生产库只有 2 行租户产品，**系统产品来自代码注册表、DB 无 `is_system` 行** ⇒ 404 PRODUCT_NOT_FOUND。延迟 = 等 POST + 重拉 status + 重拉 export-products |
| 3 | 鹿网/牛栏网英文名不能改 | ✅ 修 | 同一根因：无 `tenant_products` 行 ⇒ `isTenant=false` ⇒ 英文名输入框 disabled，且没有团队级保存路径 |
| 4 | 产品英文名要支持多个（不同地区叫法不同） | ✅ 修 | 原模型只有单值 `product_name_en` / `spec.name_en` |
| 5 | 客户管理「询盘」tab 计数应含订单；改名「询盘/订单」或拆分 tab | ✅ 修 | tab 计数只取 `detail.inquiries.length`，订单只存在于 records 树里、没有入口 |
| 6 | 单证页样板预览占空间且不能收起；开单应为一等公民；要开单前成品预览 | ✅ 修 | 样板预览常驻 SectionCard 顶部；开单在其后；开单前没有任何预览入口 |

---

## 1. 产品英文名（#1/#3/#4）

### 存储口径（零 DB 迁移）
- 团队级 `product_profiles.info`（既有表/既有 team 作用域）新增：
  - `name_en_list: string[]` —— 全部英文名，**主名在前**；
  - `name_en_primary: string` —— 显式主名（读取不依赖顺序）；
  - 历史单值 `name_en` 只读兼容（有它且无 list ⇒ 当成唯一英文名，不能当"没配"）。
- 归一化**只在 Python 内核一处**：[`backend/kaas_common/export_quote/product_names.py`](../backend/kaas_common/export_quote/product_names.py)
  （纯标准库，由 `sync-shared.ps1` 镜像进 Worker）。
- 前端 [`frontend/src/lib/products/product-names.ts`](../frontend/src/lib/products/product-names.ts) 只是最小镜像（展示 + 搬运），后端落库前会再归一化一次。

### 保存路径
- 产品详情三个保存入口（顶部「保存」/「保存产品信息」/「保存规格与包装」）统一为 **saveAll**：
  1. `PUT /products/{key}/profile` —— 团队资料 + 多英文名（系统产品唯一落点）；
  2. 有租户行时再 `PUT /tenant-products/{id}` —— 中文名 / 主英文名 / spec，并同步 `tenant_products.product_name_en`。
- 鹿网/牛栏网等系统产品：英文名输入框不再 disabled，**不再要求先「按我们的规格自定义」**；
  「按我们的规格自定义」保留为独立「复制 spec 成团队产品」动作（复制前也先存英文名）。

### 读侧与下游
- `GET /products`：`name_en` = 团队资料主名（无则注册表），新增 `name_en_aliases` / `name_en_list`。
- `GET /products/{key}/profile`：有英文名时投影成规范形状；没配时响应逐字不变。
- 内核 `_quotable_specs`（`/export-quote/products`）：团队资料主名覆盖 `spec.name_en`（**只改展示名**）⇒
  报价行 `product_name = name_en || name` 自动用主名 ⇒ 新报价/订单/单证快照用主名。
- 团队隔离：非管理员读 profile 加 `team_id=$2`（与 `ws_files._team_scope_soft` 同口径）；
  管理员不过滤，同 key 多团队行按 `updated_at DESC` 最近更新生效（确定性排序）。
- 前端 `mergeWorkProducts` 回落链：profile `name_en_list` → `/products.name_en_list` → 租户行 → 注册表。

---

## 2. 「在报价中显示」404 + 2s 延迟（#2）

### 根因（生产已核）
- 生产库（Neon production）`tenant_products` 只有 2 行：`chain_link`（勾花网）、`y_posts`（team 2）；
  `deer_net` / `field_fence` 是**纯代码注册表产品**，DB 没有 `is_system=true` 行。
- 门面 `workstations.ts` 的 `POST /api/v1/tenant-product-status` 直连 SQL：查不到产品就
  `throw httpError(404, PRODUCT_NOT_FOUND)` ⇒ 鹿网/牛栏网开关恒 404（用户控制台那条请求即此）。

### 修复（ADR-008：业务判定只在内核一处）
- 门面改为**内核透传**（`requireUser` + `forwardKernelRequest`），不再维护第二份「产品是否存在」判定。
- 内核 `set_tenant_product_status`：DB 查不到时回落 **代码注册表**（`_registered_product_or_none`）——
  注册表有该 key ⇒ 视作系统产品，允许写团队启停记录；真正未知 key 仍 404（错误契约不放宽）。
- 前端乐观更新：`useSetProductQuoteEnabled` 先写 `tenant-product-status` 查询缓存（点完立即回显），
  失败回滚；成功后只重拉 `export-products`，status 在 settled 后对齐服务端。

---

## 3. 客户管理「询盘/订单」（#5）

- tab 改名 **「询盘/订单 (N)」**，N = 询盘数 + 订单数：
  - 询盘数 = `GET /customers/{id}` 的 `detail.inquiries.length`；
  - 订单数 = `GET /customers/{id}/records` 树里的订单节点（`quotes[].orders` + `direct.orders`），
    按订单 id 去重（后端 `build_records` 保证一单只落一个节点）。
- **可见性（防假修）**：有询盘来源的订单在询盘卡片「最新一步」显示订单号+状态；
  无询盘来源的订单（直接下单 + 未关联询盘报价下的）在「直接下单（正常分类）」区块逐条列出。
- 订单数未知（records 加载中/失败）时 tab 显示 `N+`、头部显示「订单读取中…/订单暂时读不到」，
  **不拿 0 冒充**；纯订单客户不再显示「暂无询盘」空态。

---

## 4. 单证页（#6）

- **开单升为一等公民**：`PageHeader` 之后第一个 SectionCard = 「开单（第一步）」，`border-primary/40` 强化层级；
  开单流程/校验/onCreated 未动。
- **样板预览收编**：常驻大卡片 → 一行入口 `SamplePreviewEntry`（默认收起、点开 Dialog）；
  18 类原型能力不删、仍不写库、仍不需要后端。
- **开单前成品预览**：
  - 数据装配 [`create-preview.ts`](../frontend/src/lib/trade-doc/create-preview.ts)：内置 `sample-data.json` 底稿 +
    表单已填值（币种 / 业务客户 / 已选上游的 6 个贸易条款），**纯前端、零网络、零写入**；
    **不复制内核 `build_render_data` 的卖方/买方块/金额派生规则**。
  - 展示 [`doc-create-preview.tsx`](../frontend/src/app/(app)/trade-docs/components/doc-create-preview.tsx)：
    开单按钮旁「成品预览」；必填不全禁用并列出缺项；Dialog 内 `renderTradeDoc` + iframe 只读展示，无签发/归档/上传/POST。
  - 限制：货物明细/单号/日期/地址等开单后由系统带入的字段按样板占位显示（对话框已说明）。

---

## 5. 验收（2026-10-24 实测，工作区静止）

| 门禁 | 结果 |
|---|---|
| worker pytest | **1804 passed + 12 skipped**（基线 1783+12；+21 = 英文名 18 + status 修复 3） |
| orchestrator pytest | **273 passed** |
| ts-worker | typecheck 0 / **307 passed（26 文件）**（+2 条 status 路由回归） |
| 前端 typecheck / lint | 0 / **0 errors（75 warnings 全存量）** |
| 前端 test | **226 files / 1641 passed** |
| e2e | **28 passed**（48.6s） |
| contracts R0–R6 / mocks:check | PASS / PASS（P1 54/54，未覆盖 3 ≤ 20） |
| ui:standards / ui:contrast / trade-doc:check | PASS / PASS / PASS |
| 静态断言 | runtime-deps / schema-coverage / schema-drift / worker-bundle / deploy-domains / sync-shared -Check 全 PASS |
| build（Windows 本机） | `NEXT_EXPORT=1 pnpm build` exit 0；`pnpm assets:check` 在本机**必然红**（`nextDirs=39`，Windows `path.relative` 反斜杠已知产物缺陷，见 AGENTS）⇒ 以 CI ubuntu 的 `build-frontend` + assets gate 为准 |

新增回归测试（文件）：
- 内核：`backend/worker/tests/test_product_names_en.py`（18）、`test_tenant_products_team_scope.py` +3（status 404 修复）。
- 门面：`backend/ts-worker/tests/workstations-routes.test.ts` +2（转发内核 200 / 无 token 401）。
- 前端：`product-names.test.ts`（5）、`product-name-en.test.tsx`（4）、`tenant-products.test.ts` +1、
  `quote-status-optimistic.test.tsx`（2）、`customer-detail-tabs.test.tsx`（5）、
  `doc-create-preview.test.tsx` / `sample-preview-entry.test.tsx` / `trade-docs-page-layout.test.tsx` / `create-preview.test.ts`（共 13）。

---

## 6. 遗留 / 边界（已登记 TODO §S）

1. **历史快照不回改**：已落库报价/订单/单证的 `product_name` 是快照；改英文名只影响新单据。
2. **多英文名当前是"主名 + 地区别名"**：报价/单证自动用主名；**按客户/地区逐单选择英文名**未做（需报价行 UI + 快照字段，另开任务）。
3. **成品预览的货物明细/金额是样板占位**：要真实明细需内核提供「开单前装配」接口（跨层变更，待裁决）。
4. **`/workstation-products` 旧路由**仍按 DB 行判定产品存在（前端已不用它；旧 REST 客户端对注册表产品可能 404）——
   本批只修用户实际触发的 `/tenant-product-status`，该路由建议后续收敛/下线。
5. 管理员视角同一系统产品多团队 profile 时取最近更新一行（团队用户只看自己团队）。
