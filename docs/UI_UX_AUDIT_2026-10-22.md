# 全站 UI/UX 与结构审计报告（2026-10-22）

> 范围：`frontend/src/app` 全部 37 个路由页面 + 应用外壳 + 共享组件，对照 `docs/UI_STANDARDS.md`。
> 方式：6 个并行审查小组逐页通读代码（含 components/hooks/lib），所有发现带 `文件:行号` 证据。
> 严重度：**P0** = 数据丢失/安全/不可逆误操作风险；**P1** = 重要功能缺陷或 UI 规范硬性违反；**P2** = 一致性/体验/结构优化。

## 0. 排除项（并行任务所有，本报告不涉及、不冲突）

- **产品图片上传/媒体相关**：`products/components/product-images.tsx` 及产品媒体上传链路——归并行优化任务。
- **拖拽排序相关改动**：排序交互改拖拽的涉及面归并行任务。
- 本报告其余部分与上述两项无重叠；若后续整改碰到这两个文件，以并行任务为准。

## 1. 总体结论

- **无 P0 级阻断缺陷**；但 P1 有约 20 处，集中在四类模式：
  1. **危险操作无二次确认**（报价签发、批量建单、群发邮件、删除调研产品、作废单证、清除密钥、产品税率删除）；
  2. **失败静默/无反馈**（spec-config 向导提交、shipments 三个 mutation、人工录入报价、gray-release 开关、spec-proposals 审批）；
  3. **请求失败被伪装成空态**（events、pricing-data、market 五 tab、gray-release flags "已关闭"、kb 假统计）；
  4. **重复提交无防重**（群发、AI 起草、模型输入每键一 PUT、批量抓取）。
- **规范符合度**：`pnpm ui:standards` 静态项（h1 唯一/th scope/ui:tabs/硬编码状态色/viewport）基本全过；欠账集中在**组件复用类规则**（SectionCard/EmptyState/LoadingBlock/ConfirmDialog/PaginationBar 用与不用全看页面作者心情）与 **error/loading/无权限分支丢页头**（系统性，8+ 处）。
- **结构债**：7 个 800+ 行巨型组件；`/quotations` 是无 page.tsx 的"幽灵路由目录"却被 `/quotes` 反向引用；`FreightPanel`(427 行) 等死代码；状态 tone 映射在 leadgen/outreach/research 三份重复。
## 1.5 行内展开模式：默认不采用（2026-10-22 用户裁定，按 P1 设计缺陷处理）

**用户原话**："详情或者编辑页面直接在数据下方展开的设计是我不能接受的，很 low，并且区分不明显，数据量大操作比较困难。" 并补充："我也不是说那是禁令，只是好多地方不该用那种方式。"

**裁定口径（写入组件契约 L1，作为默认规则而非一刀切禁令）**：
- **默认规则**：列表/表格行内只放摘要；**详情默认用右侧 `DetailDrawer`**（或独立详情页）；**编辑默认用模态 `Dialog`**（短表单）或**独立页面**（长流程/向导）。判定标准：用户不滚动、不改变视觉层级就能区分"列表"与"详情/编辑"两块，且数据量大时操作不困难。
- **允许的例外**：轻量二级展开（摘要→更多字段、算价表明细、原始 JSON 折叠区）可保留，但必须有明确视觉容器（SectionCard/Disclosure）且不得与行详情混排；是否采用行内展开由"数据量+操作复杂度"判断，大数据量/多字段编辑不适用。
- **本质问题不是"展开"这个交互，而是缺默认范式**：现在 8 处行内展开 vs 1 处抽屉，说明没有契约规定默认该用哪种，各页作者随手选。整改 = 立默认规则 + 逐处按数据量判断迁移或保留。

**现存全部行内展开位置（逐处按上述口径裁定）**：

| # | 位置 | 模式 | 证据 |
|---|---|---|---|
| X1 | customers 询盘详情 | 行点击在询盘卡片下方展开报价/订单/单证倒序表 | `customers/page.tsx:1161-1257`、`components/inquiry-followups.tsx:482+` |
| X2 | leadgen 线索详情 | 200 行内联面板在表格下方展开，把列表整体下推 | `leadgen/page.tsx:666-872` |
| X3 | outreach 邮件详情 | 消息列表下方内联展开邮件预览 | `outreach/page.tsx:614-635` |
| X4 | research 产品编辑 | 158 行编辑表单在表格行下方原地铺开 | `research/page.tsx:550-708` |
| X5 | shipments 编辑面板 | 编辑区依附"当前列表行存在"，改筛选即消失（兼有数据丢失风险） | `shipments/page.tsx:137,274-289` |
| X6 | audit-log 原始 payload | 行点击展开 JSON 详情，键盘不可达 | `audit-log/page.tsx:148-157` |
| X7 | quotes 记录页 | 人工录入表单+旧台账表在记录表下方同屏堆叠（双数据模型+行内表单双重问题） | `quotes/views/quotation-records-view.tsx:41-73` |
| X8 | pricing-data | 矩阵单元格内联改价，无容器边界 | `pricing-data/components/PricingDataTable.tsx` |

**正面范式（保留并推广）**：events 事件详情用 Sheet 抽屉（`events/page.tsx:90-109`）；quotes 报价单详情用共享 `DetailDrawer`（`quotes/components/quote-order-records.tsx:237`）；orders 详情面板+对话框分离（`orders/components/order-detail-panel.tsx`）。

**逐处裁定建议**：X2（leadgen 线索详情，200 行）、X4（research 编辑表单，158 行）、X5（shipments 编辑面板，兼有数据丢失）应迁移为抽屉/对话框；X1/X3 迁抽屉；X6（audit-log 原始 JSON）属轻量折叠可保留但补键盘可达；X7 按记录表信息架构整改一并解决；X8 按单元格编辑的数据量判断，大矩阵改对话框。轻量二级展开（如 `quote-line-card.tsx:801-806` 的算价表"查看完整"）可保留，但必须有明确视觉容器（SectionCard/Disclosure），不得与行详情混排。

