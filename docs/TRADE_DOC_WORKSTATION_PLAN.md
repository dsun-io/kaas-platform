# 单证工位 · 前端 / 交互 / 导出 实施方案（v3 · 决策已定，待批准开工）

> 状态：**决策已全部拍板，等 David 最终点头即开工**。
> v3 相对 v2 的变化：D0 定为 **X′ 前端渲染**；贸易条款**加正列**；Excel 用 **exceljs**；
> Python 渲染器**删除**；新增**信息架构约定**（一个侧边栏 / 工位内配置 / 设置页为超集）。

---

## 0. 已确认的决策（汇总，详见 §9）

| 项 | 结论 |
|---|---|
| **D0 渲染归属** | **X′ 前端渲染**（TS 唯一实现）|
| PDF 生成 | **先做浏览器打印**，预留后续「一键下载」接口 |
| 详情页形态 | **列表 + 组件内详情（`?id=`）**，不做独立动态路由 |
| 导出范围 | 单份打印/PDF · 批量合并打印 · 台账 CSV · **台账 Excel（exceljs）** |
| AI 补全 | **要做**，但 **AI 产出必须经人工审核才可入库/签发** |
| 贸易条款落库 | `quote_orders` / `orders` **加正列** |
| Python 渲染器 | X′ 落地后 **删除**（含 43 个测试，迁为 vitest） |
| 实施范围 | **W0–W4 全做** |

---

## 0.5 ⚠️ 架构阻塞项 D0：线上没有单证渲染能力（最优先决策）

### 事实

这个项目的架构是「**`orchestrator` 开发 → 手工同步到 `worker/main.py` 单文件上线**」：

| 位置 | 性质 | 依赖 |
|---|---|---|
| `backend/orchestrator/` | 完整开发环境（SQLAlchemy + alembic + 20+ 依赖 + 我的 18 类模板与渲染器） | 重 |
| `backend/worker/src/main.py` | **线上实际运行**：单文件 2800+ 行，手写路由，直连 asyncpg | 刻意裁剪到 6 个包 |

核查线上 Worker 的单证能力：

| 能力 | 线上 |
|---|---|
| `GET/POST /api/v1/trade-docs`、`{id}`、`PATCH` | ✅ 有（注释标注"与 dev trade_docs 对齐"） |
| `GET /api/v1/trade-doc-templates` | ❌ **无** |
| `GET /api/v1/trade-docs/{id}/render` | ❌ **无** |
| 18 个 HTML 模板 / 共享 CSS / 渲染器 | ❌ **无**（`grep render\|template\|COMMERCIAL INVOICE` 零命中） |

**结论**：现状下线上只能"开单存库"，**渲染不出单据**。前端若照 v1 方案做，点预览即 404。

顺带发现一个同类隐患：`orchestrator` 用了 `openpyxl`（`services/export_quote/report.py::write_xlsx`），
但它在 **Worker 依赖里没有** —— 后端出 Excel 在线上同样不可用。**这条直接决定 Excel 台账要走前端。**

### 三个解决路径

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **X′（推荐）前端渲染** | 模板 + 渲染逻辑**移到前端**（TS）；后端只提供数据（`raw_payload` + 快照）。Python 渲染器**标记 deprecated**（保留不扩展）或删除 | ① 唯一能让功能真正上线的路径；② 预览/打印本来就在浏览器，零网络往返、即时；③ 模板是静态资源，天然属于前端；④ **避免长期维护两份实现** | Python 版 43 个测试需移植为 TS 单测（中等工作量，但直接有效） |
| **W′ Worker 内嵌** | 在 `worker/main.py` 加两个路由，把 18 个模板 + 渲染逻辑内嵌进 Worker | 单一实现；未来服务端发邮件/出 PDF 时可复用 | Worker 体积 +约 190KB；单文件 `main.py` 更臃肿（与"精简"设计目标冲突）；预览仍需多一次网络往返 |
| Z 双实现 | orchestrator 为主，写脚本同步到 worker | 保留现有测试 | **两份实现必然漂移**；同步脚本易漏；不推荐 |

