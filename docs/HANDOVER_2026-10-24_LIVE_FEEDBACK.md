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

### 发布与线上验证（2026-10-24 12:43 部署完成，commit `947b0bc4`）

- GitHub Actions：backend:test / contracts:check / ts-edge / Frontend CI / deploy 全绿；
  deploy = build-frontend（ubuntu 静态导出 + `assets:check`）→ migrate → deploy-kernel → deploy-edge。
- 线上健康：`GET /health?deep=1` → `kernel.status=ok`、`shared_loaded=true`（新 `product_names.py` 已进内核包）。
- **404 修复真机回归（生产，QA 账号）**：
  `GET /tenant-product-status` 修前 `items:[]`；`POST deer_net/field_fence is_enabled=true` → **200**
  （修复前是 404 PRODUCT_NOT_FOUND）；未知 key 仍 **404**、无 token 仍 **401**。
  写入的是 `is_enabled=true`（= 默认值，对所有团队行为不变）。
- 前端产物：生产 `/customers`、`/trade-docs`、`/products` 的 HTML 与 deploy artifact（`frontend-out`，
  commit `947b0bc4` 的 ubuntu 构建）**逐字节一致**；chunk 内已含「询盘/订单」「成品预览」「主英文名」。
  （本机 `git status` 干净；Cloudflare 缓存已 purge 一次。）

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

---

## 7. 第二轮补充反馈（2026-10-24 下午，同日执行）

> 用户在第一轮上线后的补充：① 英文名不要"地区叫法"表述、多个英文名都要能匹配；② 单证样板预览放回顶部（仍收纳）；③ **正式生成单证前要完整预览**（真实货物/金额/条款，不是样板）；④ 产品图上传/通知接口出现 502 kernel unreachable；⑤ 历史快照不回改口径确认正确。

### 7.1 英文名去地区化 + 全量匹配
- UI：`name-en-editor.tsx` 统一「英文名（可添加多个）」；第 1 条徽标「默认（报价/单证使用）」；删除「地区别名」「欧洲客户叫…」文案；占位改「如：Cattle Fence」。
- 存储不变（团队级 `product_profiles.info.name_en_list` + `name_en_primary`）。
- 新增 `ProductSpec.name_en_aliases: list[str] = []`（纯增量、旧 spec 缺键 = []）：`_quotable_specs` 用内核 `name_en_list_from_info` → 主名进 `name_en`、其余进 `name_en_aliases`；`GET /export-quote/products` 回该字段；`shared/contracts/export-quote.ts` 加**可选**字段（R1/R5 未变，未改冻结快照）。
- 匹配：`kaas_common/export_quote/importers.py` 的「产品」列 token = key + 中文名 + `name_en` + 全部 aliases（沿用 `_order_compact` 大小写/空白/连字符归一）；客户询盘表单 datalist + `resolveProductKey` 也支持任一英文名反查 `product_key`。
- 排查结论：quote 产品下拉/R-D 导入面板是原生 select，无 name 过滤；后端按名匹配的唯一入口 = 整单导入产品列（已覆盖）。

### 7.2 单证：正式生成前的完整预览
- **内核新端点**（只读、零写库）：`POST /api/v1/trade-docs/preview-render-data`
  - 请求与开单同形：`{doc_type, customer_id, currency, with_seal?, order_id? | quote_order_id?, inquiry_id?, raw_payload?}`；
  - 响应 `{doc, data, company_profile_configured}`；`data` 与 `GET /trade-docs/{id}/render-data` **同源同形状**（同一个 `_render_bundle_of_doc`）：真实买方/卖方/银行/贸易条款/行项/金额/默认公章/产品档案默认值；
  - `doc` 为虚拟单据（id=null、status=draft、doc_no=只读算出的预计编号，不占用段号）；quotation 已有 1:1 单据时返回既有那张；
  - 越权/不存在上游 → 404（不泄露存在性）；缺参/冲突 → 422；`with_seal=false` 不查章不注入；
  - create 与 preview 共用 `_assemble_doc_inputs`（纯读装配），render-data 与 preview 共用唯一装配点 —— 预览与落库后的成品不会漂移。
