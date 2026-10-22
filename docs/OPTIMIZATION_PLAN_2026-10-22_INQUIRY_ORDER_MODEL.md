# 询盘与订单模型重构 · 优化方案（2026-10-22）

> 状态：**设计定稿待实施**（用户 2026-10-22 拍板「落盘设计文档再实现」）。
> 本文件是本次重构的**唯一设计基准**；实施进度在 [`TODO.md`](./TODO.md) §Q 销账。
> 所有结论均经代码核实（附 `文件:行号`），非推测。

## 0. 背景与用户指示（2026-10-22）

用户原话要点：

1. 「询盘和订单部分的设计现在有问题，并且不清晰」——要**简单明了**地追踪客户询盘/订单状态、对应关系、报价历史、时间、单证详情；
2. 「现在直接创建出订单，没有添加产品或者订单详情的入口」；
3. 「订单创建出来因为没有询盘，所以直接被分类到了其他里面，询盘数量也不会增加，但订单实际也要算出来，并且权重应该更大，因为客户实际有付款」；
4. 「给订单添加一个来源，是询盘转化还是各种渠道直接下单」；
5. 「**订单应该是一等公民，并且订单和询盘应该是独立存在的**」；
6. 「可是就连报价链也找不到编辑入口」。

**根因裁定**：系统事实主干是「报价链」（询盘→报价→订单→单证），询盘与订单都被当成链上附属品；
同时**编辑能力后端契约齐全、前端零暴露**。上述每一条现象都是这个根因的表象。

## 1. 问题清单（代码证据）

### P1 · 订单是二等公民

- 订单列表空态只引导「从报价单转一张订单试试」，直接下单入口不可见（`frontend/src/app/(app)/orders/page.tsx:256-258`）；
- 「由报价单转订单」是一个下拉+一个按钮的**一键建单、零输入**（`orders/page.tsx:132-163`）；
- 建好的订单**货物行只读**，无货物行的订单提示「请在报价工位维护后转单」（`orders/components/order-detail-panel.tsx:190-194`）；`PATCH /orders/{id}` 不支持 items（`backend/ts-worker/src/routes/orders.ts:860-916`）——**订单无法自己维护明细**。

### P2 · 询盘是二等公民

- 无 `/inquiries` 独立路由，询盘只在客户详情弹窗的 tab（`frontend/src/app/(app)/customers/page.tsx:852`）；询盘计数仅客户页标题「N 条询盘」（同文件 `:1112`）；
- 询盘状态**三套真源并存**：`status`（unquoted/quoted/closed，`backend/kaas_common/domain/enums.py:13`）、`stage`（六态，`backend/worker/src/inquiry_stage.py:22-39`）、前端 `deriveInquiryStage` 从报价/订单/单证**反推**（`frontend/src/app/(app)/customers/components/inquiry-followups.tsx:121-198`）。

### P3 · 无报价的订单被当成「其他」

- `build_records` 把无 `quote_id` 的订单落入 `direct` 桶（`backend/kaas_common/workstation/customer_records.py:105-111`），前端渲染为折叠的「未关联询盘的历史单据」（`customers/components/inquiry-followups.tsx:672-693` `UnlinkedRecords`）——一笔正常的直接下单被当作异常数据藏起来。

### P4 · 来源/渠道断裂

- 仅 `cust_inquiries.channel` 有渠道字段；`orders`/`quote_orders`/`trade_docs` **均无渠道列**；
- 询盘 channel 枚举混入 `quote` 值（来源类型冒充渠道，`enums.py:32`）；
- 后果：回答不了「订单从哪来」，算不出分渠道转化。

### P5 · 统计口径缺失

- dashboard 是占位页（`frontend/src/app/(app)/dashboard/page.tsx`，「仪表盘改版中」）；
- `/dashboard/summary` 把 `quotations`+`quote_orders`+`cust_inquiries` 三张表加成一个数（`backend/worker/src/main.py:1897-1949`）；全库无转化率代码；
- 订单（有实际付款）在商机统计里**完全不计权重**。

### P6 · 对应关系界面不可见 + 两端行为漂移

- order→quote 数据存在（详情返回 `quote_refs`，`backend/ts-worker/src/routes/orders.ts:850-852`），但列表列与详情面板**均不展示**；order→inquiry 需经 quote 跳两跳；
- TS 门面订单 `completed` 时不联动询盘阶段（TODO TS6，`orders.ts:973-975`），与内核 `main.py:3911` 行为漂移。

### P7 · 编辑入口全面缺失（后端契约齐全，前端零暴露）

