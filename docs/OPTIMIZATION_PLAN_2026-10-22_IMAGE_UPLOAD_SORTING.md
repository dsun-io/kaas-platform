# 产品图片上传 + 全站拖拽排序 · 设计与实施（2026-10-22）

> 起因（用户原话）：**「产品中 产品图片上传的功能 交互设计太反人类了，给我一个优化方案」**。
> 追加要求：**「上移下移的箭头不要，改为鼠标拖动排列」**、**「所有排序的部分都设计为拖拽排序」**。
> 性质：**已实施**（本文是设计与落地记录，不是待办设计稿）。


> **2026-10-24 线上修复（回归）**：第 3 条的进度条改走**裸 XHR** 后，`xhrPostForm` 手写了
> `Content-Type: multipart/form-data` —— 浏览器只在作者没设该头时才补 `; boundary=…`，
> 于是内核解析表单直接 400「Missing boundary in multipart.」（axios 那条路不受影响，
> axios 浏览器适配器会自己删掉该头）。修复：`frontend/src/lib/api/xhr-upload.ts` 不再设该头，
> `xhrSend` 对 `FormData` 兜底删除任何 `Content-Type`（大小写不敏感）；回归单测在
> `frontend/src/lib/api/__tests__/xhr-upload.test.ts`。详见 `docs/PROBLEM_STATUS_2026-10-11.md` 交接摘要。
## 0. 一句话结论

痛点全在**交互层**，后端能力早就齐了：直传+代理回退、软删可恢复、改名、重排、按 sha256 去重都在。
界面上却把它埋成了「选类型 → 起名 → 选文件 → 点上传」×N 张，排序靠一对箭头按钮，
条款模板排序甚至要用户手填一个数字。本次把**入口、反馈、排序**三件事一次改掉：

| # | 原来的样子 | 现在 |
|---|---|---|
| 1 | 一次只能选一张，且**名称是上传前必填** | 拖拽 / 点击 / Ctrl+V 粘贴三入口，可多选；文件先进**待传队列**，名称默认取文件名，上传后仍可改 |
| 2 | 不合法文件传完才被后端 422 | **入队即校验**（类型/大小/名称），不合规项标红并写明原因，不会静默丢弃 |
| 3 | 没有进度、失败只能整批重来 | 逐张进度条（XHR `upload.onprogress`）+ **单张失败可单独重试**（成功的不会重传） |
| 4 | 图库卡片 5 个文字按钮，含上移/下移 | 图标按钮（设主图/复制链接/移除）+ **拖动把手**；点缩略图看**大图**（←/→ 翻页、Esc 关闭） |
| 5 | 改名 blur 即写库（打一半失焦就存进去了） | **Enter / ✓ 显式提交**，Esc 撤回，超长当场拦下 |
| 6 | 移除是「一键没了」 | 二次确认，并说明**存档保留、可恢复**、已引用它的单证不会自动改 |
| 7 | 直传悄悄回退到服务端中转，界面只显示"成功" | 首次回退弹一次 warning 并给出原因（运维问题不能永远没人发现） |
| 8 | 条款模板要手填「排序（可选）」数字 | **拖动排序**；数字框删除，新建模板默认**追加到末尾** |
| 9 | 报价行 / 订单行**根本没有排序** | 拖动排序（落库随单保存，按下标重写 `sort_order`） |
| 10 | 单证引用产品图只能手改 JSON 调顺序 | 已引用列表**可拖拽、可移除**，写回时保留用户手写的额外字段 |

## 1. 唯一实现：`SortableList`

六处排序（产品图库 / 上传队列以外的图库卡片 / 条款模板 / 报价行 / 订单行 / 单证引用图）
共用 `frontend/src/components/shared/sortable-list.tsx`。各写一份必然漂移，所以收拢成一处：

- 拖动**把手** `SortableGrip` 排序；行内按钮/输入框不受影响（pointer sensor 8px 激活距离，未超过即 click）。
- 触屏长按 250ms 激活，不与页面滚动抢手势。
- 键盘：Tab 到把手 → Space/Enter 拾起 → ↑↓ 移动 → Space/Enter 放下 → Esc 取消。
  **这是去掉箭头按钮后唯一的无障碍路径**，不能丢。
- 屏幕阅读器播报**中文化**（dnd-kit 默认英文），并带"第 N 项"位次 —— 卡片墙里"往上/往下"说不清。
- 三种排布：`layout="vertical"`（列表）/ `layout="grid"`（卡片墙，换 `rectSortingStrategy` 并放开横向位移）/
  `containerAs="fragment"` + `itemAs="tr"`（表格行，不能套 `<div>`，否则破坏 table 盒模型）。