## 2. 根因分析：为什么"同一个模式，十种写法"

用户的判断被审计证据完全证实：**组件没有公共约束、缺少共用的设计，导致不同页面同一模式实现方式参差**。具体证据链：

| 重复模式 | 现状 | 证据 |
|---|---|---|
| 危险操作确认 | ConfirmDialog 共享组件存在，但仅 api-tokens/税档/公章/产品删除用；报价签发、群发、research 删除、灰度开关全裸奔 | `quotes/views/quote-workbench-view.tsx:562-585`、`outreach/page.tsx:226-245`、`research/page.tsx:232-240` |
| 列表分页 | PaginationBar 只有 orders/events/audit-log/receivables 用；trade-docs/shipments/leadgen/outreach/research 硬编码 `page_size` 且无分页 | `trade-docs/page.tsx:149-153`、`leadgen/page.tsx:199` |
| 表单字段 | `components/shared/form-field.tsx`（标签+错误+aria 三件套）**全仓库零使用**；各页 placeholder 当 label | `customers/page.tsx:336-397`、`research/page.tsx:571-695` |
| 详情面板 | DetailDrawer 只有 quotes 用；leadgen/outreach 各自内联 200 行 | `leadgen/page.tsx:666-872`、`outreach/page.tsx:614-635` |
| 错误/加载态 | LoadingBlock/EmptyState 有的页用有的页纯文本；8 个 error.tsx 全是 `<h2>`+裸 button | `trade-docs/page.tsx:696-699`、`events/error.tsx:12` |
| 状态映射 | OUTREACH/INQUIRY/CRAWL/RUN 状态 tone 映射在三个页各写一份 | `leadgen/page.tsx:86-149`、`outreach/page.tsx:67-88`、`research/page.tsx:104-130` |

**除了"无公共约束"之外的四个并发原因**：

1. **门禁只覆盖静态项，不覆盖复用与行为**。`ui-standards-check.cjs` 查 h1/裸 th/手写 tab/红绿黄/viewport——全是"写没写错"，不查"该用共享组件没用""危险操作没确认""搜索没防抖"。CI 全绿 ≠ 体验达标。
2. **UI_STANDARDS 只有禁令没有正面模板**。规范说"优先用 SectionCard""空列表用 EmptyState"，但没规定"一个标准列表页 = PageHeader + FilterBar + DataTable + PaginationBar 四个插槽"，新页面作者只能照抄最近看过的旧页面——坏味道由此复制。
3. **功能堆叠期没有重构窗口**。项目按工位高速长出来（报价→单证→出货→应收→增长 AI 组），每页都是"先跑起来"，Common 组件库长出来后没有回填机制（没有 boy-scout 规则、没有整改 sprint）。
4. **前端没有契约文化**。后端有 R0–R5 冻结契约 + `contracts:check` + 金标 harness；前端侧共享组件没有任何"契约/清单/机检"，`shared/` 组件改了不破坏任何调用方，也没人知道全站有哪些模式——与后端的纪律完全不对称。

## 3. 解决方案：组件契约体系（四层）

**核心思路 = 用户提出的：规定每个组件/模式的唯一正规实现 → 共同约束 → 统一设计 → 共用组件。**

### L1 模式契约（写进 UI_STANDARDS，作为 DoD）
为每个重复模式定义"唯一正规实现 + 反例"：
- 标准列表页 = `PageHeader` + `FilterBar`（防抖+重置） + `DataTable`（声明式列+空态/loading 插槽） + `PaginationBar`；
- 标准表单 = `FormField`（label+控件+错误+aria-invalid/describedby）；
- 危险/不可逆操作（签发、发送、删除、作废、清除密钥、停用）**必须** `ConfirmDialog`，文案写后果；
- 详情/编辑**默认不用行内展开**（§1.5）：详情默认 `DetailDrawer`，编辑默认 `Dialog`/独立页；轻量二级折叠可保留，按数据量判断，非一刀切禁令；
- 任何 async mutation：pending 禁用 + onError toast，二者缺一即不合规；
- 错误/加载/无权限分支必须保留 `PageHeader`（h1）+ 重试入口；
- 请求失败 ≠ 空态：isError 分支必带 `role="alert"` + 重试。

### L2 补齐共享原语（组件库缺什么补什么）
- `DataTable`（表头声明式 + 空态/加载/分页插槽，收编各页手写 `<table>`）；
- `ErrorState`（带 reset 重试 + role="alert"）；
- `FilterBar` / `useDebouncedValue`（收编 6 页零防抖搜索）；
- `ConfirmDialog` 推广 + 禁止 `window.confirm/alert/prompt`；
- 状态 tone 映射抽到 `lib/status-tones.ts` 单一来源；
- 路由筛选状态统一 `usePersistentState → URL query`（刷新不丢、可分享）。

### L3 机检升级（把 L1 从"文档约定"变成门禁）
扩展 `pnpm ui:standards` 或新增 `pnpm ui:patterns`，可静态检出的规则：
- 禁 `window.confirm/alert/prompt`；
- 禁裸 `<table>`（必须包共享 Table/DataTable）；
- 禁数据区纯文本"加载中/暂无"（必须 LoadingBlock/EmptyState）；
- `useMutation` 缺 `onError` 报警（AST 级，shadow  CI 先 warn 后 error）；
- 图标按钮缺 aria-label（已有）；
- `page_size` 硬编码且无 PaginationBar 报警。
先 shadow 模式跑一周收集违规清单，再转强制。

