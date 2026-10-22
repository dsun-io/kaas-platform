# KaaS 前端设计系统 PRD · 组件契约与页面范式 v0.1

> 2026-10-22 · 依据 `docs/UI_UX_AUDIT_2026-10-22.md` 的设计层落地文档。
> 定位：**规定每个重复模式的唯一正规实现**，作为新增页面/组件的 DoD 与存量整改的目标态。
> 范围：`frontend/src/app/(app)` + `frontend/src/components`。**不含**产品图片上传与拖拽排序（并行任务）。
> 状态：v0.1 设计稿，待用户拍板项见 §10；拍板后并入 `docs/UI_STANDARDS.md` 成为硬性约束。

## 0. 背景与目标

审计结论：同一模式全站十种写法（ConfirmDialog 4/10 页用、PaginationBar 4/10、FormField 零使用、DetailDrawer 1/10），根因是**没有规定"正规实现"**。本 PRD 的目标：

1. **一个模式一个正规实现**：列表、详情、编辑、表单、危险操作、异步操作、三态（加载/错误/空）各有唯一默认范式；
2. **共用组件收编**：能共享的一律共享，页面只写业务差异；
3. **可机检**：每条契约尽量能被静态检查/e2e 验证，不靠"记得"；
4. **默认合理、例外有据**：默认范式覆盖 80% 场景，例外（轻量折叠等）按数据量/复杂度判断并记录理由。

非目标：不改视觉品牌（玻璃拟态风格保留）；不动后端契约；不重构业务逻辑。

## 1. 设计原则

1. **列表只放摘要**：行内不展开详情、不铺开编辑表单（详情默认抽屉、编辑默认对话框/独立页，按数据量判断）；
2. **状态必须可感知**：任何异步操作有 pending；任何失败有错误+重试；空态分"无数据"与"筛选无结果"；
3. **危险操作必有确认**：不可逆/对外生效/批量操作必须 ConfirmDialog 且文案写后果；
4. **状态可分享**：筛选/分页/ tab 状态入 URL query，刷新不丢、可转发；
5. **键盘全可达**：核心交互（打开详情、提交、展开）键盘可完成，焦点可见、对话框焦点圈禁+归还。

## 2. 设计令牌（Design Tokens）

复用现有 globals.css 体系，本 PRD 只做**收敛规则**，不造新令牌：

| 类别 | 令牌 | 用途 | 规则 |
|---|---|---|---|
| 语义色 | `text-success` / `bg-success-muted text-success-muted-foreground` | 成功状态 | 禁 Tailwind 红绿黄青硬编码（门禁已查红绿黄，扩到 blue/slate/gray） |
| 警告 | `border-warning/40 bg-warning-muted text-warning-muted-foreground` | 警告 | 同上 |
| 危险 | `text-destructive` / `bg-destructive/10 text-destructive` | 破坏性 | 破坏性按钮 `variant="destructive"` |
| 信息 | `text-primary` / `bg-primary/10` | 中性强调 | **新增 `--info` 语义 token**，收编现有 `text-blue-600`/`bg-blue-100`（orders/leadgen/outreach 各若干处） |
| 容器 | `card-base` / `glass-panel` / `SectionCard` | 区块 | 主内容区一律 SectionCard；玻璃卡只留给侧栏/弹窗/特殊层 |
| 导航 | `nav-item` / `nav-group-label` | 侧栏 | 不新增 |
| 文本 | `text-muted-foreground` / `text-[11px]`~`text-xs` | 次级信息 | 灰阶只用 muted，禁 `text-slate-*`/`text-gray-*`（customers/pricing/gray-release 现存若干） |
| 动效 | `prefers-reduced-motion` 全局降级 | — | 新增动效必须遵守（globals.css:502-512 已落地） |

**字号/间距/圆角阶梯**：沿用 Tailwind 默认 + 现有 `rounded-xl/2xl`、`space-y-6` 页面节奏；新增组件不得自造阶梯。**密度**：表格行高 44px 默认、紧凑 36px（orders 密度切换范式推广为 DataTable 内置 `density` prop）。
## 3. 页面范式（Page Templates）

每种页面类型一个骨架。新页面必须从范式派生；存量页面整改以范式为目标态。

### 3.1 标准列表页（ListPage）—— orders/events/audit-log/receivables 的综合体

