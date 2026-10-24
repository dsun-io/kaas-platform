# 优化方案 · 产品管理 × 报价重构（2026-10-23）

> **状态**：🧭 方案已定稿、待用户批准排期（§6 四个批次 A/B/C/D）；三处口径已由用户弹窗拍板（§2）。
> **来源**：用户 2026-10-23 口头反馈 14 条（§0 原文照录）+ 本会话全量代码定位（§1，文件/行号已逐一核实）。
> **范围**：产品工位（/products）详情表单、报价工位（/quotes）工作台行卡与整单参数、
> 税务档案侧边栏与命名、批量导入整单化。**单证（trade-docs）与定价数据（pricing-data）不在本批，
> 只保证契约不被破坏。**
> **架构铁律**（ADR-008）：业务规则只在 Python 内核一处实现；跨层契约变更同 PR +
> 金标 harness 全绿；TS 侧 zod schema 从 pydantic 生成，禁止手抄。

---

## 0. 用户反馈原文（2026-10-23，照录）

**产品管理中的修改：**
1. 产品基本信息：表面处理、材质，做成类似包装一样的，添加多个可选项。
2. HS 编码重复了，删掉。
3. 价格与利润中：利润率、综合税费、成本口径这部分在报价中配置就行了，产品中不需要，删掉。
4. 规格参数可以保留最大值最小值的配置。
5. 可选挡位这个字段什么意思，这个字段删除。但是里面的表面处理移到产品基本信息中
   （和基本信息中的表面处理只保留一个就行了）。
6. 包装去掉「包装1/包装2」这个字段，直接就展示包装方式、是否默认以及金额。
7. 所有产品都用这种类似的设计。

**报价：**
8. 包装方式直接展示：具体什么包装而不是「包装1」这种名字。
9. 产品基本信息放在上边，件数、金额放在下面，每种不同的类型要换行展示。
10. 产品成本就在报价中配置，可以选择是否含税。
11. 税务管理侧边栏没看到。企业的销项杂税、进项增值税、产品退税率等信息都在那里面统一配置，
    然后命名成税务档案；报价中整单参数直接引用对应的税务档案就行。
12. 批量导入不应该区分产品，应该直接导入整个订单的 N 个产品直接报价。

**交付要求**：定位以及创建优化方案（本文档）。

---

## 1. 定位（逐条 → 代码位置 → 根因）

> 行号为 2026-10-23 HEAD `6a585f3f` 实测；实施时以符号搜索为准。