### L4 迁移与治理
- **碰到的页面即整改**（boy-scout）：任何 PR 动了某页，该页须达到 L1 契约才能合入；
- 一次性整改冲刺：按 §5 路线图的 P0/P1 清单分批，每批跑全量门禁；
- PR 检查清单挂 L1 契约链接；结构清理（拆 7 个巨型文件、删 `/quotations` 幽灵目录与 FreightPanel 死代码、合并状态映射）随各批顺手做。
## 4. 逐页问题清单（P0/P1 全量 + P2 摘要）

### 4.1 核心业务组（dashboard / quotes / products / customers / orders）

**Dashboard**（已改占位页）
- D1 P1 错误分支 `<h2>` 手写标题无 PageHeader —— `dashboard/error.tsx:12`
- D2 P2 loading 分支无页头 —— `dashboard/loading.tsx:3-17`
- D3 P2 死代码 RangeSelector + useDashboard 仅测试引用 —— `dashboard/components/range-selector.tsx:16`、`dashboard/hooks/use-dashboard.ts:9`

**Quotes 报价工位**
- Q2 P1 「签发报价单」对外生效入账无二次确认 —— `quotes/views/quote-workbench-view.tsx:562-585`
- Q3 P1 「生成所选单证」无确认无幂等，可重复生成 PI/合同；成功无跳转死路 —— `quote-workbench-view.tsx:587-629`
- Q9 P2 createInquiry 无 onError，失败无反馈 —— `quote-workbench-view.tsx:138-156`
- Q10 P1 批量「生成报价单」无确认+成功不清空，同批询盘可重复建 N 单 —— `quotes/views/batch-quote-view.tsx:281-293`
- Q11 P2 批量页硬编码利润率 0.06/30 天/USD，与单条报价政策割裂 —— `batch-quote-view.tsx:203-212`
- Q12 P2 批量算价串行逐条 POST 无进度 —— `batch-quote-view.tsx:244-262`
- Q15 P1 人工录入报价提交失败静默 + invalidate key 不匹配导致列表不刷新（`["quotations"]` vs `["events","list",filters,"quotations"]`）—— `quotations/components/new-quotation-form.tsx:58-76`、`quotations/hooks/use-quotations.ts:81`、`quotes/views/quotation-records-view.tsx:44`
- Q16 P2 录入表单预置假客户 `cust-lianjia` 和数量 100 —— `new-quotation-form.tsx:44-54`
- Q13 P2 记录页同屏 4 套东西（quote_orders 表+录入表单+筛选+旧台账 quotations 表），双数据模型并存 —— `quotation-records-view.tsx:41-73`
- Q14 P2 「搜索」按钮实为清空筛选（名不对实）—— `quotations/components/quotation-filters.tsx:63-66`
- Q17 P2 记录表行 onClick 键盘不可达 —— `quotes/components/quote-order-records.tsx:178-183`
- Q18 P2 记录表固定 50 条无分页 —— `quotes/hooks/use-quote-orders.ts:51`
- Q19 P2 虚拟化分支 tr>td>div>tr 非法嵌套 —— `quotations/components/quotation-table.tsx:156-179`
- Q4/Q5/Q6/Q7/Q8 P2 手写 modal 无焦点圈禁 / select 嵌在 CardTitle / hidden 表单可 Tab 聚焦 / 删行无确认 / notice 显示 Markdown 星号 —— `quote-workbench-view.tsx:808-849`、`quote-line-card.tsx:419-447,508,454-463`、`quote-workbench-view.tsx:544`
- R1 P2 `/quotations` 无 page.tsx 却是被 `/quotes` 反向引用的组件目录（幽灵路由+脆弱相对引用）—— `quotes/components/quote-line-card.tsx:24`
- R2 P2 死代码 FreightPanel(427 行)+defaultSpecRow —— `quotations/v2-quote/components/freight-panel.tsx:139`、`spec-picker.tsx:218`

**Products**（整体质量高；图片相关已排除）
- P5 P2 详情三保存入口（顶部/基本信息/价格区）patch 范围各异易漏存 —— `product-detail.tsx:267,347-359,430`
- P6 P2 巨型文件 product-spec-editor 1142 行 —— `product-spec-editor.tsx`
- P1/P2/P4 P2 裸 section 非 SectionCard / 每卡一次媒体请求 N+1 / JSON 错误文案称阻止保存但 saveProduct 不检查 —— `products/page.tsx:88-100`、`product-card.tsx:29`、`advanced-spec-settings.tsx:36`

**Customers**
- C1 P1 详情弹窗手写 tab（无 tablist/aria-controls/方向键），违反 ui:tabs 硬门禁 —— `customers/page.tsx:897-914`
- C5 P2 搜索零防抖每键一请求 —— `customers/page.tsx:1446-1449`
- C6 P2 客户数用 items.length 而非 total —— `customers/page.tsx:1513`
- C7 P2 巨型文件 1674 行（列表+详情+4 表单+弹窗一体）—— `customers/page.tsx`
- C2/C3/C4 P2 window.alert / 删联系人失败静默 / placeholder 当 label —— `customers/page.tsx:834,845-847,336-397`

**Orders**（本组质量最高）
- O1 P2 「转为订单」无确认 —— `orders/page.tsx:100-113`
- O3 P2 登记收款标题"第 {schedule.id} 期"把数据库主键当期次号（"第 57 期" vs 列表 "#3"）—— `orders/components/register-receipt-dialog.tsx:123`
- O4 P2 收款计划加载纯文本 —— `payment-schedules-panel.tsx:370-373`
- O5 P2 列配置 `<details>` 浮层无 Esc/外点关闭 —— `orders/page.tsx:198-234`
- O6 P2 order-create-wizard 1366 行 —— `order-create-wizard.tsx`
### 4.2 单据履约组（trade-docs / shipments / receivables / pricing-data / spec-config / events）