> ✅ **已决策：X′ 前端渲染。**
> 模板与渲染逻辑放**前端（TS）**，后端只提供数据；`orchestrator` 的 Python 渲染器
> 与 43 个测试**删除**（避免两份实现漂移），TS 版成为唯一真相。
> 因此 **Worker 侧不需要**新增 `/trade-doc-templates` 与 `/trade-docs/{id}/render`。
>
> 带来的好处：预览/打印零网络往返、模板与单证产物同属前端资产、
> 线上不再有"能开单但渲染不出"的断层。
> 代价：W0 需把 Python 渲染器（金额大写、日期格式化、固定列、TOTAL 行）
> 逐条移植为 TS，并用现有 `sample_docs/*.html` 作**基准逐字节比对**，确保无回归。

---

## 1. 业务数据连贯性设计（报价工位 ↔ 单证工位）

### 1.1 现有数据链路（已核实）

```
询盘 cust_inquiries ─┐
                     ├──> 报价单 quote_orders / quote_order_items
报价工位（智能报价/出口报价引擎）产出：产品规格 + 价格 + 有效期
                     │        │  POST /api/v1/orders {quote_order_id}
                     │        │  → 复制头+行项，建 order_quote_refs(converted_from)
                     │        ↓
                     └──> 订单 orders / order_items
                              │  POST /api/v1/trade-docs {order_id|quote_order_id|inquiry_id}
                              │  → 冻结快照入 raw_payload.sources + 建 *_refs 溯源
                              ↓
                          单证 trade_docs（status: draft → issued → void）
```

已有良好基础：**开单时冻结上游快照**（`raw_payload.sources`），防关联变更导致历史单据失真；
渲染时 **`custom` 优先、快照兜底**。这是"既要连贯、又不能被上游改动污染历史"的正确姿势。

### 1.2 四个连贯性缺口（实测，非推测）

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| **G1** | **卖方抬头（我方企业主体）无处配置** | 全库搜 `company_name` 只出现在注册流程（`auth.py`）；`_build_render_data` 里 `seller_company` 默认空串 | **最严重**：每张单证的卖方信头都是空白，单据等同废纸，且每张都要手填 |
| **G2** | **上游快照没带商品规格** | `_order_snapshot` / `_quote_snapshot` 只带 `product_name/qty/qty_unit/unit_price/line_amount`，**没带 `spec_snapshot`**（该 JSONB 列在 `quote_order_items`/`order_items` 里是存在的） | 商业发票/装箱单的 `Specification`、HS Code、重量全空 —— 而这些正是单证的核心列 |
| **G3** | **上游表没有贸易条款字段** | `quote_orders` 字段：quote_no/customer/status/currency/total_amount/valid_until/notes；`orders`：order_no/customer/status/currency/total_amount/order_date/delivery_date/notes。**都没有** incoterm / payment_terms / port_of_loading / port_of_destination / shipping_marks | 报价谈定的贸易术语与付款方式无法继承，单证要手工重填 → 极易与合同不一致（信用证下就是"不符点"） |
| **G4** | **买方只有公司名** | 快照仅 `customer_name`；客户表 `customers` 有 name/country，联系人表 `cust_contacts` 存在 | Consignee 块缺地址/联系人/电话 → **清关会出问题** |

### 1.3 补法

| 缺口 | 方案 | 涉及改动 |
|---|---|---|
| **G1** | 新增**企业主体信息**（租户级配置：中英文名、地址、电话、邮箱、开户行/账号/SWIFT、Logo），保存后所有单证自动带入 | 新表 `tenant_company_profile`（或复用租户表加 JSONB 列）+ `GET/PUT /api/v1/tenant/company-profile` + 前端「设置 → 企业信息」页 |
| **G2** | 快照补 `spec_snapshot`；并新增**商品描述归一**环节（见 §1.5） | `_order_snapshot`/`_quote_snapshot`（orchestrator + worker 两处） |
| **G3** | 给 `quote_orders` / `orders` **加列**：`incoterm` / `payment_terms` / `port_of_loading` / `port_of_destination` / `shipping_marks` / `country_of_origin` | alembic 迁移 + 两处快照 + 报价/订单表单加这几个字段 |
| **G4** | 快照补买方完整信息（查 `customers` + `cust_contacts` 带出地址/联系人/电话/邮箱） | 快照函数 |

> **G3 的替代方案**：不加列，改在这些表加一个 `trade_terms JSONB`。
> 但贸易条款是**稳定的核心业务字段**（不是临时扩展），且有查询/校验需求，
> 我倾向**正列**（类型明确、可建索引、前端表单好做）。