| # | 反馈 | 位置 | 根因 / 现状 |
|---|---|---|---|
| 1 | 表面处理/材质是纯文本，要做成多选项 | `frontend/src/app/(app)/products/components/product-detail.tsx:42-49`（`PROFILE_FIELDS`：material/surface/usage/hs_code/packing/origin，全部 `Input` 单行文本，存 `product_profiles.info`） | 这两个字段只是自由文本资料，没有选项机制；「类似包装」= 可加/删多个候选项 |
| 2 | HS 编码重复 | 同上 `product-detail.tsx:46`（基本信息「HS 编码（补充）」，profile.hs_code）**和** `business-spec-editor.tsx:354-373`（规格区「HS 编码」，`spec.hs_codes`，逗号分隔多值） | 同一页两处入口。**报价/单证实际只用 `spec.hs_codes`**（引擎 `models.py` `ProductSpec.hs_codes`），profile.hs_code 是无功能的展示副本 |
| 3 | 利润率/综合税费/成本口径从产品中删除 | `product-detail.tsx:394-443`（「价格与利润」区：profitPct/taxPct/costBasis 三控件；state 在 81-89） | 产品级默认与报价工作台整单参数（`workbench-params-card.tsx:302+` 利润率/杂税率）**功能重复**；成本口径目前是产品级属性（`engine.py:800-805` 只认 `product.cost_basis`），报价行无法选含税 ⇒ 需要 §3.3 契约扩展 |
| 4 | 规格参数保留 min/max | `business-spec-editor.tsx:119-219` | **已满足**（参数/单位/默认值/最小值/最大值表格），本方案不动 |
| 5 | 「可选档位」看不懂，删掉；表面处理并入基本信息 | `business-spec-editor.tsx:221-267`（variants 渲染 + `OptionAdder` chips） | 变体档位区与基本信息表面处理**双入口并存**；业务不理解「档位」术语。variants 是**算价真源**（`engine.py:568-599` 笛卡尔积 + 定价键 `coating_code`），不能删数据，只能收口为一个入口 |
| 6 | 包装去掉「包装1/包装2」名称 | `business-spec-editor.tsx:85-101`（`addPackaging` 自动生成 `name: "包装 N"`）、288-349（行内「包装名称」Input + 包装方式/默认/金额） | `PackagingItem.name` 是冗余人造名；真实信息是 `method`（包装方式） |
| 7 | 报价包装下拉显示「包装 1」 | `frontend/src/app/(app)/quotes/components/quote-line-card.tsx:673-678`（`{p.name}`（默认））；落库快照 `quotes/lib/line-to-item.ts:260-264`（`packaging_name: p.name`） | 下拉与快照都用 `name`，不用 `method` |
| 8 | 报价行布局：产品信息上、件数金额下、类型换行 | `quote-line-card.tsx:516-720`（按件参数/件数/米数/总数/成本/包装/利润率混在一个 `grid`）；折叠态摘要 475-514（一行塞规格/件数/总数/成本/单卷价/行小计 6 项） | 表单无信息分层；折叠摘要无换行 |
| 9 | 成本在报价中配置 + 含税开关 | `quote-line-card.tsx:618-660`（只有「税前成本」一个 number 输入）；`build-request.ts:50-109`（请求不带 cost_basis） | 引擎 cost_basis 是**产品级**（`engine.py:800-805`），请求无法表达「本行成本是含税价」 |
| 10 | 税务管理侧边栏看不到 | `shared/contracts/workstations.ts:351-363`（tax-archives 在 `group:'admin'`）+ `:81`（admin 组 `internalOnly:true`）+ `frontend/src/components/layout/sidebar.tsx:156-159`（internalOnly 组对非内部账号整组隐藏） | **页面对外可达但导航永远不可见**（admin 组只给平台内部账号）；页面本身已具备企业税档（销项增值税/杂税）+ 产品税率（进项增值税/出口退税率）＝ 用户要的「统一配置」其实已建成 |
| 11 | 命名成税务档案 | `workstations.ts:93`（SUB_ROUTE_LABELS）与 `:355`（工位名「税务管理」）；`settings/tax-archives/page.tsx:310`（页面标题）；后端镜像 `backend/kaas_common/domain/workstations.py:149-156` | 命名不一致：侧边栏/面包屑/页面叫「税务管理」，报价参数卡叫「税务档案」 |
| 12 | 整单参数引用税务档案 | `workbench-params-card.tsx:249-298` | **已实现**（单下拉选档案 → `applyTaxArchive` 自动填税率，改过可「恢复档案值」）；本方案只验证口径 + 跟随 §3.4 改名 |
| 13 | 批量导入不区分产品、整单导入 | `bulk-import-panel.tsx:78`（productKey state）、258-276（第一步先选产品）、166-201（preview/calculate 都带 productKey）；后端 `backend/worker/src/quote_api.py:1002-1130`（template/preview/calculate 三端点 `product_key` 必填）；`importers.py`（单产品列解析） | **整条链路按单产品设计**：模板列、解析、校验、计算全是单产品；无法表达「一个订单 N 个产品」 |
| 14 | 所有产品统一设计 | `product-detail.tsx` / `business-spec-editor.tsx` 已是 spec 数据驱动（无按产品写死分支） | 保持数据驱动即可；重命名/重组后对内置产品与自定义产品一视同仁 |

---

## 2. 口径裁决（2026-10-23 用户弹窗拍板）

| # | 问题 | 拍板结果 |
|---|---|---|
| D-1 | 「材质」多选项是否参与算价 | **仅资料选项，不算价**：报价行选一个材质，写入报价快照与单证显示；不并入规格空间、不增加定价数据行数；成本仍由表面处理/工艺档位决定 |
| D-2 | 整单多产品导入的模板形态 | **单表 + 产品列**：第一列「产品」，其后为各产品规格列并集（无关列留空）；一行 = 订单一个产品行 |
| D-3 | 导入结果落到哪一步 | **直接生成工作台报价单**：解析成功后把 N 个产品行填进报价工作台，可继续调成本/包装/利润，再保存与生成单证（现行「只算不落库」口径废止） |

---

## 3. 目标设计

### 3.1 产品详情页（新结构，所有产品统一）