| 对象 | 后端能力（已验证） | 前端现状 |
|---|---|---|
| 询盘 | `PATCH /inquiries/{id}` 支持 items 多产品行 / channel / 编号 / 状态流转（`backend/worker/src/ws_crm_ext.py:318-442`） | 只有「改编号 / 关闭 / 重开」（`customers/page.tsx:1216-1245`），**产品行与渠道没有编辑入口** |
| 报价 | `QuoteOrderPatch` 支持条款/客户/币种/有效期/状态流转；`QuoteOrderItemsReplace` 支持行项整批替换（`shared/contracts/quote-order.ts:142-170`） | 「报价记录」只读，唯一可编辑是「改编号」（`quotes/components/quote-order-records.tsx:282-295`），**条款/行项/状态流转全无入口** |
| 订单 | 门面 PATCH 仅条款类字段；items 增删改**两端都没有**（`orders.ts:860-916`） | 货物行只读（`order-detail-panel.tsx:190-241`） |

后果：报价录错（价格/数量/条款/挂错客户）只能重新建一张，**污染报价历史**；询盘产品信息变了也无法更正。

## 2. 设计原则

1. **订单一等公民**：不依赖询盘/报价即可存在、可维护、可统计；统计权重最高。
2. **询盘一等实体**：独立工位、独立计数，不再是客户弹窗里的 tab。
3. **链路关联可选可溯**：`inquiry_id`/`quote_id` 均可空；每一跳都可正查反查。
4. **状态单一真源**：询盘只认 `stage`（事件驱动落库）；订单维持六态；`status`/前端反推全部退场。
5. **编辑能力补齐**：询盘、报价、订单的产品行/条款/状态都可改（报价状态流转带锁定规则）。
6. **业务规则只在 Python 内核一处实现**；TS 门面只做鉴权/校验/透传；zod 从 pydantic 生成。
7. **统计口径**：漏斗 + 权重，订单权重最大（实际付款），分渠道/分时间可算转化率。

## 3. 目标模型

```
客户 Customer
 ├── 询盘 Inquiry        独立一等实体：渠道 + stage（唯一进度真源）+ 产品行 items[]
 │    └── 报价 Quote     1:N（报价历史）：同一询盘可多次报价，每次留时间/金额/状态
 │          └── 订单 Order  一等公民：source_type + source_channel + inquiry_id(可空) + quote_id(可空)
 │                └── 单证 TradeDoc  挂订单，继承订单全部条款
 └── 订单也可不经询盘/报价直接存在（source_type=direct，source_channel 记渠道）
```

### 3.1 关联规则（全部可空，每一跳可正查反查）

| 关系 | 字段 | 规则 |
|---|---|---|
| 询盘→报价 | `quote_orders.inquiry_id`（已有） | 可空：允许先报价后补询盘；1:N = 报价历史 |
| 报价→订单 | `orders.quote_id`（已有） | 可空：手动新建/导入的历史订单 |
| 询盘→订单 | **`orders.inquiry_id`（新增）** | 可空 FK：转化时写入；经报价转化则从 `quote.inquiry_id` 冗余回写，保证一跳可达 |
| 订单→单证 | `trade_docs.order_id`（已有） | 维持不变 |
| 订单→出运 | `order_shipment_refs`（已有） | 维持不变 |

### 3.2 订单新增字段（回答「订单从哪来」）

| 字段 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `source_type` | enum | `inquiry` \| `direct` | `inquiry`=询盘转化（含经报价转化）；`direct`=直接下单。建单时按 inquiry_id/quote_id 自动判定，可显式覆盖 |
| `source_channel` | enum（复用渠道枚举） | email/whatsapp/alibaba/expo/website/phone/referral/other | `direct` 时必填建议值；`inquiry` 时继承询盘渠道 |
| `inquiry_id` | bigint FK 可空 | — | 见 3.1；带索引；`entity_links` 触发器补 order→inquiry 边 |

## 4. 数据模型变更（迁移 + 回填）

1. **枚举**（`backend/kaas_common/domain/enums.py`，改完跑 `scripts/sync-shared.ps1`）：
   - 新增 `ORDER_SOURCE_TYPE = ("inquiry", "direct")`；
   - 渠道枚举 `CHANNEL` 统一为 email/whatsapp/alibaba/expo/website/**phone/referral**/other（询盘 channel 去掉 `quote`——那是来源类型不是渠道；存量 `quote` 行回填为 `other` 并在 UI 标注）；
