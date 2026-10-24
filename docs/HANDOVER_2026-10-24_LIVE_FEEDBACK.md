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
---

## 8. 第三轮收口（2026-10-24 下午，A/B/C/D 四项）

> 用户一次下达 4 项遗留：A 按客户选择产品英文名（主功能）、B API token 只读预览权限映射、
> C 路由清单/计数收口、D `/workstation-products` 对代码注册表产品 404。按 A→B→C→D 顺序做，
> 每项独立可测；**前一项不绿不开始下一项**。历史报价/订单/单证的 `product_name` 快照一律不回改。

### 8.1 A · 按客户选择产品英文名（主功能）

口径：同一产品可配多个英文名（团队级 `product_profiles.info.name_en_list`，主名在前 + `name_en_primary`）。
报价行只在本单为**当前客户**选一个英文名；该名随「报价行 → 订单 → 单证」快照走；下次给同一客户报
同一产品默认沿用上次选择；历史快照不回改。

- **产品身份**：用 `spec_snapshot.product_key`（前端 `buildLineItem` 早已写入），**不用 product_name**
  —— 英文名本身是要选的变量，拿它当身份会在换名后失真。旧行缺 key 向后兼容（见回落口径）。
- **行级选择 UI**：`quote-line-card.tsx` 仅当产品英文名 > 1 个时显示下拉（默认名 + 全部 aliases，
  默认项标「（默认）」）；文案中性：「客户英文名（本单使用）」「默认英文名」，无地区/国家措辞。
- **默认值解析**（`lib/product-name-selection.ts` 纯函数 + 行内 effect）：
  ① 当前客户 + 当前产品最近一条报价行用过的英文名（必须命中该产品当前任一英文名才采用）；
  ② 否则产品默认英文名。偏好查询未结束前不写默认（避免闪一下再被覆盖）。
- **手动选择**：写入行 `nameEn` + `nameEnManual=true`，只换 `built.item.product_name`（价格不重算）；
  **换产品**重置为新产品的默认解析；**换客户**手动行保留、未手动行清空后按新客户偏好重新解析。
- **零迁移偏好端点**（内核唯一）：`GET /api/v1/quotes/product-name-preference?customer_id=&product_key=`
  → `{product_name: string | null}`。SQL 用 `spec_snapshot->>'product_key'` 身份匹配；旧行（无 key）按该产品
  **当前全部英文名**（默认名 + 团队别名 + 中文名，大小写不敏感）回落；团队隔离与报价读权限同源
  （客户闸门 + `_scope_sql`）。product_key 空 → **422 PRODUCT_KEY_REQUIRED**；未知/不可见产品 →
  **404 PRODUCT_NOT_FOUND**；别团队客户 → **404 CUSTOMER_NOT_FOUND**；无历史 → `null`。
- **参考价按产品身份**（`GET /api/v1/quotes/reference-price`）：优先 `spec_snapshot->>'product_key'`，
  旧行回落「本单所选名 + 该产品历史用过的任何英文名」；只传 `product_name` 的旧调用方行为不变；
  两者都不传 → 422（不再默默按空名匹配）。
- **继承链（只加测试、不改代码）**：用户选的 `product_name` 原样进 `quote_order_items` →
  quotation 的 `trade_doc_items`；报价转订单复制进 `order_items`；`doc_payload.order_snapshot` 原样带出。
- 文件：`backend/worker/src/quote_api.py`（新端点 + 参考价身份匹配）、
  `frontend/src/app/(app)/quotes/{components/quote-line-card.tsx,lib/line-to-item.ts,lib/product-name-selection.ts,hooks/use-product-name-preference.ts,hooks/use-reference-price.ts,views/use-workbench-state.ts}`、
  `frontend/src/mocks/handlers.ts`（偏好端点 + 参考价身份匹配的 MSW handler）。
- 测试：前端新增 27 条（行卡 12 / 纯函数 12 / hook 3）+ line-to-item 4；内核新增
  `tests/test_quote_product_name_preference.py`（10 条：偏好/参考价身份/单证快照继承）+
  `test_parity_quote.py` +5（落库、订单继承、参考价身份/422、路由面登记）。

### 8.2 B · API token 只读预览权限映射

- `backend/ts-worker/src/scope-map.ts`：在 trade-docs 泛前缀（readWrite：POST→write）**之前**加
  `rule("POST", "/api/v1/trade-docs/preview-render-data*", "trade_docs:read")` —— 预览只装配渲染数据、
  **不落库**，是只读语义；规则表顺序即优先级。其余 `POST /trade-docs*` 仍要求 `trade_docs:write`。
- 注释/文档写清「读/写按端点是否落库判断，不能按 method 一刀切」：`scope-map.ts` 注释、
  `docs/W5_MCP_REST_DESIGN_2026-10-21.md` §2、`backend/ts-worker/README.md` 对照表。
- 测试（`tests/scope-map.test.ts` +10）：只读 token 调预览通过；写 token 调其它 POST /trade-docs 仍可用；
  只读 token 调其它 POST /trade-docs → 403 SCOPE_NOT_DECLARED（不能顺手放宽）；无 scope token → 403；
  「未声明路径 = 拒绝」边界（`/trade-docs-extra` → null）。

### 8.3 C · 路由清单/计数收口（内核 +2 条业务路由）