### 1.4 一致性策略（"连贯"不等于"实时联动"）

这是设计的核心取舍，请确认：

| 场景 | 策略 | 理由 |
|---|---|---|
| 开单时 | **冻结快照** | 历史单据不可被上游改动污染 |
| draft 阶段 | 提供**「从上游重新带入」**按钮，重新拉快照并覆盖 `sources`（**保留 `custom` 里已手工改过的字段**，逐字段提示"将要覆盖"） | 报价改了还没签发时，允许一键同步 |
| issued 阶段 | **彻底冻结**，任何上游变更不影响 | 已签发单据是法律凭证 |
| 全局 | 单证详情页显示**上游一致性提示**：若上游单号/金额与快照不一致，标黄提示"上游已变更，快照为 2026-09-26 版本" | 让人看见差异，而不是悄悄不同步 |

### 1.5 商品描述归一（连贯性最难的一环，也是 AI 的最佳落点）

报价工位产出的是**结构化中文工程参数**（实测 `niulanwang.ts` / `quote_v2.py`：

`wire_option: 全丝2.5`、`height: 1.5`、`mesh_spec`、`roll_length`、`quantity`）。

而单证需要的是**规范英文描述**：`2.5mm wire, 8/150/15, H1.5m x L50m/roll`。

**这不是字段搬运，是语义转换**。设计三级链路：

1. **规则化转换（首选，稳定可测）**：项目已有规格体系（`spec-system`、`niulanwang.ts` 的 5 轴 48 组合、
   后端 `field_fence.py` 权威定义），可写出「规格轴 → 英文描述片段」的确定性映射，覆盖已知产品线。
2. **AI 补全（兜底，仅用于规则未覆盖的产品）**：把结构化参数交给 LLM 生成英文描述。
3. **人工审核（强制，见 §2）**：无论 1 还是 2，**描述文本进入"待确认"状态**，由业务员确认后才写入 `custom` 并允许签发。

> 这样既拿到连贯性（参数自动带入），又不会让 AI 直接产出对外单据内容。

### 1.6 联动交互（双向）

| 位置 | 交互 |
|---|---|
| **报价工位**（`/quotations/v2-quote` 或报价历史详情） | 加「**生成单证**」按钮 → 选类型（多选）→ 批量开单（带 `quote_order_id`）→ 跳转单证工位 |
| **报价工位** | 展示"**该报价已生成 N 张单证**"（查 `trade_doc_quote_refs`）→ 点击跳转 |
| **单证工位详情** | 显示来源（询盘/报价单/订单）及其单号，可点击**跳回上游** |
| **单证工位列表** | 支持按"来源单号"搜索（已有 `order_id` 筛选，需补 `quote_order_id`/`inquiry_id` 筛选） |

---

## 2. AI 补全 + 人工审核（按你的要求设计）

**铁律：AI 产出永不直接落库、永不直接进已签发单据。**

机制设计：

| 环节 | 设计 |
|---|---|
| 触发 | 字段旁「AI 补全」按钮（**逐字段**，不做"一键填满整张单"），或"商品描述归一"时的兜底 |
| 产出状态 | 写入 `raw_payload.ai_suggestions[field] = {value, model, prompt_hash, created_at}`，**不写进 `custom`** |
| 展示 | 表单里该字段显示为**待确认态**（虚线边框 + "AI 建议"徽标），旁边「采纳 / 忽略 / 编辑后采纳」 |
| 采纳 | 点采纳才写入 `custom[field]`，同时 `raw_payload.field_sources[field] = "ai_confirmed:{model}"` |
| 拦截 | **`draft → issued` 时校验**：若仍有未确认的 AI 建议 → 409 拒绝签发，提示"还有 N 项 AI 建议待确认" |
| 留痕 | 审计日志记录：字段、AI 原值、最终采纳值、模型、时间、操作人 |
| 字段来源可视化 | 每个字段标注来源：`上游` / `AI(待确认)` / `AI(已采纳)` / `手工`，一眼看清哪些是机器填的 |

**生成时引导**：AI 建议不改变已确认内容，只填补空字段（避免覆盖人工输入）。

---

## 3. 页面与交互

### 3.0 信息架构约定（按你的要求）

> 原话：「每一个工位我要求只有一个侧边栏，配置可以在他们各自工位内配置，
> 设置页面可以说是登陆账号权限内所有工位设置项的超集。」