- **前端**：`DocCreatePreview` 打开才请求（`use-preview-render-data`），多类型可切换、每类单独请求；`renderTradeDoc` iframe 只读渲染；错误码→中文原因（含只有 `error` 的 `bad_doc_type`）优先取 `detail.detail`；失败显示可重试错误、**绝不退回样板占位**；"字段为空"按"如实反映开单结果、可在开单后补"表述；删除旧本地占位装配 `lib/trade-doc/create-preview.ts`（死代码）与 MSW mock 同步（不 push docsStore）。
- **布局**（补充反馈 2）：PageHeader → **SamplePreviewEntry（顶部、默认收起的一行入口）** → 「开单（第一步）」→ 台账 → 已选单证预览。

### 7.3 生产 502 kernel unreachable（产品图上传 / 通知计数）
- **根因**：Python 内核每次部署后，新版本 isolate 的第一批冷启动偶发 `scriptThrewException / exceededResources`（Cloudflare 侧 Python 启动失败；GraphQL 显示本轮部署前后均有此类记录，**不是本批代码引入**），Service Binding 的 `fetch` 直接 reject ⇒ 门面 502 `kernel unreachable`。用户侧表现 = 部署后第一下上传图片/通知计数失败，刷新/重试即可。
- **修复**：
  1. `backend/ts-worker/src/proxy.ts`：仅对 **fetch 抛错**做有限重试（GET/HEAD 最多 3 次；有 body 的请求先 clone、重试 1 次；上传按 sha256 定键不会重复对象）；内核已返回的 5xx 一律不重试（可能已有副作用）。
  2. `kernel.ts` `callKernel`：GET/HEAD 同样有限重试（deep health / 监控不再因冷启动误报）。
  3. deploy.yml：内核 liveness 改为**连续 2 次** `/health?deep=1` 全绿才算通过（兼做部署后预热）。
- **附带修复（e2e 抓到的真问题）**：预览 MSW handler 里 `.replace(/[-:TZ.]/g, "")` 被 Tailwind 当成类名候选，生成非法 CSS `.\[-\:TZ\.\] { -: TZ.; }` ⇒ `next dev`/`next build` 的 CSS 解析 500（e2e webServer 超时）。改为 `/[^0-9]/g`（只保留数字，行为等价）。**这条如果不跑 e2e/build 会直接挂 CI 构建**。

### 7.4 本轮门禁与验证（2026-10-24 实测）
| 门禁 | 结果 |
|---|---|
| worker pytest | **1825 passed + 12 skipped**（+1 新端点 17 测、+ route 登记、parity 键集更新） |
| orchestrator pytest | **273 passed** |
| ts-worker | typecheck 0 / **310 passed（26 文件）**（+3 冷启动重试测试） |
| 前端 | typecheck 0 / lint 0 error（75 存量 warning）/ **225 files · 1647 passed** |
| e2e | **28 passed**（57.8s，CSS 修复后） |
| contracts R0–R6 / mocks / ui:standards / ui:contrast / trade-doc:check | 全 PASS |
| 静态断言 + sync-shared -Check | 全 PASS（46/22/1 一致） |
| `NEXT_EXPORT=1 pnpm build` | exit 0（Windows 本机 `assets:check` 仍是已知平台产物缺陷，以 CI ubuntu gate 为准） |
| Test Pilot | 本工作区未配置 runner（`no-tests`），以上均为显式命令实测 |

### 7.5 部署与线上验证（2026-10-24 13:57，commit `01f49eb4`）
- GitHub Actions：backend:test / contracts:check / ts-edge / Frontend CI / deploy 全绿（deploy run `40067341248`；
  build-frontend ubuntu + assets:check → migrate → deploy-kernel（**连续 2 次 deep health 全绿**才算通过）→ deploy-edge）。
- `GET /health?deep=1` 连续 3 次 200：`kernel.status=ok`、`shared_loaded=true`（新内核包已生效）。
- **新端点可达性**：`POST /api/v1/trade-docs/preview-render-data` 无 token → 401（路由存在且鉴权生效）；
  已登录但未开通 trade-docs 工位的 QA 账号 → 404 `WORKSTATION_NOT_SUBSCRIBED`（与既有工位闸门同口径）。
- **用户报 502 的两条路径已恢复**：`GET /notifications/unread-count` → **200 `{"unread":0}`**；
  `GET /products/chain_link/media` → **403 NO_TEAM**（可达、走到鉴权闸门，不再是 502）。
- **前端产物**：生产 `/trade-docs`、`/products`、`/customers` 的 HTML 与 deploy artifact（`frontend-out`，同上 commit）
  **逐字节一致**；chunk 内已含「完整预览」「英文名（可添加多个）」「默认（报价/单证使用）」「预览编号（只读计算、未占用）」「询盘/订单」。
