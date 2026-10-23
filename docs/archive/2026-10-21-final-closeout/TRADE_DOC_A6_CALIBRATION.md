# A6 真实单证校准（2026-10-21 · 首批样例）

> 样例来源：用户提供的 3 份真实单据（桌面 PDF，**不入仓**；抽取的纯文本放在 `.tmp/a6-samples/`）：
> - `Commercial Invoice - Buyer - 20261012.pdf`（2 页，LJ-CI-20261012-01）
> - `Proforma Invoice - Buyer - 20260929.pdf`（2 页，LJ-PI-20260929-01）
> - `Sales Contract - Buyer - 20261012.pdf`（5 页，LJ-SC-20261012-01）
>
> 本文件是**校准矩阵与差距清单**；实施项以 `docs/TODO.md` A6 为账本（本文件不覆盖账本状态）。
> 结论先行：**现有模板可产出"结构正确"的单据，但与真实单据相比缺 12 组字段/版式**，其中
> 「双币种 + 汇率 + 舍入调整 + 定金/尾款 + 运费 + 收款账户」属于**对外单据可读性/可执行性**的
> 硬缺口，优先级 P0；合同双语条款属于 P1。

## 1. 真实单据要素（抽取后的人工归纳）

### 1.1 三份单据共有的"双币种结构"
- 每行：`Unit Price (CNY) · Amount (CNY) · Unit Price (USD) · Amount (USD)` 四列；
- 表尾固定 4 行：`Rounding adjustment`（-2.54 / -0.37）、`Total Goods Value`（18,195.66 / 2,714.60）、
  `Inland Freight to Delivery Address`（750.00 / 111.89）、`TOTAL AMOUNT PAYABLE`（18,945.66 / 2,826.49）；
- 汇率行：`1 USD = 6.7029 CNY · Bank of China USD spot buying rate 670.29 per USD 100 (2026-09-28)`；
- 付款拆两段金额：`Deposit (30%)` / `Balance (70%)` 各两币种。
- 大写只对 **USD 总额** 出一份（`SAY US DOLLARS TWO THOUSAND EIGHT HUNDRED TWENTY-SIX AND CENTS FORTY-NINE ONLY`）。

### 1.2 各单据特有要素
| 要素 | PI | CI | Contract |
|---|---|---|---|
| 单据号 | `LJ-PI-…` + 日期 + 有效期（15 天，至 10-14） | `LJ-CI-…` + 日期 | `LJ-SC-…` + 日期 + 签约地（Anping, Hebei, China · 扫描件签署） |
| 上游引用 | `Ref. Quotation No. LJ-Q-20260928-01` | `PI No.` + `PI Date` + `Contract No.` | `Ref. PI` + `Ref. Quote` + 附件（PI、CI） |
| 双方信息 | 买方（John Doe，tel/email）+ 卖方（税号/地址/tel/email） | 卖方头上 + `BILL TO:` 卖方地址/税号 + `CONSIGNED TO:` 买方 | 中英双语双方（卖方中文名+地址+税号；买方姓名/国家/电话/邮箱/收货地址） |
| 交货 | `DAP Yangzhou, Jiangsu, China`；交货地址、运输 4–5 天、总重 2,435 kg / 7.35 CBM | DAP 同 | DAP（Incoterms 2020）+ 交货地址 + 责任终止说明 + 拼柜方（第三方 Jiangsu Juncheng） |
| 付款 | T/T 30%/70%，定金/尾款两币种金额；汇款账户 | T/T 30%/70%；汇款账户 + `Payment Status` | 中英双语付款条款 + 定金/尾款 + 汇款账户 |
| 运费 | 内陆运费 CNY 750.00 / USD 111.89（已含总价） | 同 | 同 |
| 银行 | Beneficiary(名/址/税号)、Account No.、Bank(建行安平支行)、SWIFT `PCBCCNBJHBX` | 同 + Beneficiary Tax ID | 同（表格化） |
| 原产地/单证 | ChAFTA COO（无法出具时普通 CO）；税费卖方承担不计总价；买方提供报关单证协助退税 | 原产地声明段 + 出口零税率说明 | 单据条款（中英）+ 原产地中国 + 退税 |
| 包装/唛头 | 包装细则 + 可选包装加价 + OEM + `N/M` | Shipping Marks: N/M | 包装条款（中英）+ N/M |
| 条款 | 生产进度照片、有效期、价格基础、签名/盖章 | 声明 + 买卖双方签章 | 12 条双语条款（品质/包装/付款/交货/单据/税费/价格基础/检验索赔/不可抗力/仲裁/适用法律/生效附件）+ 双方代表签署（张三 / John Doe）+ 电子签署效力 |
| 第三方 | 拼柜方 Jiangsu Juncheng（原产/制造商） | Country of Origin: Jiangsu Juncheng… | 拼柜方说明 |