2. **迁移**（orchestrator alembic，head 顺延）：
   - `orders` 加 `source_type`（默认 `direct`）、`source_channel`（可空）、`inquiry_id`（可空 + 索引 + FK）；
   - 回填：`UPDATE orders SET source_type='inquiry', inquiry_id=q.inquiry_id FROM quote_orders q WHERE orders.quote_id=q.id AND q.inquiry_id IS NOT NULL`；其余维持 `direct`、`source_channel=NULL`（前端展示「未知」，不伪造）；
   - `entity_links` 触发器（`trg_orders_links`）扩展：`inquiry_id` 一落即派生 order→inquiry 边；
3. **询盘 status 退场**：`status` 列保留兼容读，新写入由 `stage` 派生（inquiry→unquoted、quotation→quoted、closed→closed）；`_sync_lead_status` 映射不变。

## 5. 状态机收敛

- **询盘**：只认 `stage` 六态（询盘/报价/订单/发货/完结/关闭，`inquiry_stage.py` 事件驱动）；删除前端 `deriveInquiryStage` 反推兜底（`inquiry-followups.tsx:121-198`），stage 缺失时才读 status 退化（与 `customer_serializers.py:73` 现口径一致）；
- **订单**：六态不变（pending/confirmed/producing/shipped/completed/cancelled）；**TS6 收口**：门面 `completed` 时调内核 `inquiry_stage.advance_for_order`（消除 `orders.ts:973-975` 漂移）；
- **报价**：draft→sent→accepted/rejected/expired/closed 不变；**前端补状态流转入口**（见 §6），已生成下游单证/订单的报价锁定关键字段（沿用 quote_no 锁定规则同款闸门）。

## 6. 编辑能力补齐矩阵（本方案新增重点）

| 对象 | 新增编辑入口 | 后端 | 锁定规则 |
|---|---|---|---|
| 询盘 | 询盘详情/工位内「编辑」：产品行增删改、渠道、备注 | `PATCH /inquiries/{id}` 已支持 items/channel（`ws_crm_ext.py:318-442`），前端接线即可 | 已生成报价的询盘：编号锁定（现规则）；产品行允许改并留 `updated_at` |
| 报价 | 报价记录详情抽屉「编辑」：行项整批替换、条款、客户、币种、有效期、状态流转 | `QuoteOrderPatch` + `QuoteOrderItemsReplace` 已有（`shared/contracts/quote-order.ts:142-170`） | 已转订单/已开单证的报价：行项与金额锁定，仅允许状态流转；锁定原因明示 |
| 订单 | 订单详情「货物明细」可增删改（行级编辑 + 整批替换两种交互） | **两端新增**：内核 `update_order_api` 支持 items 替换 + 重算 total/amount_breakdown；门面透传；契约 `OrderItemsReplace` | confirmed 及以后：行项锁定（改单走取消重下或显式改单理由）；pending 可自由改 |

## 7. 统计与权重口径（业务规则只在 Python 内核）

- **商机漏斗**：询盘数 → 已报价询盘数 → 已下单询盘数 → 已成笔数/成交金额；
- **权重**（初始值，待用户拍板）：询盘 1 / 报价 2 / 订单 10（订单=实际付款，权重最大；可选按订单金额加权）；
- **转化率**：分渠道（`source_channel`）、分时间段；「询盘转化 vs 直接下单」占比；
- **入口**：dashboard 占位页落地为「商机漏斗 + 分渠道转化 + 订单/应收概览」；`/dashboard/summary` 三表混计数废弃，改漏斗结构；
- **规则位置**：`backend/kaas_common/workstation/funnel.py`（新增，纯函数），worker/门面两端共用。

## 8. API 契约变更清单

| 端点 | 变更 | 层 |
|---|---|---|
| `POST /orders` | 接受 `inquiry_id`、`source_type`、`source_channel`；自动判定+显式覆盖；转化时冗余回写 inquiry_id | 内核 + 门面 |
| `GET /orders` / `GET /orders/{id}` | 返回 `source_type`/`source_channel`/`inquiry_id`；列表支持 `source_type`/`source_channel` 筛选 | 内核 + 门面 |
| `PATCH /orders/{id}` | 新增 `items` 整批替换 + 重算金额（pending 状态） | 内核 + 门面 |
| `GET /inquiries`（**新端点**） | 跨客户询盘列表：渠道/stage/客户/时间筛选，带报价数/订单计数字段 | 内核 + 门面 |
| `GET /inquiries/{id}` | 详情带**报价历史**（1:N，含每次时间/金额/状态）+ 关联订单 + stage 流水 | 内核 + 门面 |
| `PATCH /inquiries/{id}` | 已有能力前端接线（items/channel）；无需后端改动 | 前端 |
| `PATCH /quotes/{id}` + 行项替换 | 已有契约前端接线；补「锁定原因」字段（下游单证/订单存在时禁用行项编辑） | 前端为主 |
| `GET /dashboard/funnel`（**新端点**） | 漏斗 + 分渠道转化 + 时间序列 | 内核 + 门面 |
| `/dashboard/summary` | 废弃三表混计数（保留字段兼容，标注 deprecated） | 内核 + 门面 |