**Trade-docs 单证工位**（签发闸门/阻断清单扎实，问题在主页交互）
- T1 P1 作废已签发法律凭证无确认，点击即 PATCH —— `trade-docs/page.tsx:607-615`
- T2 P1 预览区加载纯文本"正在装配单据数据…" —— `trade-docs/page.tsx:696-699`
- T3 P1 台账硬编码 page_size 100 且 total 取了不用，无分页死路 —— `trade-docs/page.tsx:149-153`、`hooks/use-trade-docs.ts:63-68`
- T4 P1 DocCustomForm 无 key，切单证时表单缓存串单（A 单内容存到 B 单，数据损坏级）—— `trade-docs/page.tsx:713-720`
- T5 P1 编辑态行内删除按钮无 aria-label —— `trade-docs/components/doc-set-panel.tsx:231-239`
- T6-T12 P2 行内签发无 disabled 防重 / 筛选不持久化且切换闪 skeleton / 预览失败无重试 / window.confirm 恢复版本 / select 无 accessible name / details 弹层 / 合并打印失败不报进度 —— `trade-docs/page.tsx:597-604,120-121,700-704`、`doc-content-versions.tsx:150-155`、`sample-preview.tsx:54-72`

**Shipments**
- S1 P1 编辑面板依赖当前列表行存在（`rows.find`），推进/改筛选后未保存修改静默丢失 —— `shipments/page.tsx:137`
- S2 P1 建单/保存/推进三个 mutation 全无 onError，失败零反馈 —— `shipments/page.tsx:106-134`
- S3-S7 P2 无分页 / 订单下拉无 accessible name / ETD-ETA 自由文本无校验 / 状态推进单向无确认 / 错误分支无重试 —— `shipments/page.tsx:100-101,151-163,77-78,274-289,206-210`

**Receivables**（本组最好）—— R1 P2 每逾期行 role="alert" 会连续播报 20 条 —— `receivables-table.tsx:135-139`；R2 P2 翻页清筛选无提示 —— `receivables/page.tsx:222-224`

**Pricing-data**
- PD1 P1 请求失败伪装成"该产品未声明定价键"（仅处理 403，500/网络落入空态）—— `pricing-data-manager.tsx:75-78`、`PricingDataTable.tsx:58-68`
- PD2 P1 「恢复兜底」停用自定义成本无确认，影响后续所有报价 —— `PricingDataTable.tsx:222-234`
- PD3-PD6 P2 加载纯文本 / notice 无 aria-live / 裸 Card 非 SectionCard / 手写 pill 当 tab —— `pricing-data-manager.tsx:163-164,190-194`、`PricingDataTable.tsx:96,272`、`pricing-data-manager.tsx:171-188`

**Spec-config（含 wizard）**
- SC1 **P0** 向导提交失败完全无反馈（handleSubmit 无 try/catch + hook 无 onError），用户以为没点上可无限重点 —— `spec-config/components/QuoteWizard.tsx:97-137`、`hooks/use-wizard-submit.ts:12-23`
- SC2 P1 totalSteps 硬编码 5，品类缺 variant 组时实际 4 步，第 5 步空白只有提交按钮 —— `QuoteWizard.tsx:54,172,346-364`
- SC3 P1 品类树 div+onClick 键盘完全不可用 —— `spec-config/components/CategoryPicker.tsx:72-95`
- SC4 P1 主页无错误分支无空态 —— `spec-config/page.tsx:11,33`
- SC5 P1 属性提议弹窗提交无 try/catch，失败无声成功也无 toast —— `AttributeProposeDialog.tsx:50-71`
- SC6-SC11 P2 继续录入不清 pricing/重量 / react-hook-form+zod 引入未用 / Label 未关联+FormField 未复用+价格允许 0 负 / 步骤指示器无 aria-current 且无 flex-wrap / wizard 页 Suspense fallback null / 成功页无跳转死路 —— `QuoteWizard.tsx:158-163,88,177-243`、`DynamicSpecForm.tsx:4-6`、`wizard/page.tsx:68-74`、`QuoteWizard.tsx:150-169`

**Events 事件审计**
- E1 P1 查询失败显示"暂无事件数据"（无 isError 分支）—— `events/page.tsx:30-39`、`event-table.tsx:121-129`
- E2 P1 「搜索」按钮实为清空筛选且与 X 重复 —— `event-filters.tsx:85-88`
- E3-E8 P2 可筛选类型硬编码 2 个（labels 认识 11 种）/ 无防抖 / 详情从当前页 find 翻页即关 / 虚拟滚动死代码且 DOM 非法 / error.tsx 手写 h2+裸 button / "查看详情（一般不需要看）"文案劝退 —— `event-filters.tsx:16`、`events/page.tsx:37-39,90-109`、`event-table.tsx:131,153-194`、`events/error.tsx:11-20`、`event-detail.tsx:96-103`

### 4.3 增长 AI 组（intel / leadgen / market / outreach / research / kb）

**Intel**
- I1 P1 四个视图错误态均纯文本无重试无 role="alert" —— `shipments-table.tsx:164-167`、`trade-stats-view.tsx:100-103`、`channels-view.tsx:28-34`、`adapter-runs-list.tsx:51-54`
- I2 P1 空态未用 EmptyState（同目录 shipments-table 却用了，全页不一致）—— `trade-stats-view.tsx:145-147`、`adapter-runs-list.tsx:102-104`
- I3 P1 贸易统计无重置 + trade_flow 自由文本 —— `trade-stats-view.tsx:33-35,69-79`
- I5-I9 P2 全裸 Card 非 SectionCard / tab keepMounted=false 切走丢筛选 / 六输入框无 form 无 Enter 提交 / 货运记录 7 列无详情入口（数量/重量/金额/提单号不可达）/ 采集任务无刷新 / truncate 无 title —— `intel/page.tsx:52,55`、`shipments-table.tsx:91-146,184-209`、`adapter-runs-list.tsx:16`