## 2. 与当前实现的差距矩阵（按优先级）

| # | 差距 | 现状（代码/模板） | 影响 | 优先级 |
|---|---|---|---|---|
| G1 | **双币种行金额**（CNY + USD 四列） | ✅ 已实施（2026-10-21）：有 `fx_rate` 时渲染四列（无 fx 维持单币种，18 金标不变） | 真实单据核心版式；客户/银行按 USD 付款，缺 USD 列不可用 | **P0** |
| G2 | **汇率行**（汇率+来源日期） | ✅ 已实施（2026-10-21）：`$fx_block` 首行 `Currency / Exchange Rate`（`fx_rate`/`fx_source`/`fx_date`） | 双币种换算依据，审计必需 | **P0** |
| G3 | **舍入调整行** | ✅ 已实施（2026-10-21）：`Rounding adjustment` 行（可显式覆盖，留空按未舍入合计−舍入后合计推导） | 真实单据"行合计 ≠ 未舍入合计"的差必须显式列出，否则对账差几分 | **P0** |
| G4 | **内陆运费行**（含在总价） | ✅ 已实施（2026-10-21）：`Inland Freight to Delivery Address` 行（两币种） | DAP 交付的核心费用项 | **P0** |
| G5 | **定金/尾款金额**（两币种） | ✅ 已实施（2026-10-21）：`Deposit (30%)` / `Balance (70%)` 两币种行（百分比从 payment_terms 解析，可显式覆盖） | 财务执行口径 | **P0** |
| G6 | **Total Amount Payable**（含运费）与 Total Goods Value 分列 | ✅ 已实施（2026-10-21）：`Total Goods Value` / `TOTAL AMOUNT PAYABLE` 两行分列（可显式覆盖） | 与真实单据不一致 | **P0** |
| G7 | **收款账户结构化**（受益人名/址/税号/账号/开户行/SWIFT） | ✅ **已实施（2026-10-21）**：渲染层结构化 key 分行（`beneficiary*`/`account_no`/`bank_address`）；PI 用 `$bank_info`，**CI 补齐 `$ci_bank_block`**（结构化 `bank_info` 才渲染，旧数据不渲染 ⇒ 18 金标不变） | 客户汇款易错；模板无法分行渲染 | **P0** |
| G8 | **上游引用**（报价单号、PI 号、CI 号、合同号交叉引用） | ✅ **已实施（2026-10-21）**：`ref_quote_no`（PI/合同）、`ref_contract_no`（PI）、`ref_pi_no`（CI/合同）、合同 `annex_docs[]` → 内联「Ref. …」/「Annexes: …」，空值不输出 | 单据链可追溯性 | P1 |
| G9 | **双方税号与完整联系方式**（卖方税号/地址/电话/邮箱；买方税号） | ✅ **已实施（2026-10-21）**：`seller`/`buyer`/`notify_party` 的 `tax_id`/`tel` 进地址块（缺 key 输出不变） | 报关/开票必需 | P1 |
| G10 | **BILL TO / CONSIGNED TO 双栏** | ✅ **已实施（2026-10-21）**：`bill_to`/`consigned_to` 对象 → `$ci_parties_block` 两栏；都有值才渲染 | 与真实 CI 版式不同 | P1 |
| G11 | **合同双语条款（12 条）** | ✅ **已实施（2026-10-21）**：合同模板改 `$contract_clauses_block`；`clauses` 数组（含 `[]`）触发默认 12 条中英双语、按 `key` 覆盖/未知追加；**无 `clauses` ⇒ 旧 4 条英文逐字节不变**。措辞待法务/业务确认 | 中英双语合同是用户真实业务形态；双语不一致条款风险 | **P1（大项）** |
| G12 | **有效期 / 包装细则 / 生产照片 / 第三方拼柜方 / 代表签署人** | ✅ **已实施（2026-10-21，仅 PI）**：`packing_details`/`production_photos_note`/`third_party_consolidator`/`signatory` + `valid_until`（**共享字段条件渲染**，见 §2 P1 状态块） | 版式与真实不一致，容易漏 | P2 |