落实到本工位：

| 约定 | 做法 |
|---|---|
| **全局只有一个侧边栏** | 工位内部**不再长第二套导航**；工位内子页面（列表 / 模板 / 企业信息）一律用**页签（Tabs）**表达 —— 与现有「智能报价」页（报价助手 / 批量导入 / 报价数据）完全一致 |
| **配置就近** | 单证的**企业主体信息**、**默认条款模板**放在单证工位内的「配置」页签，业务员不用跳出去 |
| **设置页 = 超集** | 「设置」页汇总展示各工位设置项（含企业主体信息）；权限不足的项只读或隐藏；**同一份数据、两个入口，后端是单一来源** |

### 3.1 路由与导航
- `/trade-docs`（列表 + 组件内详情，`?id=` 记录选中），工位内用页签切换
- 侧边栏「业务」组，放在「报价历史」之后：**单证工位**（唯一入口）

### 3.2 列表页
- 筛选：单证类型（18 类分组）· 状态 · **来源单号**（报价单/订单/询盘）
- 列：单证号 · 类型 · 来源 · 客户 · 币种金额 · 状态 · 签发时间 · 操作
- 多选 → 浮出操作条「打印所选（N）」「导出台账」

### 3.3 新建
1. 选类型（分「出口商自制 / 第三方签发」两组，第三方带 ⓘ 说明"本系统仅出申报信息"）
2. 选上游（订单 / 报价单 / 询盘，至少一个）
3. 提交 → 后端取号 + 冻结快照 → 跳详情
4. **从报价工位进入时**：上游与类型可预选（如"报价单 → Quotation/PI"）

### 3.4 详情页（左表单 · 右预览）

```
┌──────────────────────────────┬───────────────────────────────┐
│ ① 来源（可跳转） + 一致性提示  │                               │
│ ② 基本信息（只读）            │     实时预览（A4 等比）        │
│ ③ 要素表单（动态）            │     iframe + Blob URL         │
│   字段来源标记 + AI 待确认态   │                               │
│   明细行编辑（增删/排序/小计）  │  [刷新预览][打印][批量打印]    │
│ ④ 操作：从上游带入 / 签发 / 作废│  [导出 PDF][导出台账]          │
└──────────────────────────────┴───────────────────────────────┘
```

- **表单由后端 `fields` 驱动**（`GET /trade-doc-templates/{type}`），前端不硬编码 18 套
- draft 自动保存（debounce 5s）；issued 后整体置灰
- 预览：`fetch` → `Blob` → `iframe`（**iframe 无法带 Authorization 头，必须走 Blob**）；切换时 `revokeObjectURL`

---

## 4. 导出设计

### 4.1 单份打印
隐藏 iframe 载入单证 HTML → `iframe.contentWindow.print()`（用隐藏 iframe 而非 `window.open`，避免被拦截）。

### 4.2 批量合并打印（一次出 N 页）
抽各份的 `<style>` 与 `.doc`，拼成单文档 + `page-break-after: always`（末份复位）。
坑点（逐条落进单测）：不能拼完整 HTML（多个 `<head>` 样式互盖）；共享 CSS 去重；末份分页复位否则多空白页；用完 `revokeObjectURL`。

### 4.3 台账 CSV
列：单证号·类型·状态·来源单号·客户·币种·金额·签发时间。复用 `triggerBlobDownload`，加 BOM 防中文乱码。
**必须做公式注入防护**：以 `= + - @` 开头的值前置 `'`。

### 4.4 台账 Excel（本次新增）

**"Excel 台账"是什么**：把单证清单导成 `.xlsx` 表格，一行一张单证，给财务/报关/月度对账用。
与 CSV 的差别：真 Excel 文件，可**多 sheet、设列宽、金额用数字格式、冻结表头**，不会被 Excel 误解析。

建议 3 个 sheet：

| sheet | 内容 |
|---|---|
| 单证明细 | 单证号·类型·状态·来源单号·客户·币种·金额·签发人·签发时间 |
| 按类型汇总 | 18 类 × 张数 × 金额合计 |
| 按客户/月份汇总 | 客户 × 月份 × 张数 × 金额 |