**Leadgen**
- L1 P1 巨型组件 881 行（含 200 行内联详情面板）—— `leadgen/page.tsx:666-872`
- L2 P1 加载中显示"暂无线索"空态（无 isLoading 分支）—— `leadgen/page.tsx:196-210,524-528`
- L3 P1 「详情」按钮失败静默死路 —— `leadgen/page.tsx:274-277`
- L4 P1 「扫描已回复→询盘」无 pending 可重复提交 —— `leadgen/page.tsx:259-272,396-398`
- L5 P1 搜索零防抖 —— `leadgen/page.tsx:196-209`
- L6 P1 列表 page_size 100 无分页 —— `leadgen/page.tsx:199`
- L16-L23 P2 csv 源时"开始抓取"可用但必错 / 数量输入 NaN 脏值 / text-blue-600 硬编码 / 配置区无标签 / 内联详情挤压表格 / 运行历史只 10 条 / 单行爬取全局禁用无 spinner / spec truncate 无 title —— `leadgen/page.tsx:235-238,333-334,683,772,346-381,437,623-631`

**Market**
- M1 P1 搜索无防抖三处（品名/港口/name-mapping）—— `market-view.tsx:238,349`、`name-mapping-panel.tsx:93-97`
- M2 P1 "搜索中…"纯文本（同页 RegionTab 却用 LoadingBlock，双标）—— `market-view.tsx:264`
- M3 P1 五处空态纯文本 —— `market-view.tsx:265-267,321-325,368-370`
- M4 P1 五 tab 全无 isError，失败显示"暂无数据" —— `market-view.tsx:129,238,301,349`
- M5 P1 UsageTab 无加载态整块空白 —— `market-view.tsx:301-314`
- M29-M33 P2 地区按钮无 aria-pressed / 左列无 max-h 滚动 / demand_level 英文未本地化 / 裸 Card / 提交中取消可点 —— `market-view.tsx:143-153,187-195`、`name-mapping-panel.tsx:356`

**Outreach**
- **O0 P0 群发邮件无二次确认无 pending，连点重复发送**（不可逆批量外发）—— `outreach/page.tsx:226-245,510-518`
- O35-O40 P1 AI 起草无 loading / 添加邮箱+创建活动无 pending / setDefault 无 try/catch / window.prompt 收集测试收件人 / 三区加载中闪空态 / 640 行巨型组件 —— `outreach/page.tsx:187-209,150-164,211-224,166-170,172-185,111-137`
- O41-O45 P2 bg-blue-100 硬编码 / 收件人无邮箱仍可勾选 / 消息无分页+select 无 aria-label / 裸 textarea+内联预览 / Mailbox.enabled 无 UI 入口 —— `outreach/page.tsx:332,492-496,526,389-396`

**Research**
- **R0 P0 删除调研产品无二次确认**，误触永久丢失深化数据 —— `research/page.tsx:232-240,532-539`
- R47 P1 深化/移除 icon-only 按钮只有 title 无 aria-label —— `research/page.tsx:524-539`
- R48 P1 加载中与筛选无结果都显示"暂无调研产品" —— `research/page.tsx:426-431,726-731`
- R49 P1 搜索无防抖 —— `research/page.tsx:383-388`
- R50 P1 列表 page_size 200 无分页，**导出 CSV 静默截断**用户以为导了全量 —— `research/page.tsx:164,184,292`
- R51-R57 P2 868 行巨型组件 / label 未关联 / saveEdit+remove 无 pending / 统计卡加载中亮 0 / Tabs 无 TabsContent / 状态映射与 leadgen 重复 / 裸 table —— `research/page.tsx:324-344,571-695`

**KB**
- K1 P1 **伪造统计数据**（"知识条目 48/产品品类 6/最近更新 2 小时前"硬编码假数据冒充真实指标）—— `kb/page.tsx:13-18,32-47`
- K2 P1 error.tsx 无页头+裸 button —— `kb/error.tsx:10-21`
- K3 P2 loading 无页头 —— `kb/loading.tsx:3-21`
### 4.4 设置组（settings ×6 / team / onboarding）

**/settings 主页**
- A1 P1 RouteGuard 无权限兜底无页头无 h1 无返回入口（被所有 adminOnly 页共用）—— `components/route-guard.tsx:59-66`
- A2 P1 「重载产品配置」全局危险操作无确认无错误处理 —— `settings/components/reload-button.tsx:23-37`
- A4/A5 P2 租户 locale/region 硬编码 zh-CN/cn-north 造假 / 密钥状态写死"已配置" / 与底部"系统对接密钥"命名撞车 —— `settings/page.tsx:76-77,98-105`
- A6/A7/A9 P2 全裸 Card 非 SectionCard / 入口卡片在 tab 外滚动才能发现 / 恢复按钮无 pending —— `settings/page.tsx:53,66,92,118,141`、`account-management.tsx:194-200`
- B1/B2 P2/P1 loading 与 error 分支丢页头 —— `settings/loading.tsx:3-11`、`settings/error.tsx:11-20`

**/settings/ai-providers**
- **C1 P0 「保存」按钮空输入实为清除密钥**：密钥已配置+输入框为空时按钮可点，PUT `{api_key:""}` 永久清密钥，无确认 —— `settings/ai-providers/page.tsx:234-243`
- C2 P1 另一条清除路径同样无确认 —— `page.tsx:255-272`
- C3 P1 模型输入每按键发一次 PUT（请求风暴+竞态，输入中弹"保存失败"）—— `page.tsx:337-343`
- C4-C7 P2 开关无 pending / 保存测试无禁用 / 首屏徽标误显"关闭"/"未配置" / 原生 table / p-6 双内边距 —— `page.tsx:310-319,234-253,213-224,285,404,195-199`