```
PageHeader（title + description + actions[新建/导出]）
└ SectionCard
   ├ FilterBar（搜索防抖 300ms + 筛选项 + 重置；状态入 URL）
   ├ DataTable（列声明式 + density + 空态/加载插槽 + placeholderData 保旧页）
   └ PaginationBar（服务端分页；page_size 可选 20/50/100）
```

行为合约：搜索防抖；筛选切换 `placeholderData: (prev) => prev` 不闪骨架；行摘要-only，详情走抽屉（§3.2）；空态三分支（无数据→引导新建 / 筛选无结果→引导重置 / 错误→ErrorState 重试）；导出按钮若只导当前页必须明示"仅导出当前 N 条"（research 现存静默截断问题）。

### 3.2 标准详情（Detail）—— 默认右侧抽屉

- **默认 `DetailDrawer`**（宽 480px；内容多时 560px，`size` prop）：事件详情（events Sheet）、报价单详情（quotes DetailDrawer）即范式；
- **独立详情页**仅当：详情本身需要深链/可刷新/含子路由（如未来的 /inquiries/:id）；
- **禁止**：在列表行下方原地展开详情（audit §1.5 八处现状的目标态）。
- 抽屉内分区用 SectionCard；操作按钮（编辑/删除）走 §5 合约。

### 3.3 标准编辑（Edit）—— 默认对话框，长流程用独立页/向导

- **短表单（≤6 字段）**：模态 `Dialog` + FormField；提交中禁关闭（gray-release/spec-proposals 现存 pending 中可关窗问题）；
- **长表单/多步骤**：独立页或向导（order-create-wizard、spec-config wizard 即范式），但向导必须修 totalSteps 硬编码（SC2）与提交零反馈（SC1）；
- **行内单元格编辑**仅限单字段轻量改值（number-edit-dialog 范式：对话框而非真行内 input），矩阵类大表（pricing-data）改"选中行→对话框编辑"。

### 3.4 标准表单页（FormPage）—— 设置类页面

```
PageHeader
└ SectionCard（表单区，sm:grid-cols-2/3 响应式栅格）
   └ FormField[]（label + 控件 + 错误 + aria-invalid/describedby）
└ 底部操作条（保存/取消；dirty 时导航拦截确认）
```

合约：15+ 字段的长表单（company-profile）必须脏检查（beforeunload/路由拦截）；错误定位到字段；保存按钮 `disabled={pending || !canEdit}`。

### 3.5 工作台页（Workbench）—— quotes/quote-workbench 范式

左右分栏（主操作区 + 右侧汇总卡 `sticky`）；整单参数默认收起可展开（现存范式保留）；批量操作区（batch-quote-view）参数与单条报价**同源**（修 Q11 硬编码政策）。

### 3.6 占位/建设中页 —— kb/billing 目标态

必须有"建设中"徽章 + 说明 + **禁止假数据**（kb 现存伪造统计 STATS，必须删除）；纯静态页去掉 `"use client"`。

## 4. 组件契约（Component Contracts）

每个契约含：用途 / API 草案 / 行为 / a11y / 禁止事项。位置规划：现有 `components/shared/` 不动，新增组件同目录；纯展示原语进 `components/ui/`。

### 4.1 修订现有组件（12 个）

| 组件 | 契约要点 |
|---|---|
| `PageHeader` | 全页唯一 h1 来源；`title` 必填；`description`/`actions`/`breadcrumb` 插槽；error/loading 分支也必须渲染（审计 D1/B2/G3 的系统性整改目标） |
| `SectionCard` | 主内容区唯一容器；`title`/`description`/`action` 插槽；禁业务页手写 `card-base`（settings 主页面/products 若干处整改目标） |
| `EmptyState` | 必填 `title` + `description` + 可选 action；三态文案由调用方给（无数据/筛选无结果） |
| `LoadingBlock` | 数据区加载唯一形式；禁纯文本"加载中"（trade-docs/pricing-data/shipments/tax-archives 现存若干） |
| `ErrorState`（**新增**） | `role="alert"` + 错误摘要 + **重试按钮**（调 react-query `refetch`/`reset`）；收编 8 处"一行红字无重试" |
| `StatusBadge` | 状态=文案+色双通道；tone 映射只能来自 `lib/status-tones.ts`（收编三页重复映射） |
| `StatCard` | 数值+标签+可选 trend；trend 图标 `aria-hidden`；加载中显骨架不显 0（research 现存亮 0 问题） |
| `PaginationBar` | 服务端分页唯一组件；`page`/`pageSize`/`total` + onChange；接入后禁再硬编码 `page_size` 无分页 |
| `ConfirmDialog` | 危险操作唯一确认形式；props: `title`/`description`(后果必写)/`confirmLabel`/`variant: "default"｜"destructive"`/`pending`/`error`(后端拒绝原因透出)/`onConfirm`；禁 `window.confirm`（门禁新增） |
| `DetailDrawer` | 详情默认容器；`size: 480｜560`；打开聚焦管理、Esc/遮罩关闭由 ui 层保障；内容超长内部滚动 |
| `FormField` | 表单字段唯一形式：`label` + 控件 + `error` + 自动 `aria-invalid`/`aria-describedby`；**本版起所有新表单强制使用**，存量随整改迁移（company-profile 首批） |
| `CopyButton` | 复制成功 feedback；补 try/catch（products 现存裸 clipboard 无 catch） |

