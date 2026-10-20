# A6 真实单证校准（2026-10-21 · 首批样例）

> 样例来源：用户提供的 3 份真实单据（桌面 PDF，**不入仓**；抽取的纯文本放在 `.tmp/a6-samples/`）：
> - `Commercial Invoice - Tim - 20261012.pdf`（2 页，LJ-CI-20261012-01）
> - `Proforma Invoice - Tim - 20260929.pdf`（2 页，LJ-PI-20260929-01）
> - `Sales Contract - Tim - 20261012.pdf`（5 页，LJ-SC-20261012-01）
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
| 双方信息 | 买方（Tim Lyons，tel/email）+ 卖方（税号/地址/tel/email） | 卖方头上 + `BILL TO:` 卖方地址/税号 + `CONSIGNED TO:` 买方 | 中英双语双方（卖方中文名+地址+税号；买方姓名/国家/电话/邮箱/收货地址） |
| 交货 | `DAP Yangzhou, Jiangsu, China`；交货地址、运输 4–5 天、总重 2,435 kg / 7.35 CBM | DAP 同 | DAP（Incoterms 2020）+ 交货地址 + 责任终止说明 + 拼柜方（第三方 Jiangsu Juncheng） |
| 付款 | T/T 30%/70%，定金/尾款两币种金额；汇款账户 | T/T 30%/70%；汇款账户 + `Payment Status` | 中英双语付款条款 + 定金/尾款 + 汇款账户 |
| 运费 | 内陆运费 CNY 750.00 / USD 111.89（已含总价） | 同 | 同 |
| 银行 | Beneficiary(名/址/税号)、Account No.、Bank(建行安平支行)、SWIFT `PCBCCNBJHBX` | 同 + Beneficiary Tax ID | 同（表格化） |
| 原产地/单证 | ChAFTA COO（无法出具时普通 CO）；税费卖方承担不计总价；买方提供报关单证协助退税 | 原产地声明段 + 出口零税率说明 | 单据条款（中英）+ 原产地中国 + 退税 |
| 包装/唛头 | 包装细则 + 可选包装加价 + OEM + `N/M` | Shipping Marks: N/M | 包装条款（中英）+ N/M |
| 条款 | 生产进度照片、有效期、价格基础、签名/盖章 | 声明 + 买卖双方签章 | 12 条双语条款（品质/包装/付款/交货/单据/税费/价格基础/检验索赔/不可抗力/仲裁/适用法律/生效附件）+ 双方代表签署（孙嘉泽 / Tim Lyons）+ 电子签署效力 |
| 第三方 | 拼柜方 Jiangsu Juncheng（原产/制造商） | Country of Origin: Jiangsu Juncheng… | 拼柜方说明 |

## 2. 与当前实现的差距矩阵（按优先级）

| # | 差距 | 现状（代码/模板） | 影响 | 优先级 |
|---|---|---|---|---|
| G1 | **双币种行金额**（CNY + USD 四列） | `items` 渲染单币种列（`render.ts` item table） | 真实单据核心版式；客户/银行按 USD 付款，缺 USD 列不可用 | **P0** |
| G2 | **汇率行**（汇率+来源日期） | 无字段/无渲染 | 双币种换算依据，审计必需 | **P0** |
| G3 | **舍入调整行** | 无 | 真实单据"行合计 ≠ 未舍入合计"的差必须显式列出，否则对账差几分 | **P0** |
| G4 | **内陆运费行**（含在总价） | 无独立行 | DAP 交付的核心费用项 | **P0** |
| G5 | **定金/尾款金额**（两币种） | 仅 `payment_terms` 文本 | 财务执行口径 | **P0** |
| G6 | **Total Amount Payable**（含运费）与 Total Goods Value 分列 | 仅 `total_amount` 单一合计 | 与真实单据不一致 | **P0** |
| G7 | **收款账户结构化**（受益人名/址/税号/账号/开户行/SWIFT） | `bank_info` 自由文本 | 客户汇款易错；模板无法分行渲染 | **P0** |
| G8 | **上游引用**（报价单号、PI 号、CI 号、合同号交叉引用） | PI 无 quote/contract；CI 有 contract_no/lc_no；合同只 ref PI | 单据链可追溯性 | P1 |
| G9 | **双方税号与完整联系方式**（卖方税号/地址/电话/邮箱；买方税号） | `seller`/`buyer` 对象由 sources 渲染，税号字段未纳入 | 报关/开票必需 | P1 |
| G10 | **BILL TO / CONSIGNED TO 双栏** | CI 只有 Consignee/Notify | 与真实 CI 版式不同 | P1 |
| G11 | **合同双语条款（12 条）** | 仅 4 条英文（inspection/claims/force_majeure/arbitration），无中文 | 中英双语合同是用户真实业务形态；双语不一致条款风险 | **P1（大项）** |
| G12 | **有效期 / 包装细则 / 生产照片 / 第三方拼柜方 / 代表签署人** | 部分只能塞 `remarks` 自由文本 | 版式与真实不一致，容易漏 | P2 |