**/settings/api-tokens**（质量标杆：明文只显示一次的拦截是范本）
- D1 P1 面向所有登录用户但客户账号零 UI 入口（唯一链接在 adminOnly 的 /settings 里）—— `settings/page.tsx:127-133`
- D2 P2 revoked 密钥只增不减无清理 —— `api-tokens-view.tsx:215-217`

**/settings/company-profile**
- E1 P1 校验失败只有 toast 无字段级反馈，FormField 全仓零使用 —— `company-profile/page.tsx:190-194`
- E2 P2 15+ 字段无"未保存"提示，误触导航静默丢失 —— `page.tsx:184-199`
- E3 P2 空串转 null 只实现一半（bank_name/address_en 空串原样进 payload）—— `company-profile-rules.ts:60-67`
- E4 P2 help 文本在 label 内污染可访问名 —— `page.tsx:203-215`

**/settings/tax-archives**
- F1 P1 产品税率"停用"实为 DELETE 零确认（同类三个操作中唯一漏确认的）—— `tax-archives/page.tsx:616-623`
- F2/F3 P2 空态纯文本 / fx 历史与条款模板加载纯文本 —— `page.tsx:383-385,561-563`、`fx-history-card.tsx:76-78`、`clause-templates-card.tsx:196-198`
- F4/F5 P2 销项税率默认 "0" 误导（实务 13%）/ 0% 税率显示成"—"与未设置不分 —— `page.tsx:57,421-424`
- F6/F7 P2 645 行巨型页 / 死代码 try/catch（mutate 不会同步抛错）—— `page.tsx:108-644,249-253`

**/settings/tenant-products**：G1 P2 重定向占位无页头 —— `page.tsx:33-37`

**/team**
- H1 P1 移除成员/转让管理权用 window.confirm（转让是不可逆自我降权，失败无错误说明）—— `team-members-panel.tsx:66-72,101-108`
- H2/H3/H4/H5 P2 工位停用全团队即时生效无确认 / 邀请撤销无确认 / 邀请邮箱无格式校验 / 刷新无 pending —— `team-subscriptions-panel.tsx:85-99`、`team-invites-panel.tsx:274-282,80-89`、`team/page.tsx:122-126`
- H6 P2 无团队分支裸 Card —— `team-setup.tsx:99,142`

**/onboarding**
- I1 P1 纯静态无进度状态无断点续做（注册后被强制落入，老用户也看"新手引导"）—— `onboarding/page.tsx:16-91`
- I2 P1 步骤 1 是死卡片（无按钮无链接无状态）—— `page.tsx:24-38`
- I3/I4/I5 P2 无跳过入口 / 动作不判工位前置（未开通 quotes 点"智能报价"落拦截页）/ 裸 Card+双内边距 —— `page.tsx:55,80,18,24`

### 4.5 管理组（admin ×3 / audit-log / billing）

**admin/gray-release**
- G1 P1 确认弹窗无 pending 禁用可重复提交（外层切换按钮反而有，两处标准不一）—— `flag-toggle.tsx:110-117`
- G2 P1 切换失败静默且对话框卡死（mutateAsync 无 try/catch，setOpen(false) 不执行）—— `flag-toggle.tsx:32-39`
- G3 P1 flags 查询失败渲染成"已关闭"（未知状态伪装成事实，高风险对象）—— `gray-release/page.tsx:55`、`flag-toggle.tsx:63-65`
- G4 P1 tenants 失败渲染空白网格 —— `page.tsx:41-59`
- G5-G8 P2 成功无 toast / actor_id 硬编码 "admin-1" / bg-gray-300 硬编码+Card 套 Card / 空网格无 EmptyState —— `flag-toggle.tsx:38,47,70`、`page.tsx:36-61`

**admin/spec-proposals**
- SP1 P1 审批/驳回/合并失败完全静默（无 onError）—— `page.tsx:91-116`
- SP2 P1 合并要求手输内部属性 ID（无法校验、暴露内部 ID）—— `page.tsx:271-281`
- SP3-SP7 P2 合并高风险但默认按钮样式 / 325 行单文件 / 对话框缺 DialogDescription / 双 tab 常驻双请求+无 toast+无 usePageView / pending 中可关窗 —— `page.tsx:215-238,249,252-258,70-89`

**admin/teams**：AT1-AT4 P2 裸 Card / 无搜索无分页全量拉取 / 行点击与行内按钮双入口 aria-label 重复播报 / 详情弹窗写死 1080px —— `admin/teams/page.tsx:189-208,176-181,258-269,96`

**audit-log**
- AL1 P1 可展开行键盘完全不可操作（无 tabIndex/onKeyDown/role/aria-expanded；teams 页有完整范式）—— `audit-log/page.tsx:148-151`
- AL2 P1 四个筛选控件无可访问名 + date 输入 placeholder 无效摆设 —— `page.tsx:91-129`
- AL3-AL8 P2 reason 截断无 title / 空态文案误导（无筛选也说"调整筛选"）/ formatTime 缺年份 / 水合前多发空筛选请求 / actor_id 筛选缺失 / chevron 未 aria-hidden —— `page.tsx:174-176,289-293,62-70,229-250`

**error/loading 系统性问题**：audit-log/gray-release/dashboard/events/kb/settings + 根 error.tsx 共 8 处 error.tsx 全是 `<h2>`+裸 button 无页头无 role="alert"；loading 分支同样丢页头；错误 digest 未透出 —— 如 `audit-log/error.tsx:12,14-19`、`app/error.tsx:12`

**billing**：确认为占位页（仅"即将开放"文案，无数据无入口）；P2 静态内容却 "use client" / 无 usePageView —— `billing/page.tsx:11-18`

### 4.6 认证流与全局外壳