- 用 worker venv 重新生成：`backend/worker/.venv/Scripts/python.exe backend/ts-migration/export_routes.py`
  → **280 业务路由 + 4 内置 = 284**（脚本自检 OK）。
- `backend/ts-migration/export_routes.py`：`EXPECTED_TOTAL 282→284`，按既有注释风格补两行（见文件头）：
  第二轮 `POST /api/v1/trade-docs/preview-render-data` ⇒ 279 业务（+4=283）；
  第三轮 A `GET /api/v1/quotes/product-name-preference` ⇒ 280 业务（+4=284）。
  说明：任务书 C 只预期 preview 的 282→283；**A 项新增的偏好端点也是一条业务路由**，故按实际清单收到
  284（用户口径「以路由清单实际分类为准」）。`routes.json` / `route-inventory.md` 已重生成；
  再跑一次生成器输出 OK 且产物字节不变（幂等）。
- 同步计数：`tests/route-surface.test.ts` 头注释 `278→280`；`tests/openapi.test.ts` 断言
  `278/193/85 → 280/193/87`；`AGENTS.md` 门禁段；`docs/API_RESERVED_LIST.md` 基线；
  `docs/README.md` 路由行；`docs/TODO.md` §S S-16。
- 分类：**280 = 193 直接 + 87 透传**（新增 2 条都在透传前缀内，门面无需逐条注册；路由面机检不受影响）。

### 8.4 D · `/workstation-products` 对代码注册表产品 404（同类隐患）

- 根因：系统产品真源是代码注册表（`kaas_common/export_quote/products/`），生产 `tenant_products`
  没有 `is_system=true` 行；旧实现只读 DB ⇒ 空表团队 GET 回 `[]`、POST 注册表产品恒 404。
- 内核（唯一判定）：`ws_products._matrix_rows` = **注册表产品（is_system=true，名称取注册表）∪ 本租户
  active 租户行**，同 key 时租户行覆盖（保持"租户自定义产品优先"）；`set_workstation_product` 查不到 DB 行
  时回落注册表，真正未知 key 仍 404（不写库）。
- TS 门面：删除第二份 `matrixRows`/SQL 判定，GET/POST `/api/v1/workstation-products` 改为
  `requireUser + forwardKernelRequest`（与 `/tenant-product-status` 同模式）；路由仍逐条注册 ⇒ routes.json 计数不变。
- 订阅闸门保留：未开通报价工位仍 **404 SUBSCRIPTION_REQUIRED 且不写库**；团队隔离口径不变（内核一处）。
- 测试：worker `test_tenant_products_team_scope.py` 期望改为「注册表 3 个产品 + 租户行并集」
  （field_fence 租户行覆盖名称/is_system），新增「空表团队 GET 仍返回注册表产品」「POST field_fence 201」
  「未知 key 404 不写库」；TS `workstations-routes.test.ts` 新增 GET/POST 转发内核、无 token 401、
  门面不再直连 `tenant_products`/`tenant_workstation_products`（15 条）。

### 8.5 门禁（2026-10-24 第三轮实测，工作区静止）

| 门禁 | 结果 |
|---|---|
| worker pytest | **1842 passed + 12 skipped**（1842+12=1854 全跑完，0 failed） |
| orchestrator pytest | **273 passed** |
| ts-worker typecheck / test | 0 error / **323 passed（26 文件）** |
| 路由面机检 | `route-surface` + `openapi` 10 passed（280 = 193 直接 + 87 透传；0 缺失 0 多余） |
| 前端 typecheck / lint | 0 / **0 errors（75 warnings 全存量）** |
| 前端 test | **228 files / 1678 passed** |
| contracts / mocks | PASS（R0–R6）/ PASS（前端调用 245 / MSW handler 262 / 未覆盖 3 ≤ 20 / P1 54/54） |
| ui:standards / ui:contrast | PASS / PASS（24 条 light+dark 全 ≥ 4.5） |
| trade-doc:check | PASS（23 类型：15 OK / 8 WARN 均为「manifest 声明但模板未直接用」） |
| e2e | **28 passed / 0 failed / 0 skipped**（--list Total 28，对平） |
| build（Windows 本机） | `NEXT_EXPORT=1 pnpm build` exit 0（out 322 files / 8.9 MB）；`assets:check` 本机**已知红**（仅 `__next.*` 目录 39 条，badNames/missingRefs/prefetchTrue 全 0）⇒ 以 CI ubuntu 产物为准 |
| 静态断言 | runtime-deps / schema-coverage / worker-bundle / deploy-domains 全 PASS；schema-drift 在 PS5.1/cp936 下因打印 ⚠️ 编码报错（非漂移），`PYTHONUTF8=1` 重跑 PASS（生产表 109 / 模型表 111，列漂移 0） |
| sync-shared -Check | PASS（共享内核 46 / 报价引擎 22 / 枚举 1 一致） |
| Test Pilot | 本工作区未配置 runner（no-tests）；以上均为显式命令实测 |

### 8.6 部署与生产验证

> 代码+文档同批提交后由 `deploy.yml` 自动发布（push main 触发 CI→deploy）；部署完成后在 docs-only
> 跟进提交回填 run id 与黑盒证据（避免把"待验证"写成"已验证"）。

- 待回填：deploy run、`/health?deep=1` ×3、新 preference 端点口径、preview 端点可达性、
  `/workstation-products` 401/403/404 口径、生产 HTML 与 deploy artifact 逐字节比对、chunk 新文案。