**技术路线（重要）**：
- ❌ **不走后端**：`openpyxl` 不在 Worker 依赖里（§0.5），线上必失败
- ✅ **走前端生成**：引入 **`exceljs`**（活跃维护、MIT、支持多 sheet/列宽/数字格式）
- ⚠️ **不用 `xlsx`（SheetJS）npm 包**：其 npm 分发长期停更，已知原型污染 CVE，修复版只在自家 CDN 发布 —— 不适合进依赖树
- 体积考量：`exceljs` 约 500KB，若介意可改 **`write-excel-file`**（约 30KB，够做单表台账），二选一请你定

---

## 5. 需要改动的后端 / Worker

| 改动 | 位置 | 必要性 |
|---|---|---|
| **企业主体信息**（表 + GET/PUT 接口） | orchestrator + worker 双份 | 🔴 必须（G1） |
| 快照补 `spec_snapshot` + 买方详情 | `_order_snapshot`/`_quote_snapshot`（双份） | 🔴 必须（G2/G4） |
| `quote_orders`/`orders` 加贸易条款列 | alembic 迁移 + 双份模型 | 🔴 必须（G3） |
| 列表接口支持 `quote_order_id`/`inquiry_id` 筛选 | 双份 | 🟡 应做（联动搜索） |
| 反查接口：报价单 → 已生成单证 | 双份 | 🟡 应做（§1.6） |
| ~~渲染接口 / 模板~~ | — | ✅ **不需要**（D0 选 X′，渲染在前端） |

> **注意**：这个项目**所有后端改动都要做两遍**（orchestrator + worker 单文件），
> 且 worker 侧是手写 asyncpg SQL。这是既有工作流，不是本方案引入的。

### 5.5 架构债：为什么"上线要手动同步"（已定：纳入 W1 一起填）

**定性**：这不是分层（分层是同接口不同实现细节），而是**同一份业务逻辑被重复实现两遍**。
部署是自动的（`0835a24 ci: auto-deploy Worker kaas on push`），但**代码内容要人手工抄第二遍** ——
自动化了错误的东西。

**实证（已全量审计）**：

| 指标 | 数值 |
|---|---|
| 开发版（orchestrator）接口 | 135 |
| 线上（worker）接口 | 65 |
| 开发版有、线上没有 | **80**（占 59%） |
| **其中：前端正在调用 → 线上就是坏的** | **33** |
| 反向漂移（线上有、主线没有） | **10** |

完整清单与处置优先级：**`docs/WORKER_ORCHESTRATOR_DRIFT.md`**
收敛方案（与单证工位联合实施）：**`docs/DUAL_BACKEND_CONVERGENCE.md`**

**结论（已获 David 批准）**：不单独开"还债专项"，而是**让单证工位的开发过程本身成为还债的载体**：

- 新增后端改动全部写在共享内核 `backend/common/`，两侧只写薄适配 → **新代码只有一份**
- CI 加"路由一致性门禁" + 白名单（**只减不增**）→ **债务只减不增**
- 顺带把 `next_doc_no`、状态机、快照组装抽进内核 → 存量也在缩

具体 Wave 安排见本文 **§7（W0–W4 已重排）**。

---

## 6. 文件清单

**前端新增**
```
frontend/src/app/(app)/trade-docs/
  page.tsx  loading.tsx  error.tsx
  components/  trade-doc-filters / trade-doc-table / trade-doc-create-dialog
               trade-doc-detail / trade-doc-field-form / trade-doc-items-editor
               trade-doc-preview / ai-suggestion-badge / field-source-tag
  hooks/       use-trade-docs.ts  use-trade-doc-templates.ts
frontend/src/lib/trade-doc/
  render.ts          ← 渲染逻辑（若选 D0-X′：从 Python 移植，含金额大写/日期/固定列）
  templates/         ← 18 类模板（若选 D0-X′）
  print.ts           单份/合并打印
  excel.ts           台账 xlsx（exceljs）
  csv.ts             台账 csv（含公式注入防护）
  __tests__/         render.test.ts / print.test.ts / excel.test.ts
frontend/src/app/(app)/trade-docs/components/company-profile-panel.tsx  企业信息（工位内配置页签）
frontend/src/app/(app)/settings/                      设置页新增「企业信息」超集入口（同一份数据）
shared/contracts/trade-doc.ts                        契约
```