```
┌ 图片区（不动）───────────────────────────────────────────┐
├ 基本信息 ────────────────────────────────────────────────┤
│ 产品名称 / 英文名 / 用途 / 产地（Input，不动）                │
│ 表面处理 【chips 多选项：热镀锌 40g/㎡ × | 电镀锌 × | + 添加】  │ ← 并入原「可选档位」的 coating 组
│ 材质   【chips 多选项：低碳钢丝 × | 高碳钢丝 × | + 添加】      │ ← 新资料选项（D-1）
│ HS 编码（一个输入框，逗号分隔多值，backed by spec.hs_codes） │ ← 两处合一（反馈 2/5）
│ 材质/表面处理/用途/产地… 保存按钮 = 现有「保存基本信息」        │
├ 规格参数（客户报价时填写：参数/单位/默认值/最小值/最大值）      │ ← 原样保留（反馈 4）
├ 包装 ────────────────────────────────────────────────┤
│ 【包装方式 Input】【是否默认 ○】【金额（元/卷）】【删除】       │ ← 去掉「包装名称」列（反馈 6）
│ + 添加包装                                                │
└ 高级设置（平台管理员折叠，不动）─────────────────────────────┘
```

**删除**：整个「价格与利润」区（利润率/综合税费/成本口径，反馈 3）与「可选档位」区（反馈 5）
——后者不是删数据而是**收口入口**：表面处理 chips 即原档位编辑器。

**数据落点**：

| 字段 | 存储 | 说明 |
|---|---|---|
| 表面处理选项 | `spec.variants` 中 `label === '表面处理'` 的组（现名 `coating`；识别规则 = label 优先，`coating`/`surface` 别名兜底） | **算价真源不动**：报价/定价数据/引擎继续走 variants；基本信息 chips 只是把这组搬上来。产品没有该组时，添加第一个选项即创建组（勾花网现状：options 为空） |
| 材质选项 | `product_profiles.info.material_options: string[]`（profile 本就是自由 dict，`use-products.ts:87-98` PUT 全量保存，**零后端改动**） | D-1：仅资料；报价行选择后写入行快照 |
| HS 编码 | `spec.hs_codes`（唯一入口） | BusinessSpecEditor 的 HS 块删除；`PROFILE_FIELDS` 删 `hs_code`；旧 profile.hs_code 不迁移（展示字段，无引用） |
| 包装 | `PackagingItem` 结构不变；UI 删「包装名称」输入；`addPackaging` 不再生成 `name`；保存时把 `name` 回填为 `method`（旧快照兼容）；旧数据 `method` 为空时显示回落 `name` | 引擎 `_packaging_fee` 只认 id/ranges/amount，name 参与零计算，纯展示 |
| 利润率/杂税/成本口径 | 产品级 spec 字段（`profit_value`/`misc_fee_rate`/`cost_basis`）**保留为引擎兜底默认**，但业务 UI 不再暴露 | 工作台每次算价显式下发 policy（`build-request.ts:98-107`），产品级值仅在缺省时生效；`new-product-dialog.tsx:97-99` 继续写默认 0.06/0.03/pretax |

**「类似包装」的交互**（反馈 1）：chips + 「添加」按钮 = 现 `OptionAdder`（`business-spec-editor.tsx:395-418`）同款，
每 chip 带 × 删除；表面处理 chips 与「定价数据」页的「新增档位」（`AddOptionPanel`）**同源不冲突**：
基本信息管档位列表（不带成本），定价数据管档位 + 成本（一次提交两处生效，现有逻辑）。

### 3.2 报价工作台行卡片（新布局，反馈 7/8/9）

```
┌ 产品信息（上）──────────────────────────────────────────┐
│ 产品选择 ▾   规格选择（轴/变体/数值，SpecPicker 不动）        │
│ 材质 ▾（资料选项，来自产品 profile；无选项则隐藏）             │
├ 件数（中）──────────────────────────────────────────────┤
│ 按件参数… | 件数（卷） | 客户需求（米） | 总数（自动）         │
├ 金额（下）──────────────────────────────────────────────┤
│ 成本 [____] 含税 □（默认不含税） | 包装方式 ▾（显示具体方式）    │
│ 本行利润率（%）（留空=继承整单）                             │
└ 计算本行 → EngineQuoteResult（不动）───────────────────────┘
```

- **三种类型各自成行**（grid 拆三段），折叠态摘要同样按「产品信息 → 件数 → 金额」三行展示。
- **包装下拉**：`{p.method || p.name}` + 默认标记；落库快照 `line-to-item.ts` 增记 `packaging_method`
  （`packaging_name` 保留兼容，值 = method）。
- **材质**：选值存入行快照 `spec_snapshot.material`，供单证显示（D-1）。

### 3.3 成本含税开关（跨层契约变更，唯一引擎改动）

- 契约：`ExportQuoteRequest` 增 `cost_basis?: "pretax" | "incl_tax"`（缺省回落 `product.cost_basis`）。
  - `shared/contracts/export-quote.ts` + `backend/kaas_common/export_quote/models.py`（`QuoteRequest`）
    + `engine.py`（`:800-805` 处 request 级覆盖 product 级）。
  - **同 PR**：TS zod 从 pydantic 生成同步 + `backend/ts-migration/golden/` 金标全绿 + worker pytest。