> **A6-1 实施状态（2026-10-21）**：**G1–G6 已落地**；实现位置：`frontend/src/lib/trade-doc/render.ts` 的
> `computeFxBreakdown()` + `assets.json` 的 `$fx_block`（仅 pi/ci 模板新增一个内联占位符 ⇒ 无 fx 时渲染空串，
> **18 份单币种金标逐字节不变**）；金标变体：`sample-data-fx.json` → `__fixtures__/html/sample_{pi,ci}_fx.html`；
> 字段口径见 `docs/TRADE_DOC_TEMPLATES.md` §十一。事实层：`facts.py` 新增 `total_payable`（含运费的应付额，
> money 容差，与 `total_amount` 独立）并沿用既有 `fx_rate` 抽取；跨单不一致 ⇒ conflict。

> **✅ A6 P1 实施状态（2026-10-21，G7–G12 全部落地；代码未 commit 时以工作树为准）**
>
> - **G7–G12 六项全部实施**（矩阵见上）；**G11 数据层已集成**：`frontend/src/lib/trade-doc/contract-clauses.ts`
>   （默认 12 条中英双语 + `custom.clauses` 按 key 覆盖/未知追加，纯数据+纯函数）由
>   `render.ts::renderContractClausesBlock` 调起。
> - **合同双语触发口径（保基线关键）**：payload **没有 `clauses` 字段** ⇒ 输出旧 4 条英文条款
>   （`inspection`/`claims`/`force_majeure`/`arbitration`），与旧版**逐字节一致**；
>   `clauses` **是数组**（含 `[]`）⇒ 启用 12 条双语块并**替代**旧 4 条（`[]` = 全用内置 12 条）。
> - **`valid_until` 共享字段取舍**：它同时是 `quotation` 模板的普通日期字段，基础样例也带它。
>   PI 上**仅当其它 P2 字段任一存在**（`packing_details` / `production_photos_note` /
>   `third_party_consolidator` / `signatory`）才随块显示，避免旧 PI 金标多出一行日期。
> - **金标 20 → 23**：18 份单币种**逐字节不变**；2 份 FX 金标**重生成**（`sample_data_fx` 本就有 `tel` 与
>   结构化 `bank_info`，G7/G9 渲染生效 ⇒ 多出电话行 / CI 银行块，属预期）；新增 3 份变体
>   `sample_pi_a6p1.html` / `sample_ci_a6p1.html` / `sample_contract_bilingual.html`
>   （数据 `sample-data-a6p1.json`，生成器 `__fixtures__/generate-a6p1-fixtures.ts`）。
> - **测试**：`render.test.ts` 新增「A6 剩余 P1」**7 条**（三份变体逐字节 + G7/G8/G9/G10/G11/G12 各 1 条，
>   含"旧数据不渲染/不改变"负向断言）；**前端全量 743 passed / 77 files**
>   （基线 719 ⇒ +24：A5-W3 17 + 本批 7；`--maxWorkers=2` 实测全绿；默认并行轮 `import-template-xlsx` 15s 超时
>   属并发抖动，单跑 7 passed）。
> - **未做 / 待确认（不算完成项）**：
>   1. **合同双币种**：G1 的 fx 金额块只对 PI/CI 生效；合同即便带 `fx_rate` 也**不进双币种**
>      （`render.test.ts` 有负向断言）——真实合同是否需要双币种待业务确认；
>   2. **条款措辞待法务/业务确认**：默认 12 条为「可编辑措辞」（蓝本为真实样例，不含成交信息），
>      正式签署前需逐条抽查；`text_zh`/`text_en` 可覆盖/隐藏；
>   3. G12 的 P2 字段**只在 PI** 落地（CI/合同是否需要同类字段未做，待业务样例）。

## 3. 实施建议（拆两个批次）

### 批次 A6-1（P0，**2026-10-21 已实施**）：双币种金额块
- 新增 payload 字段（`custom` 内，保持向后兼容）：`fx_rate`（如 6.7029）、`fx_source`（如 `Bank of China USD spot buying rate 670.29 per USD 100`）、`fx_date`、
  `rounding_adjustment_cny/usd`、`inland_freight_cny/usd`、`deposit_cny/usd`、`balance_cny/usd`、
  `total_goods_value_cny/usd`、`total_payable_cny/usd`（或由行/汇率推导 + 可覆盖）；
- `render.ts` 行项表支持"本币+外币"双列（有 `fx_rate` 时渲染，否则维持单币种——**不得破坏既有 18 模板/金标**）；
- PI/CI 模板加：汇率行、舍入调整行、运费行、定金/尾款行、Total Goods Value / Total Payable 分列；
- 事实层（A7）：把 `fx_rate`、`total_payable` 纳入 fact 抽取与一致性（跨单必须一致）；
- 测试：渲染金标新增 2 份（PI/CI 双币种变体）、事实抽取/一致性测试；既有 18 金标不变。