**登录/注册/忘记/重置**
- L1/L2 P2 登录无邮箱格式前置校验；错误提示不关联字段（无 aria-invalid/describedby）—— `login/page.tsx:30-33,169-176`
- L3 P2 品牌栏 h1 在 <768px 隐藏，移动端整页无可见 h1；标题层级倒挂 —— `login/page.tsx:65`、`auth-shell.tsx:53,63`
- R1 P2 注册页用 useSearchParams 未包 Suspense（静态导出下与 reset-password 处理不一致）—— `register/page.tsx:91-96`
- R3 P2 WorkstationPicker 的 Label htmlFor 指向 div（无效关联）—— `workstation-picker.tsx:39-43`
- RP1 P2 重置密码 URL 无 token 仍渲染完整表单，填完才报"链接无效"—— `reset-password/page.tsx:46,67-70`

**setup-admin**：SA1 P2 CardTitle 实为 div，整页无标题元素；SA2 错误无 role="alert"；SA3 未用 AuthShell 视觉割裂 —— `setup-admin/page.tsx:76-79,129`

**全局**
- **G1 P1 全局 404 缺失**：无 not-found.tsx，静态导出下未知 URL 显示 Next 默认英文 404 —— `frontend/src/app/not-found.tsx`（不存在）
- G3 P1（模式）根 error.tsx 及 6 个 (app) error.tsx 无页头 —— `app/error.tsx:12`
- G4 P2 global-error 的 html 缺 lang；StrictMode 双渲染重复上报 Sentry —— `app/global-error.tsx:12,14`
- G5 P3 setupAdmin 跳 /dashboard 而根页注释称落点应是 /customers，口径不一 —— `auth-context.tsx:175`、`app/page.tsx:9-11`

**Header/侧边栏**
- H1 P2 全局无搜索无通知中心；H2 P2 团队名徽章 <768px 看不到"我在哪个团队"（正是注释自称的第一线索）；H3 P2 面包屑无 truncate 窄屏溢出风险 —— `header.tsx:59-108,101-106,68-99`
- S1/S2 P2 修改密码两输入框只有 placeholder 无 Label；折叠开关无 aria-expanded —— `sidebar.tsx:361-375,349-358`

**守卫**
- **A1 P1 token 过期链路断层**：AuthGate 只看 cookie 不看有效性 → 先挂系统外壳 → /teams/me + /me/workstations 并发 401 → 两次"登录已过期"toast + 两次跳转竞态，且先闪一瞬骨架；redirectToLogin 无防重 —— `(app)/layout.tsx:26-37`、`lib/api/error-handler.ts:81-89`
- W1 P1 工位引导页无 h1 无 PageHeader（用户实际会撞上的全页替换态）—— `workstation-gate.tsx:35-110`
- W2 P2 has_team 缺失时有团队用户被误显示"你还没有加入团队"（与注册页警告矛盾）—— `workstation-gate.tsx:121`、`lib/workstation/visibility.ts:203-206`
- （正面）未开通工位直输 URL 的双路径拦截已正确覆盖，ok=false 降级放行不锁死用户

**共享组件**
- customer-picker：清除已选客户是 span role=button tabIndex=-1 无 keydown（键盘永远无法清除）；关闭后焦点不返还；listbox 无 aria-activedescendant —— `customer-picker.tsx:189-199,151-155`
- number-edit-dialog 错误无 role="alert" 无 aria-describedby —— `number-edit-dialog.tsx:78`
- stat-card 涨跌图标未 aria-hidden —— `stat-card.tsx:59-66`
- （正面）PageHeader/EmptyState/LoadingBlock/PaginationBar/StatusBadge/CopyButton/ConfirmDialog/DetailDrawer 本身符合规范；reduced-motion 全局降级到位

## 5. 跨页面共性问题（结构汇总）

1. **巨型文件 7 个 >800 行**：customers/page 1674、order-create-wizard 1366、product-spec-editor 1142、quote-workbench-view 924、leadgen/page 881、research/page 868、payment-schedules-panel 698。
2. **搜索零防抖**：customers/leadgen/market×3/outreach/research/events 共 8 处。
3. **无分页或分页不可达**：trade-docs/shipments/leadgen/outreach/research + quotes 记录表；research 导出静默截断。
4. **筛选状态不落 URL**：quotes/intel/trade-docs/events 等，刷新丢、不可分享、前进后退失效。
5. **加载中=空态、失败=空态**：leadgen/research/outreach/market/events/pricing-data/gray-release 共性。
6. **window.confirm/alert/prompt**：trade-docs/team/customers/outreach 各若干。
7. **/market 与 /intel 的"产品市场对照"渲染同一组件**（market-view），若侧边栏双入口则重复入口，建议收敛（待确认入口现状）。
8. **leadgen"爬取网站"与 research"从地图源挑选"职责边界只靠 description 文字区分**，新用户易混。

## 6. 修复路线图（建议顺序）

| 批次 | 内容 | 覆盖 |
|---|---|---|
| 第 1 批（P0/P1 止血，约 20 处） | 群发/删除/作废/签发/清密钥/税率删除补 ConfirmDialog；spec-config 向导 try/catch； shipments/records/leadgen 详情/gray-release/spec-proposals 补 onError；events/pricing-data/gray-release 失败态与空态分离；token 过期 401 防重+跳转去重；ai-providers 空输入禁保存+模型输入改失焦保存；DocCustomForm 加 key；trade-docs 接分页 | 全部 P0 + 多数 P1 |
| 第 2 批（规范补齐） | 8 个 error.tsx + loading 分支统一 PageHeader；RouteGuard/WorkstationGate 兜底补页头与 role="alert"；新增全局 not-found.tsx；纯文本加载/空态换 LoadingBlock/EmptyState；补 aria-label（research/doc-set-panel/audit-log 筛选） | 规范硬性项 |
| 第 3 批（共享原语） | DataTable/FilterBar/ErrorState/useDebouncedValue 上线；状态 tone 映射抽 lib；FormField 首批接入 company-profile；筛选状态入 URL | L2 |
| 第 4 批（门禁升级） | ui:patterns 静态规则（禁 window.*、禁裸 table、禁纯文本加载、mutation 缺 onError 报警）shadow 一周转强制 | L3 |
| 第 5 批（结构清理） | 拆 7 个巨型文件；删 /quotations 幽灵目录+FreightPanel 死代码；onboarding 补进度状态；kb 假统计下线；收敛 /market 与 /intel 重复入口 | L4 |