### 4.2 新增组件（6 个）API 草案

```ts
// DataTable：列表唯一实现，收编各页手写 <table>
interface Column<T> {
  key: string; header: string;
  render: (row: T) => ReactNode;
  align?: "left" | "right"; width?: string;
  hideBelow?: 768 | 1024;        // 窄屏隐藏次要列，防 1366 溢出
}
interface DataTableProps<T> {
  columns: Column<T>[]; rows: T[]; rowKey: (r: T) => string;
  loading?: boolean;             // 骨架
  empty?: ReactNode;             // 空态插槽（EmptyState）
  error?: ReactNode;             // 错误插槽（ErrorState）
  density?: "default" | "compact";
  onRowClick?: (r: T) => void;   // 行可点必须键盘可达（行首按钮或 tabIndex+Enter）
  footer?: ReactNode;            // 分页插槽
}
```

```ts
// FilterBar：筛选唯一实现；值受控于 URL（useUrlState）
interface FilterDef {
  key: string; label: string;
  type: "search" | "select" | "date" | "daterange";
  options?: { value: string; label: string }[];  // select 枚举统一后端下发
  placeholder?: string;
}
interface FilterBarProps { filters: FilterDef[]; value: Record<string, string>;
  onChange: (v: Record<string, string>) => void; onReset: () => void; }
```

```ts
// ErrorState：三态之一
interface ErrorStateProps { title?: string; description?: string;
  onRetry?: () => void; retrying?: boolean; }
```

```ts
// useDebouncedValue：收编 8 处零防抖搜索
function useDebouncedValue<T>(value: T, delay = 300): T;

// useUrlState：筛选/分页/tab 状态入 URL，刷新不丢可分享
function useUrlState<T extends Record<string, string>>(defaults: T):
  [T, (patch: Partial<T>) => void, () => void /* reset */];

// useAsyncAction：mutation 统一包装（pending + onError toast + 防重复提交）
// 用法：const { run, pending } = useAsyncAction(mutationFn);
```

行为细则：`useAsyncAction` 强制每个 mutation 有 pending 态与错误出口——这是审计中"失败静默"类 P1（shipments×3、records、gray-release、spec-proposals、向导）的统一解药。
## 5. 交互规则合约（Interaction Contracts）

### 5.1 异步操作合约（所有 mutation）

1. **pending**：提交按钮 `disabled` + 文案"提交中…"或 spinner；
2. **失败必有出口**：`onError` → toast.error（后端 detail 优先）；禁止裸 `mutateAsync` 无 catch（spec-config 向导、gray-release 开关现状）；
3. **成功有反馈**：toast / 跳转 / 正确的 invalidate key（records 现存 key 不匹配导致列表不刷新）；
4. **防重**：pending 期间禁重复提交；批量操作（群发、批量建单）成功后清空选择态。

### 5.2 危险操作合约

触发条件（满足其一即必须 ConfirmDialog）：对外生效（签发报价、群发邮件）、不可逆（作废单证、删除、清除密钥、转让管理权）、批量影响（批量建单、停用工位）、影响下游（恢复兜底成本）。确认文案必须写后果（"签发后入账台账并向客户发出""作废后不可恢复，派生单将受影响"）。pending 中禁关闭对话框；后端 403/409 拒绝原因透出在对话框内（ConfirmDialog 已支持 error 透出，team 页 window.confirm 整改目标）。

### 5.3 三态合约（每个数据区）