**修改**：`sidebar.tsx`（导航）· `scripts/contracts-check.ts`（纳入契约）·
报价工位页面（加"生成单证"入口）· `docs/TRADE_DOC_TEMPLATES.md`

**后端/Worker**：见 §5。

---

## 7. Wave 拆分

| Wave | 内容 | 验收 |
|---|---|---|
| **W0** | 渲染迁前端 TS（D0=X′），43 个 Python 测试迁 vitest | ① 建 `backend/common/` 骨架 + **验证 Worker 能否 import 共享包**（Plan A/B，见收敛方案 §3.1）② 审计脚本升级为带白名单的 `route-parity-check` 门禁 | vitest 全绿；18 类单证渲染与 Python 版**逐字节一致**；门禁能拦住新增漂移 |
| **W1** | 企业主体信息、快照补字段、贸易条款正列、筛选/反查 | 这些逻辑**只写内核**；顺带抽 `next_doc_no`/状态机/快照组装；修 `customers/stage` 方法分叉 | 双端契约测试通过；白名单缩减 |
| **W2** | 列表 / 新建 / 详情 / 动态表单 / 明细编辑 / 状态流转 | **B 类 10 个反向漂移补齐到主线** | 白名单缩减 10 项 |
| **W3** | 预览 + 单份打印 + 批量合并打印 + 台账 CSV + **台账 Excel** | 无（纯前端） | A2/A3/A4 达标；三个单测文件通过 |
| **W4** | AI 补全（人工审核）+ 报价工位双向联动 | **A 类 33 项按"已启用"优先补**（走内核）+ 双端契约测试 | 白名单持续缩减，燃尽曲线可见 |

**每波结束**：`pnpm typecheck` + `pnpm test` + `pnpm contracts:check` + 内置浏览器实测预览链路
（打印对话框本身不可自动化，验证到"调用 print"为止，实际出纸由人工确认）。

---

## 8. 风险清单

| 风险 | 对策 |
|---|---|
| **两份后端实现漂移**（orchestrator vs worker） | 契约测试（contracts-check）纳入 trade-doc；改动清单必须双份核对 |
| **两份渲染实现漂移**（若选 Z） | **不选 Z**；推荐 X′ 单一实现 |
| AI 产出被误当正式内容 | §2 的待确认态 + 签发拦截 + 来源标记 + 审计留痕 |
| 历史单据被上游改动污染 | 快照冻结 + 刷新仅在 draft + 一致性提示 |
| 贸易条款加列影响既有数据 | 迁移全部 nullable，默认值不写死，旧数据保持 null（渲染为空，不报错） |
| 静态导出下 `useSearchParams` 需 Suspense | W2 就用 Suspense 边界包住 |
| iframe blob 打印跨浏览器差异 | 明确只保证 Chrome/Edge（内网业务系统），UI 内注明 |
| 打印不输出背景色 | 打印入口常驻提示"勾选背景图形" |
| Excel 库体积 | `exceljs` vs `write-excel-file` 二选一（见 §4.4） |

---

## 9. 决策记录（已全部拍板）

| # | 决策项 | 结论 |
|---|---|---|
| D0 | 渲染归属 | **X′ 前端渲染**（TS 为唯一实现）；Worker 不加渲染接口 |
| D1 | PDF 生成 | 先**浏览器打印**，预留一键下载 |
| D2 | 详情页形态 | **列表 + 组件内详情（`?id=`）** |
| D3 | 导出范围 | 单份打印 · 批量合并打印 · 台账 CSV · **台账 Excel（exceljs）** |
| D4 | AI 补全 | 做，但**必须人工审核**才可入库/签发 |
| D5 | 贸易条款落库 | `quote_orders`/`orders` **加正列** |
| D6 | 信息架构 | 一个侧边栏；配置就近在工位内；设置页为各工位设置项超集 |
| D7 | Python 渲染器 | X′ 落地后**删除**（含 43 个测试，迁为 vitest） |
| D8 | 实施范围 | W0–W4 全做 |

**开工前唯一需要你点头的**：§3.0 对「一个侧边栏 / 工位内配置 / 设置页超集」的理解是否准确
（我的理解：工位内子页面用**页签**表达，不再长第二套导航；配置项在工位内可达，设置页汇总同一份数据）。

> 另：v1 遗留问题「单证工位在侧边栏的位置」已在 D6/§3.1 定为「业务」组下、「报价历史」之后，唯一入口。
