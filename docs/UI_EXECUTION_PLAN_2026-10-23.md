# UI 执行方案与实施计划（2026-10-23 重写）

> **定位**：这是**当前唯一活跃的 UI 整改执行方案**，取代
> [`UI_SYSTEM_PRD_2026-10-22.md`](./UI_SYSTEM_PRD_2026-10-22.md)（设计稿/组件契约，保留为设计依据）与
> [`UI_UX_AUDIT_2026-10-22.md`](./UI_UX_AUDIT_2026-10-22.md)（2026-10-22 快照，保留为证据来源）中的「执行切分」部分。
> **口径（用户 2026-10-23 明确）**：按**项目最新实现与设计**重写，不是按 UI_STANDARDS 标准做条文合并。
> 即：以当前代码（M1/M2/M3 已落地的页面与组件）为真相，重新判断「哪些旧结论已过时、哪些仍然成立、新页面还缺什么」。
>
> 数据来源：本轮实跑门禁 + 逐文件核对（证据见各条 `文件:行号`）；旧审计条目凡未被本轮代码证实修复的，
> **一律保持「未做」**，不因“找不到证据”而默认完成。

## 0. 现状基线（2026-10-23 实测）

| 项 | 数值/事实 |
|---|---|
| 提交 | `26074659`（M1-f/M3 后端）→ `2e971736`（M2-A）→ `5d7d3a12`（M2-B/C/M3 前端）均已 push main |
| 门禁 | 前端 typecheck 0 error / lint 0 error / **1309 passed（155 文件）**；e2e **28 passed**；contracts R0–R6；mocks:check 未覆盖 2≤20；ui:standards / ui:contrast PASS |
| 路由 | (app) 下 25 个工位目录；新增 `/inquiries`、`/approvals`（导航契约 R2=30） |
| 新范式页 | `/inquiries`（ListPage + DetailDrawer + ConfirmDialog）、`/approvals`（三视图 + 详情抽屉 + 拒绝理由 Dialog）、dashboard 漏斗看板、orders 来源链/明细编辑、通知铃铛/抽屉 |
| 共享组件现状 | PageHeader / SectionCard / DetailDrawer / ConfirmDialog / EmptyState / LoadingBlock / PaginationBar / StatusBadge 已存在且新页在用；**仍缺** ErrorState / DataTable / FilterBar / useDebouncedValue / useUrlState / useAsyncAction / status-tones |

### 0.1 旧审计条目的状态校正（本轮新增，逐条可核）

| 旧条目 | 2026-10-23 状态 | 证据 |
|---|---|---|
| D1/D2/D3（dashboard 占位页、RangeSelector/useDashboard 死代码） | **已取代**：占位页被漏斗看板替换；`use-dashboard.ts` 删除，RangeSelector 扩 90d 并复用 | `dashboard/page.tsx`、`dashboard/components/range-selector.tsx`、`lib/dashboard/funnel.ts` |
| Orders O1–O6 | **仍存在**（来源链/明细编辑已加，但 O1 转订单确认、O3 期次文案、O4 纯文本加载、O5 列配置浮层 Esc、O6 巨型文件未改） | `orders/page.tsx`、`register-receipt-dialog.tsx:123`、`payment-schedules-panel.tsx:370` |
| Quotes Q13/Q17/Q18（记录页堆叠、行键盘不可达、固定 50 无分页） | **部分变化**：记录页已有「编辑报价单」入口与锁定说明（M2-B），堆叠/键盘/分页仍未改 | `quotes/components/quote-order-records.tsx`、`quote-order-edit-dialog.tsx` |
| Customers C7（1674 行巨型文件） | **仍存在**；UnlinkedRecords 语义已改（M2-B），但文件未拆 | `customers/page.tsx`、`components/inquiry-followups.tsx` |
| 所有 P0/P1 条目（危险操作、失败静默、失败当空态、防重、error/loading 页头、a11y） | **未做**（新页面已符合契约，旧页面未动） | 见 §3 批次清单 |
| /market 与 /intel 重复入口 | **仍按用户拍板只出方案，不执行** | PRD §10 #4 |

> 结论：2026-10-22 审计的 **P0/P1 清单仍然有效**；新增工作集中在「M1/M2/M3 新页与后端口径的小缺口」
> （见 §2 P0-A）。旧 PRD 的「两条并行线」已被本文件 §3 的分批计划取代。

## 1. 设计决策（沿用，不再重新拍板）

1. **默认范式**（用户 2026-10-22 裁定）：列表只放摘要；详情 = 右侧 `DetailDrawer`（480/560 两档）；编辑 = `Dialog`（短）/独立页（长）。行内展开仅允许轻量二级折叠，必须有容器 + `aria-expanded` + 键盘可达。
2. **一个模式一个正规实现**：危险操作必须 `ConfirmDialog`；数据区三态必须 LoadingBlock / ErrorState / EmptyState；分页用 `PaginationBar`；表单用 `FormField`。
3. **门禁优先**：先把可机检的规则做成 `ui:patterns`（shadow → 强制），再逐页回填。
4. **新页面即范式**：`/inquiries`、`/approvals`、dashboard 是当前最新实现，旧页面按它们对齐（而不是反过来）。