- 主键不叫 `id` 的数据用 `getItemId` 指定（订单明细草稿叫 `key`），**不为拖拽去改数据模型**。
- **持久化不在组件内**：调用方在 `onReorder(next)` 里自己落库、做乐观更新与回滚。

### 落点映射抽成纯函数

jsdom 没有布局，dnd-kit 的碰撞/位移在单测里算不出真实结果（键盘能起拖，但位移测不准）。
因此把「松手后顺序怎么变」抽成 `reorderById(items, activeId, overId, getId)` 纯函数，
逐条钉死（前移/后移/同一项/id 不存在/不改原数组/数字 id）；组件测试只断言
渲染、把手可聚焦、Space 起拖、Esc 取消、`canDrag`/`disabled` 禁用。

## 2. 各处的落库口径

| 位置 | 落库方式 | 备注 |
|---|---|---|
| 产品图库 | `PATCH /file-objects/{id}` `{sort_order}`，逐条 | 把整个顺序压成 `0..n-1`，只发位次变了的那些（新图默认 `sort_order` 都是 0，交换两个 0 等于没动） |
| 条款模板 | `PATCH /clause-templates/{id}` `{sort_order}`，逐条 | 后端 PATCH 是局部更新（`exclude_unset` 合并），只发 `sort_order` 不会清空名称/内容 |
| 报价行 | **本地重排即可** | 保存时 `items()` 按数组下标重写 `sort_order: i`；`termsByLine.terms` 也按下标算，重排后自动对齐 |
| 订单行 | **本地重排即可** | 同上，明细按数组顺序落库 |
| 单证引用图 | 重写 `product_photos` 的 JSON 文本 | 纯函数 `photo-entries.ts`，见 §4 |

### 产品图：主图固定第一位

后端列表排序是 `is_primary DESC, sort_order, id`（`backend/worker/src/ws_files.py` `_FILE_ORDER_BY`）——
主图不管 `sort_order` 多大都会被顶到第一位。前端必须按同一口径收敛，否则会出现
「拖上去显示成功、刷新又跳回去」和「乐观 UI 与服务端顺序打架」。

处理方式（`media-order.ts` 的 `pinPrimaryFirst`）：

- 主图行**不给把手**（可拖 = 假承诺），换主图用星标；
- 用户把别的图拖到主图前面时，主图回第一位，其余图落到「主图之后的第一位」
  （保持他拖出来的相对顺序，而不是原地不动 —— 那样等于拖了没反应）。

## 3. 上传区（`media-upload-zone.tsx`）

几个刻意的取舍：

- **校验前置但不丢弃**：不合规的文件也进队列，标红并写明原因（含实际类型/实际大小），
  用户至少知道"这张没传上去、因为什么"。口径对齐后端 `kaas_common/files/rules.py`：
  `png/jpeg/webp`、≤8MB、名称 ≤80 字符。
- **串行上传**：一次一张。并发会让弱网下的进度条互相打架，也让"第几张失败"说不清；
  产品图一次十来张，串行慢不了多少。
- **失败可单独重试**：已成功的不会重传（字节已经落库，重传只会产生重复对象）。
- **进度走 XHR**：`fetch` 拿不到上传进度，新增 `lib/api/xhr-upload.ts`
  按 `client.ts` 同口径补鉴权头（预签名绝对 URL **不带**我们的头，否则 S3 会判签名不符）。
- **上传完才汇总提示**：成功 X 张 / 失败 Y 张，失败项留在队列里等重试。

## 4. 单证引用图（`photo-entries.ts`）

`product_photos` 在表单里是用户可手改的 **JSON 文本框**，所以「读文本 → 改结构 → 写回文本」
必须是纯函数并有单测。三条不可退让的约束：

1. **只重排、不重建**：条目对象原样搬运，`caption` 之外的字段（历史数据里的 `image`、
   用户手写的 `note`）必须原封不动。
2. **认不出来就不动**：数组里存在没有 `file_id` 的条目时重排直接放弃（返回 `null`），
   宁可这次拖拽没生效，也不能把用户写的条目静默丢掉。
3. **解析失败不抛**：用户正在手改 JSON 时界面必须还能渲染，只是列表为空。

全部移除后写**空串**而不是 `[]`（否则渲染器会当成「有图但都无效」）。