- 语义：勾「含税」= 该行输入的是含税价，引擎按现行 incl_tax 公式还原税前
  （`cost_pretax = 含税价 × (1 − policy.input_vat_rate)`，`engine.py:800-801` 既有口径，**不引入新换算**；
  进项税率来自税务档案/产品税率）。默认不勾 = 税前成本（现状）。
- 前端：`quote-line-card.tsx` 成本输入旁加 checkbox「按含税价」；`build-request.ts` 透传
  `cost_basis`；批量导入模板增加「成本口径」列（§3.5）。

### 3.4 税务档案（侧边栏 + 命名，反馈 10/11/12）

- `shared/contracts/workstations.ts`：tax-archives `group: 'admin' → 'account'`（与「企业信息」同组，
  外部账号可见；写权限仍按团队管理员，页面已有只读降级 `tax-archives/page.tsx:114-119`）、
  `name: '税务管理' → '税务档案'`；`SUB_ROUTE_LABELS` 同步。
- 后端镜像 `backend/kaas_common/domain/workstations.py:149-156` 逐字段同步（R2 契约检查）。
- `tax-archives/page.tsx` 页面标题与面包屑随工位名自动一致（单一真源）。
- 页面内容**已满足**「销项杂税（企业税档：销项增值税/杂税）+ 进项增值税/产品退税率（产品税率区）」，
  不做结构改动；报价整单参数的档案下拉（`workbench-params-card.tsx:249-298`）维持现状（选档案自动填税率、可覆盖、可恢复档案值）。

### 3.5 批量导入整单化（反馈 13，D-2/D-3）

- **模板**（新端点下载，旧单产品模板端点保留兼容历史文件）：
  - 列结构 = `产品` | 各产品规格列**并集** | `件数（卷）` | `成本` | `成本口径（含税/不含税）` | `包装方式`（可选）| `本行利润率（%）`（可选）。
  - 规格列头沿用各产品模板列头（与导出报价表一致的口径，`quote_api.py:1057-1058` 既有约定）；
    模板说明页（IMPORT_TEMPLATE_NOTES_SHEET）标注每列适用产品。
- **后端**（`quote_api.py` + `importers.py`）：
  - `GET /api/v1/export-quote/import/order/template-info`：整单模板列定义（并集；每列标注适用产品）。
  - `POST /api/v1/export-quote/import/order/preview`：多产品解析（按「产品」列定位 → 该产品自己的列映射），
    行级问题清单（未知产品/缺必填/超范围），不阻断其他行（沿用 `engine.py:516-518` 逐行容错口径）。
  - **实施裁决（2026-10-23）**：**不新增 calculate 端点**——D-3 拍板的落点是「填入工作台」，
    算价/落库全部复用工作台既有链路（每行 `calculate` + `quote_orders` 保存），避免第二套算价口径。
    `OrderImportRow` 里带 `cost_basis`/`packaging_id`/`profit_pct`，工作台行草稿直接用。
- **前端**（`bulk-import-panel.tsx` 重做）：
  - 去掉「第一步选产品」；下载整单模板（列并集由前端汇总各产品模板信息接口生成，延续 exceljs 方案）。
  - 预览确认 → **「填入工作台」**：把 N 行映射为 N 个 `LineDraft`（`quote-line-card.tsx:50-85`），
    跳转产品报价 tab；后续成本/包装/利润微调、保存报价单、生成单证全部复用现有链路（D-3）。
  - `spec_snapshot` 里记录 `import_source` 便于追溯。

---

## 4. 实施批次（依赖排序，每批独立可交付）

| 批 | 内容 | 主要文件 | 依赖 | 门禁增量 |
|---|---|---|---|---|
| **A** 产品页收口 | 包装去名称（A1）→ 表面处理 chips 并入基本信息（A2）→ 材质 chips（A3）→ HS 合一（A4）→ 删价格与利润区（A5） | product-detail.tsx、business-spec-editor.tsx、tenant-products.ts、use-products.ts | — | 前端 typecheck/lint/test（`business-spec-editor.test.tsx`、`product-spec-editor.test.tsx` 等同步改）+ ui:standards/contrast |
| **B** 报价行重排 | 行卡三段布局 + 折叠摘要换行（B1）→ 包装下拉显示方式（B2）→ 材质选择入行快照（B3） | quote-line-card.tsx、line-to-item.ts、spec-picker.tsx | A3（材质选项存在） | quote-line-card 相关测试 + e2e a11y |
| **C** 契约批 | request 级 cost_basis（C1）→ 税务档案侧边栏/改名（C2） | shared/contracts/export-quote.ts、kaas_common models/engine、quote-line-card.tsx、build-request.ts、workstations.ts 双端、tax-archives 页 | C1 先于 B 的含税开关接线（B 可先做 UI 骨架） | **contracts:check R2 + 金标 harness + worker pytest + TS zod 同步**（同 PR，铁律） |
| **D** 批量导入整单 | 模板并集 + 双端点（D1）→ panel 重做 + 填入工作台（D2）→ 模板说明/文档（D3） | quote_api.py、importers.py、import-template-xlsx.ts、bulk-import-panel.tsx、use-export-quote-import.ts | C1（成本口径列）+ A/B（行卡结构稳定） | 金标（新端点）+ bulk-import-panel.test.tsx + batch-quote-flow.test.tsx |