> 本报告与并行任务（产品图片上传、拖拽排序）无重叠；整改触及那两个区域时以并行任务方案为准。

## 7. 复跑机制（用户 2026-10-22 要求，硬性待办）

**本报告是 2026-10-22 的快照，不是终态。** 待办触发条件与动作：

1. **并行任务完成后**（产品图片上传优化、拖拽排序改造）：复跑全站审计，把这两个区域纳入本报告，核对是否与既有发现冲突；
2. **每批整改完成后**（§6 第 1–5 批）：对应条目标注"已修复+证据"，过时状态必须改掉（本项目铁律：宁可标注"未做"，不能让文档写着旧状态）；
3. **全部收尾后**：按更改后的项目状态更新 `docs/UI_STANDARDS.md`（把 L1 契约条文正式并入）与 `docs/README.md` 索引（本报告入口）；
4. 复跑方式：按本报告 §4 的范围重新逐页通读 + 门禁（`pnpm ui:standards` / `ui:contrast` / `e2e`）结果一并记录。

## 8. 2026-10-23 复跑基线（M1/M2/M3 落地后）

> 本轮复跑范围：**新实现**（M1-f 门面收口、M2-A /inquiries、M2-B 订单来源链/明细编辑、M2-C 审批中心/通知、
> M3 dashboard 漏斗）+ 受影响旧页面的状态校正。**完整可执行方案已重写为
> [`UI_EXECUTION_PLAN_2026-10-23.md`](./UI_EXECUTION_PLAN_2026-10-23.md)**；本报告保留为 2026-10-22 证据快照，
> 其 P0/P1 清单**仍然有效**（未动过的旧页面一条都没修）。

### 8.1 已取代 / 已变化（逐条可核）

| 旧条目 | 现状 | 证据 |
|---|---|---|
| D1/D2/D3（dashboard 占位页、死代码 RangeSelector/useDashboard） | 占位页 → 漏斗看板；`use-dashboard.ts` 删除；RangeSelector 扩 90d 并被复用 | `dashboard/page.tsx`、`lib/dashboard/funnel.ts` |
| Orders 组 | 新增来源列/筛选/来源链/明细编辑/变更审批入口；O1–O6 中 **O3/O4/O5/O6 仍在** | `orders/page.tsx`、`register-receipt-dialog.tsx:123` |
| Quotes 记录 | 已加「编辑报价单」入口 + 锁定说明；Q13/Q17/Q18 仍在 | `quotes/components/quote-order-records.tsx` |
| Customers | UnlinkedRecords 语义改为「直接下单（正常分类）」并默认展开；C7 巨型文件仍在 | `customers/components/inquiry-followups.tsx` |
| 导航/外壳 | 新增 `/inquiries`、`/approvals`（R2=30）；新增通知铃铛（header）与审批待批角标（sidebar） | `shared/contracts/workstations.ts`、`components/layout/notification-bell.tsx` |
| 新页面范式 | `/inquiries`、`/approvals` 已按 PageHeader/DetailDrawer/ConfirmDialog/EmptyState 实现，可直接作为整改参照 | 对应 `page.tsx` 与组件 |

### 8.2 仍未做（本报告 §4 的 P0/P1，全部保留）

- 危险操作确认：outreach 群发（O0 P0）、research 删除（R0 P0）、ai-providers 清密钥（C1/C2 P0/P1）、quotes 签发（Q2）、批量建单（Q10）、trade-docs 作废（T1）、settings 重载（A2）、tax 税率删除、window.prompt 收件人；
- 失败静默：spec-config 向导（SC5）、shipments×3、records 录入、gray-release、spec-proposals、leadgen 详情（L3）、quotes Q9/Q15、outreach setDefault；
- 失败当空态：events（E1）、pricing-data、market 五 tab（M4/M5）、gray-release flags、kb 假统计（K1）；
- 防重：群发、AI 起草、批量抓取、扫描已回复（L4）、模型输入每键 PUT（C3）；
- 页头/错误边界：8 个 error.tsx、loading 分支、RouteGuard（A1）、WorkstationGate（W1）、全局 not-found；
- 行内展开迁移：X1–X8（用户已裁定默认不用行内展开）；
- 结构债：7 个巨型组件、幽灵 /quotations、FreightPanel 死代码、状态 tone 三处重复。

### 8.3 本轮新增发现（M1/M2/M3 自带的「最后一段」缺口）

1. 订单列表「有变更待批」角标缺后端计数（避免逐单 N+1）——见新方案 P0-A/A1；
2. 审批聚合行不含 `affected_docs`，详情需另拉 `/trade-docs`（403 时降级）——A2；
3. dashboard 应收概览无后端聚合端点（当前为明确空态，不造假数字）——A3；
4. 通知 link 内核用 `/orders/{id}` 而前端只有 `/orders?id=`（前端已归一，建议内核改）——A4；
5. `direct_orders.amount` 未分币种直接 SUM——A5；
6. 报价编辑 PUT items → PATCH header 两次调用非原子——A6；
7. 订单明细无拖拽排序（全站排序规范=拖拽）——A7；
8. 客户询盘表单渠道枚举老清单已修（本轮完成）——A8。