## 5. 实施清单

新增：

- `frontend/src/components/shared/sortable-list.tsx` — 唯一拖拽实现
- `frontend/src/lib/api/xhr-upload.ts` — 带进度的上传传输层
- `frontend/src/app/(app)/products/media-validation.ts` — 前端预校验（对齐后端 rules）
- `frontend/src/app/(app)/products/media-order.ts` — 主图收敛 + 位次压缩
- `frontend/src/app/(app)/products/components/media-upload-zone.tsx` — 上传区
- `frontend/src/app/(app)/trade-docs/components/photo-entries.ts` — 引用图 JSON 读写

改动：

- `products/components/product-images.tsx` — 图库重写（拖拽/图标按钮/大图/显式改名/确认移除）
- `products/use-products.ts` — 上传支持 `onProgress` / `contentType`，传输改 XHR
- `settings/company-profile/components/clause-templates-card.tsx` — 删掉排序数字框，改拖拽
- `lib/trade-doc/use-clause-templates.ts` — 新增 `useReorderClauseTemplates`
- `quotes/views/quote-workbench-view.tsx` + `quotes/components/quote-line-card.tsx` — 报价行拖拽（`grip` 插槽）
- `orders/components/order-create-wizard.tsx` — 订单行拖拽（表格模式 + 新增把手列）
- `trade-docs/components/doc-custom-form.tsx` + `doc-photo-picker.tsx` — 引用图列表可拖拽/可移除
- `components/ui/dialog.tsx` — `DialogContent` 新增 `overlayClassName`（大图预览需要更实的底）
- `docs/UI_STANDARDS.md` §7 — 把「排序一律拖拽」写成硬性规范

依赖：`@dnd-kit/core` `^6.3.1` / `@dnd-kit/sortable` `^10.0.0` / `@dnd-kit/modifiers` `^9.0.0`。

## 6. 验证

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS（0 error；新增文件 0 warning） |
| `pnpm test` | 132 文件 / 1135 用例全通过（rebase 到 main 后复跑；main 带入 1 个团队测试文件 +6 用例） |
| `pnpm contracts:check` | PASS |
| `pnpm mocks:check` | PASS |
| `pnpm ui:standards` | PASS |
| `pnpm ui:contrast` | PASS |
| `pnpm e2e` | 27 passed |
| `pnpm build` | 38 路由全量构建通过 |

新增测试（均为无后端组件/纯函数测试）：

- `components/shared/__tests__/sortable-list.test.tsx` — 落点映射 12 例（含网格/表格无关的纯逻辑）
- `lib/api/__tests__/xhr-upload.test.ts` — 鉴权头口径、进度百分比、超时/网络/非 2xx 语义
- `app/(app)/products/__tests__/media-validation.test.ts` — 与后端 rules 对齐（类型/8MB/80 字符）
- `app/(app)/products/__tests__/media-order.test.ts` — 主图收敛与位次压缩
- `app/(app)/products/components/__tests__/product-images.test.tsx` — **回归守卫**：没有上移/下移、
  主图把手禁用、改名只在 Enter 时 PATCH、Esc 撤回、移除需确认、大图翻页
- `app/(app)/trade-docs/components/__tests__/photo-entries.test.ts` — 重排不吃字段、认不出就不动
- `app/(app)/trade-docs/components/__tests__/doc-custom-form-photos.test.tsx` — 列表渲染/移除/混合条目

## 7. 已知取舍与后续

1. **拖拽落点本身无法在 jsdom 里测**。顺序规则已用纯函数穷举；组件的拖拽只验证到
   「起拖 / 取消 / 禁用」。真机拖拽手感依赖 e2e 或人工验收。
2. **产品图库是网格 + `rectSortingStrategy`**，跨行拖动时中间卡片会整块腾挪
   （不是逐格让位）。这是 dnd-kit 网格策略的固有行为，可接受。
3. **上传队列本身不可排序**。用户通常按文件选择顺序上传，且上传完即离开队列；
   如果将来出现"传之前就要定顺序"的需求，再给队列加 `SortableList` 即可（同一组件）。
4. **产品图上限仍由后端决定**（`rules.py`），前端没有额外加"最多 N 张"的臆测限制。
5. **`dnd-kit` 新增三个依赖**。选它是因为 `DragOverlay` + sensor 组合成熟、
   键盘/触屏/屏幕阅读器都有内建支持；自研会在这三件事上反复踩坑。
