# UI 设计规范（硬性约束）

> 适用范围：`frontend/src/app/(app)` 与 `frontend/src/components` 的业务展示代码。  
> 目标：所有页面看起来像同一套系统，而不是各写各的。  
> 执行：改 UI 必须本地跑 `pnpm ui:standards` + `pnpm ui:contrast`；CI 已强制。全路由结构/可访问性由 `pnpm e2e` 的 a11y 用例兜底。

## 0. 新增页面 / 新工位 Definition of Done

新增 `frontend/src/app/(app)` 路由时，必须同时满足；门禁会自动覆盖，不需要手工登记：

- 页面标题用 `PageHeader`，全页唯一 h1；错误/加载分支也不能丢页头。
- 主内容区用 `SectionCard`；列表空态用 `EmptyState`，加载用 `LoadingBlock/Skeleton`。
- 表格用共享 `Table/TableHead`；若写原生 `<table>`，每个 `<th>` 必须 `scope="col"`。
- Tab 用 `ui/tabs`；icon-only 按钮必须有 `aria-label/title`。
- 状态色只用 semantic token，不引入 Tailwind 红/绿/黄/青硬编码。
- 完成后必须跑：`pnpm ui:standards`、`pnpm ui:contrast`、`pnpm e2e`（a11y 路由自动发现）。

## 1. 页面骨架

- 每个页面只有一个 `h1`，且必须来自 `PageHeader`；禁止在业务页手写 `<h1>`。
- 页面区块优先用 `SectionCard`；需要特殊玻璃卡片时才显式写 `card-base / backdrop-blur / bg-white/*`。
- 页面顶部面包屑、团队切换、右侧动作区沿用现有 app shell，不在页面内重写。

## 2. Tabs / 状态 / 颜色

- Tab 只用 `@/components/ui/tabs`；禁止业务页手写 `border-b-2` tab。
- 状态不只靠颜色：必须同时有文案（`StatusBadge` 或文字）。
- 禁止 Tailwind 调色板硬编码色：`text-red-* / bg-red-* / text-green-* / bg-green-* / text-amber-* / bg-amber-* / text-emerald-* / bg-emerald-* / border-emerald-*` 等。统一用语义 token：
  - 成功：`text-success`、`bg-success-muted text-success-muted-foreground`
  - 警告：`border-warning/40 bg-warning-muted text-warning-muted-foreground`
  - 危险：`text-destructive`、`bg-destructive/10 text-destructive`

## 3. 表格

- 优先用共享 `Table/TableHead`；`TableHead` 已默认 `scope="col"`。
- 若因布局必须写原生 `<table>`，每个 `<th>` 必须显式 `scope="col"`。

## 4. 加载 / 空态 / 错误

- 数据区加载用 `LoadingBlock` 或 `Skeleton`；禁止整块数据区只放“加载中…”纯文本。
- 空列表用 `EmptyState`，说明下一步该做什么。
- 错误分支也要有页面级标题/说明（例如 `PageHeader`），不能只丢一行红字。

## 5. 可访问性与适配

- icon-only 按钮必须有 `aria-label`（最好同时 `title`）。
- 新增动效必须遵守全局 `prefers-reduced-motion`。
- 不允许禁用用户缩放；`viewport` 不得出现 `maximumScale`。
- 1366×768 不得横向溢出；核心交互保持键盘可操作与 focus 可见。

## 6. 本地与 CI 门禁

```powershell
cd frontend
pnpm ui:standards   # 静态规则：h1/裸th/手写tab/硬编码色/maximumScale
pnpm ui:contrast    # light/dark token 对比度 >= 4.5
pnpm e2e            # 含全路由 a11y 冒烟：h1/scope/button名/横向溢出
```

任何一项失败，不得合入。

## 7. 排序交互（唯一实现：`SortableList`）

> 2026-10-22 拍板：**全站排序一律拖拽**，不再有「上移/下移」按钮，也不再让用户手填排序数字。

- 排序一律用 `@/components/shared/sortable-list`（`SortableList` + `SortableGrip`）。
  **禁止**在业务页另写一套 dnd-kit、也**禁止**恢复箭头按钮或「排序（数字）」输入框。
- 把手 `SortableGrip` 是唯一的拖拽入口；行内按钮/输入框不受影响
  （pointer sensor 有 8px 激活距离，未超过即 click）。
- 键盘等价操作必须保留：Tab 到把手 → Space/Enter 拾起 → 方向键移动 → Space/Enter 放下 → Esc 取消。
  这是去掉箭头按钮后唯一的无障碍路径。
- 拖拽播报文案是中文（组件内已本地化，含"第 N 项"位次）。
- 表格行排序用 `containerAs="fragment"` + `itemAs="tr"`；**不要**给 `<tr>` 套 `<div>`。
- 主键不叫 `id` 的数据用 `getItemId` 指定，不要为了拖拽去改数据模型。
- 顺序的**落库方式由调用方负责**（产品图/条款模板 PATCH `sort_order`；
  报价行/订单行随单保存、按下标重写 `sort_order`），组件不猜。
- 已固化的业务口径：
  - 产品图**主图固定第一位**（后端 `is_primary DESC, sort_order, id`）⇒ 主图行不给把手，
    换主图用星标；拖动把它挤到后面时前端按同一口径收敛（`media-order.ts` 的 `pinPrimaryFirst`）。
  - 新建条款模板**追加到末尾**（不再是 `sort_order=0` 抢到最前）。