### 批次 A6-2（P1）：合同双语条款 + 引用链 —— **✅ 已实施（2026-10-21）**
- 合同 payload `clauses` 结构（`key/label_zh/label_en/text_zh/text_en`），默认 12 条内置中英模板（标注"待法务确认"）；
- 模板整块 `$contract_clauses_block`（中文在上、英文在下；**无 `clauses` 保持旧 4 条逐字节不变**），保留 `custom` 覆盖；
- 引用链：`ref_quote_no` / `ref_contract_no` / `ref_pi_no` / 合同 `annex_docs[]`；
- 双方税号（`tax_id`）/电话（`tel`）/代表签署人（`signatory`）字段；
- 测试：P1 变体 3 份金标 + 7 条渲染测试（含负向"旧数据不变"）。

### A6-3（P2）—— **✅ 已随 P1 提前落地（2026-10-21，仅 PI）**
- `valid_until`（条件渲染）、包装细则 `packing_details`、生产照片说明 `production_photos_note`、
  第三方拼柜方 `third_party_consolidator`、代表签署人 `signatory` 均已在 PI 落地；
- CI 的 `BILL TO / CONSIGNED TO` 双栏（G10）也已落地（属 P1，不比 P2 晚）；
- 未做：把上述 P2 字段推广到 CI/合同（无真实样例，待业务确认是否必要）。

## 4. 业务口径（2026-10-21 用户已确认项 + 仍待确认项）
 
> **用户 2026-10-21 已确认**：**金额一律保留 2 位小数**；汇总按未舍入值计算后四舍五入（差异走「舍入调整」行），**符合常理**即可；单价保留来源精度（真实单据 USD 单价 4 位：3.7297），不改写成 2 位以免与样例/银行实收对不上。A6 实施按此口径（现实现已一致）。
 


> 实现按下列**建议项**落地（2026-10-21），用户仍可改口径；改口径只动
> `render.ts::computeFxBreakdown` 的公式与 `sample-data-fx.json` 金标，不涉及模板结构。

1. **双币种是否所有单证都加**，还是仅 PI/CI/合同？ → **已落地口径（2026-10-21）**：fx 金额块只对 **PI/CI**；
   **合同保持单币种（未做，`render.test.ts` 负向断言钉住；合同是否要双币种待业务确认）**。
2. **USD 金额精度**：真实单据 USD 单价 4 位小数、金额 2 位；是否固定按此口径（建议是）。→ ✅ 用户已确认。
3. **舍入调整**：按"行未舍入合计 − 行舍入后合计"自动计算并展示（建议），还是允许手工填？→ ✅ 用户已确认（自动 + 可显式覆盖）。
4. **合同双语条款**：12 条内置措辞是否需要法务/你逐条确认后上线？ → **已上"中英双语 + 标注可编辑"**；
   **措辞仍待法务/业务逐条抽查**（未做项，不算完成）。
5. **对方公司信息**：真实样例买方是个人（John Doe）＋澳大利亚；"对方公司"字段按"有则显示公司名/税号/地址，无则只显示联系人"处理——确认。→ 实现已按此（`buyer.company/name/tax_id/tel` 有则显示）。

## 5. 现状证据（供复核）

- 模板占位符：`frontend/src/lib/trade-doc/assets.json`（`templates.pi/ci/contract`；A6 P1 新增
  `$ref_*`/`$annex_docs`/`$ci_parties_block`/`$ci_bank_block`/`$contract_clauses_block` 与 PI P2 占位符）；
- 渲染器：`frontend/src/lib/trade-doc/render.ts`（行项表/金额大写/图片白名单；A6 P1：
  `INLINE_NOTE_FIELDS`/`renderAnnexBlock`/`renderContractClausesBlock`/`renderCiBankBlock`/`renderCiPartiesBlock`）；
- 字段声明：`frontend/src/lib/trade-doc/manifest.json`（A6 P1 新增 `ref_*`/`annex_docs`/`clauses`/
  `bill_to`/`consigned_to`/`packing_details`/`production_photos_note`/`third_party_consolidator`/`signatory`/
  `valid_until` 及 3 个派生占位符）；
- 合同条款数据：`frontend/src/lib/trade-doc/contract-clauses.ts`（默认 12 条 + 覆盖/追加，纯函数）；
- 金标：`frontend/src/lib/trade-doc/__fixtures__/html/` 共 **23 份**（18 旧不变 + 2 FX 更新 + 3 P1 变体）；
- 事实层：`backend/kaas_common/trade_doc/facts.py`（A6-1 已含 `fx_rate` / `total_payable`；
  A6 P1 未新增事实键 —— P1 字段属版式/引用，不参与跨单一致性）。