契约同步：zod 从 Python pydantic 生成（禁止手抄）；`shared/contracts/*` 同 PR；contracts R0–R5 + 金标 harness 全绿。

## 9. 前端结构

### 9.1 新增 `/inquiries` 工位（独立一等入口）

- 列表：询盘号/客户/产品摘要/渠道/阶段徽标/报价数/关联订单/创建时间；筛选：阶段、渠道、客户、时间；
- 详情（DetailDrawer 或独立页）：产品行（可编辑）、渠道（可编辑）、**报价历史**（同询盘多份报价，按时间倒序，每份含金额/状态/时间）、转化出的订单、stage 时间线；
- 操作：编辑、为此询盘报价（跳报价工位带参）、关闭/重开。

### 9.2 `/orders` 工位改造

- 列表新增列：**来源**（询盘转化/直接下单·渠道）、**关联询盘/报价**（可点跳转）；筛选：状态、来源、渠道、客户；
- 顶部入口重组：「报价转订单」与「直接新建订单」**平级**（后者升为常规入口，不再隐藏）；
- 详情：头部展示来源链（询盘→报价→本订单，可点跳转）；货物明细**可编辑**（pending）；贸易条款可编辑（现有）；单证/收款/出运时间线汇总。

### 9.3 报价工位改造

- 「报价记录」详情抽屉补「编辑」：行项整批替换、条款、状态流转（draft→sent→accepted/rejected/expired）；
- 锁定规则明示：已转订单/已开单证 → 行项锁定，只留状态流转与备注。

### 9.4 客户详情调整

- 询盘 tab 保留（客户维度视角），但主入口迁 `/inquiries`；
- `UnlinkedRecords`（`inquiry-followups.tsx:672-693`）语义从「未关联异常」改为「**直接下单**（正常分类，带渠道标签）」，默认展开不再折叠。

## 10. 落地约束与门禁

- 业务规则只在 Python 内核（`kaas_common`/worker）一处实现；TS 门面只做鉴权/参数校验/协议转换；
- 改 `kaas_common` 后跑 `scripts/sync-shared.ps1`；静态断言全套（schema-coverage / schema-drift / runtime-deps / worker-bundle / deploy-domains）；
- 门禁数字口径见 `AGENTS.md`（worker 1565+12skip / ts-worker 208 / orchestrator 247 / 前端 934 / e2e 27）；
- UI：遵守 `docs/UI_STANDARDS.md`，`pnpm ui:standards` + `pnpm ui:contrast`；新路由会被 e2e a11y 自动发现；
- 迁移上线前跑回填 SQL 的 dry-run；`alembic check` 无漂移；
- TS6 漂移在本方案 M2 收口并销账。

## 11. 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 模型与内核** | 枚举/迁移/回填；orders 三新字段 + 写入逻辑；订单 items 增删改（内核+门面+契约）；`funnel.py` 统计规则；`GET /inquiries` 列表/详情（含报价历史）；TS6 收口 | orchestrator/worker/ts-worker 测试 + contracts R0–R5 + 金标 + 回填 dry-run 留证 |
| **M2 门面与前端** | `/inquiries` 工位；`/orders` 来源列/筛选/详情来源链/货物行编辑；报价记录编辑入口；询盘编辑入口；客户详情语义调整 | 前端全套（typecheck/lint/test/ui/e2e）+ mocks 同步 |
| **M3 仪表盘** | dashboard 落地漏斗/分渠道转化/订单应收概览；`/dashboard/summary` 废弃混计数 | e2e + 与内核漏斗单测交叉验证 |

## 12. 待用户拍板（实施前）

| # | 事项 | 选项与代价 |
|---|---|---|
| Q-1 | **权重数值** | 建议 询盘1/报价2/订单10（订单=付款，权重最大）；备选按订单金额加权（更精细但漏斗图变复合指标） |
| Q-2 | **渠道枚举扩展** | 是否加 phone/referral（线下电话/老客户介绍是真实主源）；不加则直下单只能记 other |
| Q-3 | **confirmed 后订单行项锁定** | 建议锁定（已确认=合同已立，改单走取消重下并留痕）；备选允许改并记审计事件 |
| Q-4 | **询盘主入口形态** | 独立 `/inquiries` 工位（推荐，与订单对等）vs 继续挂在客户页但升为完整页 |

> 拍板方式：`ask_user_question` 弹窗（AGENTS 规则 2）；拍板结果回填本文件并销 TODO §Q 对应条目。