> 建议顺序 A → C2（小而独立，先解决「看不到」）→ C1 → B → D；
> A/C2 可并行（互不触碰），C1 与 B 有接口依赖但可先并行开发后接线。

---

## 5. 兼容与风险

| 风险 | 缓解 |
|---|---|
| 表面处理组识别（label vs name） | 规则：`variants.find(v => v.label === '表面处理')`，兜底 name ∈ {coating, surface}；找不到则添加首个选项时创建新组（name=coating, label=表面处理）。写进单测 |
| 旧包装行 `method` 为空 | 显示回落 `method || name`；保存时回填 name=method，一次迁移自然完成 |
| 删产品级利润/税费 UI 后引擎兜底缺失 | spec 字段保留（数据不动），new-product-dialog 继续写默认值；引擎行为零变化 |
| cost_basis 契约变更破坏金标 | 同 PR：pydantic→zod 同步 + golden 全绿 + worker 1577 测试；缺省值行为 = 产品级现状，旧请求逐字节不变 |
| 多产品模板列并集过宽 | 说明页标注列↔产品对应关系；前端可按所选产品清单过滤生成（只含订单涉及产品） |
| 导入落库口径变化（原「只算不落库」） | D-3 用户拍板；导入端点本身仍不落库，落库在工作台保存（既有 quote_orders 链路），审计口径不变 |
| 并发会话工作树污染 | 每批单独提交（私有 GIT_INDEX_FILE 配方），提交前后 `git status` 自证 |
| `.next` 冲突 | e2e 与 build 不同时跑（既有纪律） |

---

## 6. 验收标准（DoD）

- [ ] 产品详情页：HS 编码只出现一次（基本信息）；「价格与利润」「可选档位」区不存在；
      表面处理/材质为 chips 多选项；包装行只有 包装方式/是否默认/金额 三要素。
- [ ] 所有产品（内置 + 自定义）同一结构，无按产品分支的 UI。
- [ ] 报价行卡：产品信息在上、件数居中、金额在下，三类各自换行；折叠摘要同样三行。
- [ ] 报价包装下拉显示具体包装方式（如「编织袋+钢带」），不再是「包装 1」；落库快照含 packaging_method。
- [ ] 成本输入旁「按含税价」开关：勾选后引擎按 incl_tax 还原税前（金标用例：含税 113 / 进项 13% →
      税前 98.31，与现行引擎公式一致）；不勾 = 现状。旧请求（不带 cost_basis）结果逐字节不变。
- [ ] 外部（团队）账号侧边栏可见「税务档案」；名称/面包屑/页面标题三处一致；成员只读、管理员可写不变。
- [ ] 报价整单参数：选税务档案自动填税率（现状回归测试），无重复入口。
- [ ] 批量导入：下载整单模板（产品列 + 并集规格列）→ 上传含 N 个产品的表 → 预览行级校验 →
      「填入工作台」生成 N 个产品行 → 整单保存报价单成功；旧单产品文件仍可导入（兼容）。
- [ ] 门禁全绿：前端 typecheck/lint/test/contracts:check/mocks:check/ui:standards/ui:contrast/e2e；
      worker pytest；orchestrator pytest；金标 harness；静态断言脚本。
- [ ] 文档同步：本方案状态更新、TODO.md 销账、README.md 索引、WORKSTATION_DESIGN.md 相关节。

---

## 7. 明确不做（本批边界）

- 单证（trade-docs）模板对「材质」的排版：只保证快照里有值，模板渲染下一批。
- 定价数据（pricing-data）页结构：新增档位面板与基本信息 chips 同源，不改其交互。
- 旧单产品导入端点下线：保留兼容，待整单导入稳定后另行裁决。
- 产品级 spec 里利润/税费字段的物理删除：仅 UI 收口，数据留作引擎兜底。