## 3. 实施建议（拆两个批次）

### 批次 A6-1（P0，先做）：双币种金额块
- 新增 payload 字段（`custom` 内，保持向后兼容）：`fx_rate`（如 6.7029）、`fx_source`（如 `Bank of China USD spot buying rate 670.29 per USD 100`）、`fx_date`、
  `rounding_adjustment_cny/usd`、`inland_freight_cny/usd`、`deposit_cny/usd`、`balance_cny/usd`、
  `total_goods_value_cny/usd`、`total_payable_cny/usd`（或由行/汇率推导 + 可覆盖）；
- `render.ts` 行项表支持"本币+外币"双列（有 `fx_rate` 时渲染，否则维持单币种——**不得破坏既有 18 模板/金标**）；
- PI/CI 模板加：汇率行、舍入调整行、运费行、定金/尾款行、Total Goods Value / Total Payable 分列；
- 事实层（A7）：把 `fx_rate`、`total_payable` 纳入 fact 抽取与一致性（跨单必须一致）；
- 测试：渲染金标新增 2 份（PI/CI 双币种变体）、事实抽取/一致性测试；既有 18 金标不变。

### 批次 A6-2（P1）：合同双语条款 + 引用链
- 合同 payload 新增 `clauses` 结构（`key/label_zh/label_en/text_zh/text_en`），默认 12 条内置中英模板（条款措辞以真实样例为蓝本，标注"待法务确认"）；
- 模板渲染双语两栏/两段；保留 `custom` 覆盖；
- 引用链：`ref_quote_no`、`ref_pi_no`、`annex_docs[]`；
- 双方税号/代表签署人字段；
- 测试：条款渲染 + 引用链 + 金标合同变体。

### A6-3（P2，可与 A5 合并）
- 有效期、包装细则、生产照片说明、第三方拼柜方、BILL TO/CONSIGNED TO 双栏——按真实样例优先补 PI/CI。

## 4. 待用户确认（业务口径）

1. **双币种是否所有单证都加**，还是仅 PI/CI/合同？（建议这三个，其他 15 类保持单币种）
2. **USD 金额精度**：真实单据 USD 单价 4 位小数、金额 2 位；是否固定按此口径（建议是）。
3. **舍入调整**：按"行未舍入合计 − 行舍入后合计"自动计算并展示（建议），还是允许手工填？
4. **合同双语条款**：12 条内置措辞是否需要法务/你逐条确认后上线？（建议先上"中英双语 + 标注可编辑"，上线前你抽查一遍）
5. **对方公司信息**：真实样例买方是个人（Tim Lyons）＋澳大利亚；"对方公司"字段按"有则显示公司名/税号/地址，无则只显示联系人"处理——确认。

## 5. 现状证据（供复核）

- 现有模板占位符：`frontend/src/lib/trade-doc/assets.json`（`templates.pi/ci/contract`）；
- 渲染器：`frontend/src/lib/trade-doc/render.ts`（行项表/金额大写/图片白名单）；
- 字段声明：`frontend/src/lib/trade-doc/manifest.json`；
- 事实层白名单：`backend/kaas_common/trade_doc/facts.py`（当前不含 fx/total_payable 等，需批次 A6-1 扩展）。