## 2. 批次计划（按依赖排序）

### P0-A · 新实现口径收口（先做，1 轮；依赖少量后端小改）
针对 M1/M2/M3 落地后暴露的「设计已定、实现差最后一段」：

| # | 事项 | 落点 | 验收 |
|---|---|---|---|
| A1 | 订单列表「有变更待批」角标：后端 `GET /orders` 增 `pending_item_change_count`（或 approvals 汇总带 order_id 列表），前端列表/行角标 | worker `main.py:list_orders` + ts 门面 zod/投影 + `orders/page.tsx` | 有 pending 申请的单显示角标；无 N+1 |
| A2 | 审批聚合行带 `affected_docs`（id/doc_no/doc_type/status），审批详情少拉一次 `/trade-docs`（403 时也能提示） | worker `ws_approvals.py:list_approvals` + 门面透传 + `approval-detail-drawer.tsx` | 详情显示受影响单证；不再静默降级 |
| A3 | 应收概览真实数据：新增 `GET /dashboard/receivables?range=`（按币种分组 total/received/outstanding/count + by_status），前端接卡片替换「待补后端」空态 | worker 新端点 + 门面 + `receivables-overview-card.tsx` | 有数据时显示；多币种不混加 |
| A4 | 通知深链：内核 link 改前端可落地路径（`/orders?id=`、`/approvals?focus=`），去掉前端归一兜底（保留兼容注释） | `ws_approvals.py` + 前端 `lib/approvals/notification.ts` | 点击通知直达；e2e 断言 |
| A5 | `direct_orders.amount` 分币种：funnel 响应改 `by_currency:[{currency,count,amount}]`（保留 `amount` 兼容并标注口径） | worker funnel SQL/响应 + 门面 + dashboard 卡 | 多币种时不再误导 |
| A6 | 报价编辑非原子（PUT items → PATCH header）：后端补 `PATCH /quotes/{id}` 可携带 items 的合并端点（或前端改为单请求），失败回滚提示 | worker quote_api + 门面 + `quote-order-edit-dialog.tsx` | 保存失败不出现“行项已改、条款未改” |
| A7 | 订单明细排序（全站排序=拖拽）：复用 `components/shared/sortable-list.tsx` | `order-items-editor.tsx` | 拖拽排序 + 既有测试 |
| A8 | 客户询盘表单渠道枚举已修（本轮完成，登记销账） | `inquiry-form.tsx` | 不再出现废弃 `quote`；含 phone/referral |

### P0-B · 全站 P0/P1 止血（2–3 轮，可 3 路并行）
> 旧审计 §4 的 P0/P1 清单，逐条对应；只做“止血”，不做结构重构。

| 组 | 内容（证据） | 验收 |
|---|---|---|
| B1 危险操作确认 | outreach 群发（O0 P0）、research 删除（R0 P0）、ai-providers 清密钥（C1/C2 P0/P1）、quotes 签发（Q2）、批量建单（Q10）、trade-docs 作废（T1）、settings 重载配置（A2）、tax 产品税率删除、window.prompt 收件人 | 全部 `ConfirmDialog` + 后果文案 + pending 禁关闭 |
| B2 失败反馈 | spec-config 向导（SC5）、shipments×3、records 录入、gray-release 开关、spec-proposals 审批、leadgen 详情（L3）、quotes createInquiry（Q9）/人工录入（Q15，含 invalidate key 修正）、outreach setDefault | `onError` toast + 后端 detail 透出；无裸 mutateAsync |
| B3 失败≠空态 | events（E1）、pricing-data、market 五 tab（M4/M5）、gray-release flags、kb 假统计（K1） | isError 分支 → ErrorState + 重试；禁止把失败渲染成 0/暂无 |
| B4 防重 | 群发、AI 起草、批量抓取、扫描已回复（L4）、模型输入每键 PUT（C3 改失焦保存） | pending 禁提交；请求风暴消失 |
| B5 页头/错误边界 | 8 个 `error.tsx`（含 dashboard/kb/settings）、loading 分支、RouteGuard 无权限（A1）、WorkstationGate 引导（W1）、新增全局 `not-found.tsx` | 错误/加载/无权限页均有 PageHeader/ErrorState + role=alert |
| B6 行内展开迁移 | X1 customers 询盘详情、X2 leadgen 线索（200 行）、X3 outreach 邮件、X4 research 编辑、X5 shipments 编辑（兼数据丢失）、X7 quotes 记录堆叠、X8 pricing 单元格 | 按默认范式迁 DetailDrawer/Dialog；例外须有容器+键盘可达 |