| 状态 | 组件 | 文案规则 |
|---|---|---|
| 加载 | LoadingBlock/Skeleton | 禁纯文本 |
| 错误 | ErrorState（role=alert + 重试） | 禁把失败显示成空态（events/pricing-data/market/gray-release 现状整改目标） |
| 空 | EmptyState | 必须区分"无数据"（给新建引导）与"筛选无结果"（给重置引导）（leadgen/research/audit-log 现状整改目标） |

### 5.4 详情/编辑默认范式（审计 §1.5 裁定落地）

默认：详情 = DetailDrawer；编辑 = Dialog（短）/独立页（长）。例外仅限轻量二级折叠（有容器、有 aria-expanded、键盘可达）。每处例外在代码注释记录理由。

### 5.5 筛选与导航合约

- 筛选/分页/tab 状态入 URL（useUrlState）；tab 切换 `keepMounted` 或 URL 记忆，禁止切走即丢（quotes/intel/trade-docs 现状）；
- 侧边栏 `prefetch={false}`（静态导出铁律，已有）；
- 未开通工位直输 URL → WorkstationGate 双路径拦截（现状已正确，保留）。

### 5.6 可访问性合约（汇总）

- icon-only 按钮 `aria-label` + `title`（doc-set-panel/research 现状补齐）；
- 表单 label 关联（FormField 收编 placeholder 当 label）；
- 错误 `role="alert"` + 字段 `aria-invalid`/`aria-describedby`；
- 可展开行：`tabIndex` + Enter/Space + `aria-expanded`（audit-log 现状；teams 页为范式）；
- 表格：共享 Table/DataTable；原生 `<table>` 必须 `th scope="col"`；
- 焦点：对话框打开聚焦、关闭归还；下拉/浮层 Esc 关闭 + 外点关闭（orders 列配置 details 浮层整改目标）；
- 1366×768 无横向溢出：宽表 `overflow-x-auto` + 窄屏 `hideBelow` 列；面包屑 `truncate`。

## 6. 迁移映射表（现状 → 目标态）

| 现状（审计编号） | 目标态 | 涉及 |
|---|---|---|
| X1 customers 询盘行内展开 | DetailDrawer | customers/page.tsx、inquiry-followups.tsx |
| X2 leadgen 200 行内联详情 | DetailDrawer + 拆组件 | leadgen/page.tsx（881→拆分） |
| X3 outreach 邮件内联预览 | DetailDrawer | outreach/page.tsx |
| X4 research 158 行内联编辑 | Dialog（或独立编辑页） | research/page.tsx |
| X5 shipments 编辑依附列表行 | 按 selectedId 独立查询 + Dialog | shipments/page.tsx |
| X6 audit-log 行展开 JSON | 保留折叠 + 补键盘可达（轻量例外） | audit-log/page.tsx |
| X7 quotes 记录页四层堆叠 | ListPage 范式 + 双模型分区 | quotation-records-view.tsx |
| X8 pricing-data 单元格内联改价 | 选中行 → Dialog 编辑 | PricingDataTable.tsx |
| 各页手写 `<table>` | DataTable | 8 页 |
| 各页零防抖搜索 | FilterBar + useDebouncedValue | 8 处 |
| 各页 window.confirm/alert/prompt | ConfirmDialog / toast / Dialog | trade-docs/team/customers/outreach |
| 各页硬编码 page_size 无分页 | PaginationBar | trade-docs/shipments/leadgen/outreach/research/quotes 记录表 |
| 8 个 error.tsx 丢页头 | PageHeader + ErrorState | 全站 error/loading 分支 |
| RouteGuard/WorkstationGate 兜底无页头 | PageHeader + role=alert | route-guard/workstation-gate |
| 三页状态映射重复 | lib/status-tones.ts | leadgen/outreach/research |
| 7 个 800+ 行巨型组件 | 按 §3 范式拆分 | 清单见审计 §5 |
| /quotations 幽灵目录 + FreightPanel 死代码 | 删除/迁移 | quotations/ |
| onboarding 静态无进度 | 进度状态 + 死步骤补动作或降级说明 | onboarding/page.tsx |
| /market 与 /intel 重复入口 | **仅出方案不执行**（拍板 #4）：保留 /intel 内 tab，/market 后续重定向或移除入口 | market/、intel/ |

## 7. 门禁升级（L3 机检规则）