### P0-C · 共享原语与门禁（1 轮，B5/B2 的前置）✅ 原语已落地（2026-10-23）
- 新增 `ErrorState`（role=alert + 重试）、`DataTable`（声明式列 + 空态/加载/分页插槽）、`FilterBar` + `useDebouncedValue`、`useUrlState`（筛选入 URL）、`useAsyncAction`（pending + 错误出口）、`lib/status-tones.ts`。
- `pnpm ui:patterns`：禁 `window.confirm/alert/prompt`、禁裸 `<table>`、禁数据区纯文本加载/空态、`useMutation` 缺 onError 报警、page_size 硬编码无分页报警。
  **进度（2026-10-23）**：脚本已落地 `frontend/scripts/ui-patterns-check.cjs` + `pnpm ui:patterns` / `ui:patterns:test`，
  shadow 首扫 284 文件命中 **134 条**（native-dialog 7 / bare-table 39 / plain-text-state 28 / mutation-on-error 55 / page-size 5）。
  **2026-10-23 ~ 2026-10-30 shadow；2026-10-30 转强制**（CI 加 `pnpm ui:patterns --strict` + `pnpm ui:patterns:test`）。
- 换用顺序：先 ErrorState（B5/B3 用），再 useAsyncAction（B2/B4 用），DataTable/FilterBar 随后。

### P1-D · 结构债（2 轮，随批次顺手做）
拆 7 个 800+ 行组件（customers 1674 / order-create-wizard 1366 / product-spec-editor 1142 / quote-workbench 924 / leadgen 881 / research 868 / payment-schedules-panel 698）；删 `/quotations` 幽灵目录与 FreightPanel 死代码；状态 tone 三份重复合并；audit-log JSON 折叠补键盘；onboarding 进度；kb 假统计下线；/market 与 /intel 入口收敛（仅方案，用户裁定不执行）。

### P1-E · 体验一致性（按页回填，boy-scout）
分页/URL 筛选（trade-docs/shipments/leadgen/outreach/research/quotes 记录表）、搜索防抖（customers/leadgen/market×3/outreach/research/events）、FormField 收编（customers/research/leadgen）、列表行键盘可达（quotes 记录/audit-log）、详情后焦点归还、图标按钮 aria-label（research/doc-set-panel/audit-log）。

## 3. 执行与并行切分（写热点）

| 批次 | 并行度 | 说明 |
|---|---|---|
| P0-A | 1 路后端 + 1 路前端（同页收尾） | 后端端点先落，前端接；A6 涉及跨层契约需同批门禁 |
| P0-B | 3 路：B1/B4（确认+防重）、B2/B3（反馈+三态）、B5/B6（页头+行内迁移） | 共享文件冲突点：`app/(app)/layout`、`components/shared`、`mocks/handlers.ts`、`e2e/*` 由 Lead 收口；同页只能一人改 |
| P0-C | 1 路（Lead 或 1 队友） | 必须先行；新增组件要有单测 |
| P1-D/E | 各 1–2 路，按页分派 | 结构拆分与体验回填同页合并做 |

**共享写热点（一次一人）**：`components/shared/*`、`components/layout/*`、`mocks/handlers.ts`、`shared/contracts/*`、`frontend/scripts/*`、`e2e/*`、`app/(app)/layout.tsx`。

## 4. 每批验收（DoD）

1. 该批触及页面：typecheck / lint 0 error / 相关 vitest / `ui:standards` / `ui:contrast`；
2. 涉及交互的：对应 e2e 用例（a11y 自动发现新路由）；
3. 涉及 mock 的：`mocks:check` 不降级；新端点写 mock 契约测试；
4. 涉及契约/后端的：contracts R0–R6 + 金标（有环境时）；
5. 每批完成更新 `docs/TODO.md`/本文件 §6 变更日志 + `PROBLEM_STATUS` 交接摘要；push main。

## 5. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-10-23 | 根据 M1/M2/M3 最新实现重写执行方案：旧 PRD「两条并行线」→ §3 分批；新增 P0-A（新实现小缺口）；旧审计条目状态校正见 §0.1 |
| 2026-10-23 | **P0-A 后端（A1–A5）完成**：待批计数 / 审批 affected_docs / dashboard receivables / 通知 link / funnel 分币种；worker 1709+12skip、ts 278、路由 274=188+86 |
| 2026-10-23 | **P0-C 原语落地**：ErrorState/DataTable/FilterBar/AsyncButton + use* hooks + status-tones + `pnpm ui:patterns` shadow（134 违规，2026-10-30 转强制） |
| 2026-10-23 | **P0-B1/B4 止血完成**：8 处危险操作确认 + pending 防重（新增 27 测）；剩 U-P0A-FE 前端接线与 B2/B3/B4/B5/B6/P1 批次 |
| 2026-10-23 | **U-P0A-FE ✅**：订单待批角标+深链、审批聚合 affected_docs、dashboard 应收真实数据、direct 分币种、通知 link |
| 2026-10-23 | **U-P0B2/B3/B5 ✅**：失败反馈统一（useAsyncAction）、失败≠空态（events/pricing/market/intel/kb 假统计下线）、7+6 边界页头与原生确认清零；全量前端 1457 passed |
| 2026-10-23 | 待做：U-P0B4 剩余、U-P0B6 行内展开迁移、U-P1D 结构债、U-P1E 体验一致性；2026-10-30 ui:patterns 转强制 |