扩展现有 `frontend/scripts/ui-standards-check.cjs`（或新增 `ui:patterns`），规则清单：

| 规则 | 检出 | 现有工具覆盖？ |
|---|---|---|
| h1 唯一/来自 PageHeader | 已有 | ✅ |
| 裸 `<th>` 无 scope | 已有 | ✅ |
| 手写 tab（border-b-2） | 已有 | ✅ |
| 硬编码红绿黄 | 已有（扩 blue/slate/gray） | 🔧 扩展 |
| viewport maximumScale | 已有 | ✅ |
| `window.confirm/alert/prompt` | 新增 | ❌→✅ |
| 裸 `<table>`（非共享 Table/DataTable） | 新增 | ❌→✅ |
| 数据区纯文本"加载中/暂无" | 新增 | ❌→✅ |
| `useMutation` 无 onError | 新增（AST，先 warn） | ❌→✅ |
| `page_size` 硬编码且同页无 PaginationBar | 新增（warn） | ❌→✅ |
| icon-only 按钮无 aria-label | e2e a11y 已有 | ✅ |

执行方式：shadow 模式跑一周产出违规清单 → 转强制；CI 与本地 `pnpm ui:standards` 同跑。

## 8. 治理规则

1. **DoD**：新页面/新组件必须声明所用范式（§3）与组件契约（§4）才允许合入；
2. **Boy-scout**：PR 触及某页，该页达到契约才能合入（与门禁配合）；
3. **PR 检查清单**：本 PRD §5 六条合约逐项打勾；
4. **复跑**：并行任务与各批整改完成后复跑审计并同步文档（审计报告 §7）。

## 9. 目录结构规划

```
frontend/src/components/
  ui/            # 纯展示原语（table/dialog/tabs…，现状保留）
  shared/        # 业务共享组件（现状 13 个 + ErrorState/DataTable/FilterBar/AsyncButton）
  lib/
    status-tones.ts      # 新增：状态 tone 单一来源
    hooks/use-debounced-value.ts   # 新增
    hooks/use-url-state.ts         # 新增
    hooks/use-async-action.ts      # 新增
```

## 10. 拍板记录（2026-10-22 用户已决）

| # | 决策 | 结论 |
|---|---|---|
| 1 | DataTable v1 虚拟滚动 | **不做**。page_size≤100 + 分页足够；events 现存虚拟化分支（死代码且 DOM 非法）直接删除 |
| 2 | 详情抽屉宽度 | **480/560 两档**（`size` prop），不设 720 大档 |
| 3 | 整改顺序 | **两条线并行**：① P0/P1 止血线（危险操作确认、失败反馈、三态分离，约 20 处）；② 组件与门禁线（DataTable/FilterBar/ErrorState/use* hooks + ui:patterns 机检）。互不依赖可并行推进 |
| 4 | /market 与 /intel 重复入口 | **只出设计方案，本轮不执行**（避免与并行任务冲突）；方案：保留 /intel 内"产品市场对照"tab，/market 后续重定向或移除侧边栏入口，待产品定位明确后实施 |

### 两条并行线的执行切分

**线① P0/P1 止血**（不依赖新组件，随即可做）：
- 危险操作补 ConfirmDialog：outreach 群发、research 删除、trade-docs 作废、quotes 签发、批量建单、ai-providers 清密钥、tax-archives 产品税率删除；
- 失败反馈补 onError + toast：spec-config 向导、shipments×3、records 录入、gray-release 开关、spec-proposals 审批、leadgen 详情、outreach setDefault；
- 三态分离：events/pricing-data/market/gray-release flags 失败≠空态；
- 防重：pending 禁用（群发、AI 起草、加邮箱、建活动、扫描回复）；
- token 过期 401 防重+跳转去重；ai-providers 空输入禁保存+模型输入改失焦保存；DocCustomForm 加 key；trade-docs 台账接分页；
- error/loading 分支统一 PageHeader（8 处）+ RouteGuard/WorkstationGate 兜底补页头 + 新增全局 not-found.tsx。

**线② 组件与门禁**：
- 先建 ErrorState/DataTable/FilterBar/useDebouncedValue/useUrlState/useAsyncAction + lib/status-tones.ts；
- ui:patterns 机检（§7 清单）shadow 一周转强制；
- 组件就绪后按 §6 迁移映射表逐页回填（boy-scout + 批次冲刺）。
