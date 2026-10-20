# 外贸单证模板规范（单证工位）

> **现行实现（S4 后：前端渲染，Worker 不带模板引擎）**：
> - 模板 + 共享样式：`frontend/src/lib/trade-doc/assets.json`（`templates` / `sharedStyle`）
> - 字段清单（含必填/类型/描述）：`frontend/src/lib/trade-doc/manifest.json`
> - 渲染器：`frontend/src/lib/trade-doc/render.ts`（`$var` 占位、缺失渲染空串、值一律转义）
> - 接口：`GET /api/v1/trade-doc-templates[/{doc_type}]`、`GET /api/v1/trade-docs/{id}/render-data`
> - 基准产出：`frontend/src/lib/trade-doc/__fixtures__/html/*.html`（18 份，`__tests__/render.test.ts` 逐字节守护）
>
> 历史：归档 Python 渲染器/模板在根 `archive/2026-09-trade-doc-xprime-python/`（只读留档，**非当前口径**）。

---

## 一、语言规范：为什么以英文为主

| 场景 | 语言选择 | 原因 |
|---|---|---|
| 商业发票、装箱单、报价单、形式发票、销售合同 | **英文** | 境外客户、银行、海关均按英文审单；信用证项下单据不一致即构成不符点 |
| 提单、原产地证、保险单 | **英文** | 由第三方机构签发，格式与语种由其规定 |
| 国内报关、出口退税、贸促会签证 | 中文（另行提供） | 国内监管环节需要中文名称，建议在业务数据中同时维护中英文两套公司名 |

模板现已全部按**英文单证**排版：单据名称、字段标签、表头、声明条款均为英文，
卖方（中国出口商）的抬头同样使用英文名称与英文地址，避免境外方无法辨识。

> 若某票业务确需中英对照，只需在 `raw_payload.custom` 中把对应字段值填成
> `中文 / English` 形式即可，模板结构无需改动。

---

## 二、单证清单与「谁有权出具」（合规边界）

⚠️ **这是最容易出错的地方**：并非所有单证都由出口商出具。做错会构成单据造假。

### A. 出口商自制（正式件，可直接对外使用）

| 类型 | 单据名 | 用途 |
|---|---|---|
| `quotation` | Quotation 报价单 | 对外报价 |
| `pi` | Proforma Invoice 形式发票 | 客户确认订单、申请进口许可、开立信用证 |
| `contract` | Sales Contract 销售合同 | 正式合同（买卖双方双签） |
| `ci` | Commercial Invoice 商业发票 | 报关、清关、付汇、信用证议付 |
| `pl` | Packing List 装箱单 | 报关、清关、收货核对 |
| `shipping_advice` | Shipping Advice 装运通知 | 装运后通知买方（信用证常要求限期内发出） |
| `draft` | Bill of Exchange 汇票 | 信用证议付 / 托收的核心金融票据 |
| `beneficiary_cert` | Beneficiary's Certificate 受益人证明 | 信用证项下自我声明（已按要求寄单等） |
| `non_wood_packing` | Non-Wood Packing Declaration 非木质包装声明 | 声明未用实木包装（ISPM 15），可免于熏蒸 |
| `weight_list` | Weight List 重量单 | 逐项列明毛重与净重 |
| `quality_cert` | Certificate of Quality 质量证明 | 证明质量符合约定标准 |
| `manufacturer_cert` | Manufacturer's Certificate 制造商证明 | 转口贸易、反倾销、原产国核查 |

### B. 第三方签发（本系统只产出「申报 / 申请信息」，正式件由对方出具）

| 类型 | 单据名 | 签发方 | 本系统产出的性质 |
|---|---|---|---|
| `bl` | Bill of Lading 提单 | 承运人 / 船公司 | ❗托运单 / 提单确认件（Draft），标注 *To Be Issued by the Carrier* |
| `co` | Certificate of Origin 原产地证 | 贸促会（CCPIT）/ 海关 | ❗申报信息表，正式证书按法定格式（FORM A / CO / FORM E 等）出具 |
| `insurance` | Insurance Policy 保险单 | 保险公司 | ❗投保信息 |
| `customs_declaration` | Customs Declaration 报关单 | 报关行 / 海关 | ❗申报要素汇总表 |
| `fumigation_cert` | Fumigation Certificate 熏蒸证书 | 熏蒸服务单位 | ❗熏蒸申请信息 |

### C. 通用

| 类型 | 单据名 | 说明 |
|---|---|---|
| `other` | 通用单证 | 出口商声明、船公司证明等；`content` 字段支持原始 HTML |

**B 类单据模板底部均带声明条款说明签发方**，签章栏也按真实签发方设置
（承运人 / 签证机构 / 保险公司 / 报关行 / 熏蒸单位），不会误导使用者把它当成已生效的正式凭证。

---

## 三、版面规范（印刷级 A4）

- 页面：A4，`@page` 四边留白 13mm；屏幕预览模拟纸张，打印自动铺满。
- 结构：**卖方抬头 → 单据名称 → 元信息 → 收发货人 → 货物明细 → 金额大写 → 声明条款 → 签章 → 页脚**。
- 配色：主色 `#0f2740`（藏青），用于表头、强调线；正文近黑 `#101820`；分隔线 `#ccd4dc`。
- 字体：`Arial / Helvetica`（英文单证通用），中文兜底 `Microsoft YaHei`。
- 打印提示：浏览器 `Ctrl+P` 选择 A4，**勾选"背景图形"** 才能打印出深色表头。

### 关键合规要件（已内置）

| 要件 | 说明 |
|---|---|
| **金额英文大写** | 自动生成，如 `SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY`；报关与信用证审单必需 |
| **固定列序** | 每类单证的表格列由类型固定，不随传入数据漂移（商业发票不会冒出毛净重列） |
| **HS Code** | 商业发票、原产地证含 HS 编码列；装箱单含件数与毛净重、体积列 |
| **TOTAL 行** | 表内自动生成数量/件数/金额合计 |
| **原产国** | 商业发票、装箱单、产地证含 Country of Origin |
| **声明条款** | 各类单据带对应声明（真实性、原产地、签发方） |

---

## 四、数据来源与字段

渲染数据来自 `trade_docs.raw_payload`：

```
raw_payload = {
  "sources": { "order": {...}, "quote": {...}, "inquiry": {...} },  # 上游快照（冻结）
  "custom":  { ... }                                                # 手工补充 / AI 填充
}
```

- **`custom` 优先，上游快照兜底**（见 `trade_doc_render.py::_build_render_data`）。
- 可用字段与类型：`GET /api/v1/trade-doc-templates/{doc_type}`。
- 渲染器自动派生（无需调用方计算）：
  - `total_amount_words` / `insured_amount_words`：金额英文大写
  - `total_qty` / `total_packages` / `total_gross_weight` / `total_net_weight` / `total_volume`：行项自动汇总
  - `seller_name`：卖方名称（签章区提示语）
  - 日期统一格式化为 `26-Sep-2026`
  - `remarks` / `notes`：**换行保留**（先按业务值转义、再把 `\n` 换成 `<br>`）——
    备注本来就该逐点换行（`1) … 2) … 3) …`），HTML 默认会把换行折叠成空格、
    四条挤成一段，客户与银行逐条对照极难读。其余字段的换行仍按 HTML 折叠。
- 缺失字段渲染为空串，**不会残留 `$placeholder`**；所有值经 HTML 转义防注入
  （仅 `other` 单证的 `content` 按原始 HTML 透传）。

---

## 五、使用方式

> ⚠️ 下面这条是**归档 Python 渲染器时代**的样例命令（现只在根 `archive/2026-09-trade-doc-xprime-python/`
> 留档；`backend/orchestrator` 现在只剩迁移/ORM，跑不了它）。现行前端渲染与离线出单见本节下方「离线渲染」。

```powershell
# 【历史，勿再执行】归档时代的 9 类英文样例（原件在 archive/2026-09-trade-doc-xprime-python/）
```

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/trade-doc-templates` | 模板清单 |
| GET | `/api/v1/trade-doc-templates/{doc_type}` | 单类字段定义（供前端动态表单 / AI 填充） |
| GET | `/api/v1/trade-docs/{id}/render-data` | 装配渲染一份单据所需的全部数据（前端据此排版/预览/打印为 PDF） |

> **`render-data` 的 `company_stamp` 会自动带出公司默认公章**（2026-10-11 晚）：
> 单据 `raw_payload.custom` **显式给过**该键（**含空串**）⇒ 以它为准，不覆盖、不查库；
> 没给 ⇒ 取租户默认章（`tenant_company_seals.is_default`）转 `data:` URI 填入；
> **无默认章 / 空字节 / None ⇒ 不注入**（不伪造空图）。判定在共享内核
> `backend/kaas_common/files/seal.py`（`apply_default_seal`），两端**同一份**（G1）。
> 上传入口在企业主体信息页 `settings/company-profile`（`CompanySealCard`，前端 Canvas 归一化为 PNG）。

### 界面入口：填写单据内容（2026-10-11 新增）

单证工位详情页新增「**填写单据内容**」面板（`components/doc-custom-form.tsx`）：

- 字段清单来自模板 manifest（`getTemplateFields`），**不在界面里硬编码第二份** ——
  以后给某类单证加字段，面板自动出现。
- 控件按字段类型生成：标量→输入框、`date`→日期、`boolean`→是/否、
  `object/array/image_list`→JSON 文本域、`image`→**选文件转 data URI**。
  类型未知时退回文本，不静默丢字段。
- 保存走 `PATCH /api/v1/trade-docs/{id}` 的 `raw_payload.custom`。
  **只填要覆盖或补充的项**：后端装配顺序是"上游快照 → 企业主体 → 默认条款 → custom"，
  custom 最后覆盖，留空即用上游数据。
- ⚠️ `raw_payload` 是**整块替换**，提交时必须带上 `sources`（`buildPayloadPatch`），
  否则会把上游订单/报价快照抹掉、单据再也回不到上游。
- 仅 `draft` 可改；签发后服务端返回 `PAYLOAD_LOCKED`，界面也会先说明。

### 离线渲染（命令行，2026-10-11 新增）

生产是「前端渲染」架构（Worker 不带模板引擎），所以离线/批量出单原本没有入口。
现在有通用 CLI（复用**同一个**渲染器，与界面输出一致）：

```powershell
# 仓库根目录；payload 与 render-data 的 data 同形
node <node> frontend/node_modules/tsx/dist/cli.mjs scripts/render-trade-doc.ts `
     --type pi --data artifacts/pi-payload.json --out artifacts/pi.html --assets-dir artifacts
```

- `company_stamp` / `product_photos[].image` 可写**本地文件路径**，CLI 按扩展名转
  `data:` URI 内联（渲染器只收 `data:` 与 `http(s)`，那是防注入白名单，不放开）。
- 输出自包含 HTML，可直接用浏览器打印为 A4 PDF。
  ⚠️ **别用 ego 浏览器打印**（会把光标/浮标一起印进去，且每页重复），
  用系统 Chrome：`chrome --headless=new --no-pdf-header-footer --print-to-pdf=<out> <file:///…html>`。

---

## 六、扩展新单证

1. 在 `frontend/src/lib/trade-doc/manifest.json` 增加一条定义（`name_zh` / `name_en` / `description` / `template_file` / `fields`），
   并在 `description` 中写清**由谁出具**。
2. 在 `frontend/src/lib/trade-doc/assets.json` 的 `templates` 里加该类型 HTML（`<style>` 内写
   `/*__SHARED_STYLE__*/` 占位即可复用共享样式）。
3. 若表格列需固定，在 `frontend/src/lib/trade-doc/render.ts` 的 `ITEM_COLUMNS` 增加该类型的列定义
   （格式：`[字段 key, 英文表头, 对齐]`）。
4. 补测试与基准：`__tests__/render.test.ts`（golden HTML 逐字节）、`__tests__/render-placeholders.test.ts`，
   并在 `frontend/src/lib/trade-doc/__fixtures__/html/` 落一份 `sample_<type>.html`；
   `pnpm -C frontend trade-doc:check` 必须 0 ERROR。

**已验证的约束**：凡模板使用 `$items` 的，必须同时在 `render.ts` 的 `ITEM_COLUMNS` 定义固定列
（由 `__tests__/render.test.ts:353`「凡使用 $items 的模板都必须定义固定列」自动化卡住；
归档 Python 时代同名测试 `test_every_template_using_items_defines_fixed_columns` 已不适用）。

**待扩展的常见单证**：见下方 §6.1（A10 清单，含字段/数据来源/优先级/A6 依赖）。

### 6.1 待扩展模板清单（TODO A10，2026-10-21 盘点）

> **口径**：本节只列「下一批候选模板」的实现要素，**不包含任何已实现的业务规则**。
> 字段名按现有 18 类模板的 `$placeholder` 风格与 `manifest.json` 字段命名习惯整理；
> **所有字段/触发条件的最终口径一律以 A6（真实单据逐字段校准）为准** —— 本节每类均标注「待 A6 样例校准」。
> 数据来源统一为四层：①`raw_payload.custom`（手填/AI 填充，渲染优先）②`sources.order/quote/inquiry` 上游快照
> ③A7 事实层 `facts`（已确认的 `doc_no/date/incoterm/payment_terms/currency/ports/country_of_origin` 等，
> 见 `docs/TRADE_DOC_HARDENING.md`）④租户档案（企业抬头/地址/银行/默认公章，`render-data` 注入）。
> 合规边界沿用 §二：**第三方签发的只产「申报/申请信息」，不伪装成正式证书**。

#### 6.1.1 `saso_coc` — 目的国符合性认证（SASO / COC / SONCAP / PVoC / GOEIC 类）

- **①用途与触发**：沙特（SASO/SABER）、海湾 GCC、尼日利亚 SONCAP、肯尼亚 PVoC、埃及 GOEIC 等
  **装运前符合性认证**；进口清关强制件。**触发**：目的国属上述市场且客户/信用证要求 COC 时，随商业发票一并出具申请信息。
- **②关键字段**：`cert_no` / `cert_date` / `applicant` / `exporter` / `consignee` / `invoice_no` /
  `contract_no` / `description_of_goods` / `hs_code` / `items` / `quantity` / `country_of_origin` /
  `destination_country` / `standard_applied` / `test_report_no` / `issue_date` / `valid_until` / `content`（声明条款）
- **③数据来源**：`payload.custom`（证书号/认证机构/标准/报告号，通常线下取得）＋`sources`（发票/合同/货物/数量）
  ＋`facts`（已确认的贸易术语/币种/港口/原产国）；签发方=认证机构（**B 类性质**）。
- **④优先级：P1**（与 `beneficiary_decl` 同批先做）。理由：中东/非洲市场清关强制、询单高频；
  字段与现有 `ci` + `co` 重合度高（`items`/`hs_code`/`country_of_origin` 可复用固定列），模板成本低。
- **⑤与 A6**：证书编号规则、认证机构抬头、标准/法规清单、声明措辞**全部待 A6 真实样例校准**；
  未校准前不要预置默认措辞（避免印出与真实证书不符的合规声明）。

#### 6.1.2 `vessel_cert` — 船公司证明（Certificate of Vessel's Ownership / Classification）

- **①用途与触发**：信用证及部分中东/非洲国家进口要求证明**船籍/船龄/船级社/承运人资质**（如抵制条款相关证明）。
  **触发**：信用证 46A 单据条款点名该类证明，或目的国清关要求时，向承运人/船代索取。
- **②关键字段**：`cert_no` / `cert_date` / `vessel` / `voyage_no` / `imo_no` / `flag` / `owner` / `operator` /
  `classification_society` / `vessel_age` / `issue_by`（承运人/船代）/ `content`（声明正文）
- **③数据来源**：`payload.custom`（船名/航次/IMO/船籍/船级社/船龄，业务或货代提供）＋
  `sources.order` 的 `vessel` 与 `bl` 号＋`facts`（若 `vessel` 已登记）；签发方=承运人（**B 类性质**）。
- **④优先级：P2**。理由：模板结构短、实现快；但信息依赖货代/船司，且不同船司格式差异大，需先攒真实件。
- **⑤与 A6**：船公司抬头、声明版本、船级社名称写法**待 A6 校准**。

#### 6.1.3 `export_license` — 出口许可证（申报信息表）

- **①用途与触发**：中国对两用物项/部分金属制品/农产品等管制商品出口需商务部门许可证；报关必备。
  **触发**：品类命中出口管制目录（系统**不判断**是否命中，由业务/报关代理确认）。
- **②关键字段**：`license_no` / `license_date` / `applicant` / `exporter` / `consignee` / `contract_no` /
  `invoice_no` / `description_of_goods` / `hs_code` / `items` / `quantity` / `unit` / `total_amount` /
  `currency` / `destination_country` / `trade_mode` / `valid_until` / `issuing_authority`
- **③数据来源**：`payload.custom`（许可证号/发证机关/有效期，企业或代理线下取得）＋`sources`（合同/发票/货值/数量）
  ＋`facts`（金额/数量派生）；签发方=商务部门（**B 类性质**）。
- **④优先级：P3**。理由：仅少数受管制品类需要；且许可证号通常线下办理，系统只能汇总申报要素。
- **⑤与 A6**：证面栏目、商品编码填报规则**待 A6 样例校准**。

#### 6.1.4 `ciq` — 商检证书（CIQ / Inspection Certificate）

- **①用途与触发**：法检商品出口由海关/检验机构出具品质/数量/重量/卫生证书；信用证常点名。
  **触发**：品类属法检或信用证要求 Inspection Certificate 时，产「报检/申请信息」。
- **②关键字段**：`cert_no` / `cert_date` / `applicant` / `consignee` / `invoice_no` / `contract_no` /
  `description_of_goods` / `hs_code` / `items` / `quantity` / `packages` / `gross_weight` / `net_weight` /
  `inspection_type` / `standard_applied` / `inspection_result` / `place_of_inspection` / `issue_date` / `issuing_authority`
- **③数据来源**：`payload.custom`（检验类型/依据/结论/机构）＋`sources`（行项/件数/毛净重）＋`facts`；
  签发方=检验机构（**B 类性质**）。
- **④优先级：P3**。理由：与现有 `quality_cert` 高度重叠——**过渡方案**：先用 `quality_cert` + `custom` 字段承载，
  待 A6 拿到真实 CIQ 后再决定是否单列模板。
- **⑤与 A6**：检验机构抬头、检验依据、结论措辞**待 A6 校准**。

#### 6.1.5 `beneficiary_decl` — 受益人声明（Beneficiary's Declaration）

- **①用途与触发**：信用证项下常见声明（已发货/已寄单/货物非某产地/未使用童工/符合原产地要求等）。
  **触发**：信用证 46A 要求 "Beneficiary's Declaration" 时；与现有 `beneficiary_cert` 是**不同单据**
  （后者是"已按要求寄单"的自我证明，前者按信用证逐条声明），不能互相顶替。
- **②关键字段**：`declaration_no` / `declaration_date` / `seller` / `buyer` / `invoice_no` / `lc_no` /
  `bl_no` / `contract_no` / `description_of_goods` / `declaration_type`（shipment / eligibility / no-child-labour …）/
  `content`（声明正文，**必填**）/ `place_of_issue` / `company_stamp`
- **③数据来源**：`payload.custom`（声明类型与正文，业务或 AI 起草后人工确认）＋`sources`（发票/合同/提单号）
  ＋`facts`（可引用已确认事实）＋租户档案（抬头/公章直链）；**A 类性质**（出口商自制 + 签章）。
- **④优先级：P1**（与 `saso_coc` 同批先做）。理由：与现有 `beneficiary_cert` 结构几乎同构（差异在标题与正文），
  可复用签章区/`content` 透传（与 `other` 同机制）；信用证业务高频、实现成本最低。
- **⑤与 A6**：信用证声明措辞差异极大（不同银行/国家条款），`declaration_type` 词表与正文模板**待 A6 用真实信用证/声明校准**。

#### 6.1.6 实施顺序与共同成本

| 顺序 | 模板 | 理由 |
|---|---|---|
| 1 | `beneficiary_decl` | 与 `beneficiary_cert` 同构、成本最低；信用证高频 |
| 2 | `saso_coc` | 中东/非洲清关强制；`items`/HS/原产国可复用 `ci`/`co` 固定列 |
| 3 | `vessel_cert` | 结构短，但依赖货代信息与真实船司格式（等 A6 样例） |
| 4 | `export_license` | 仅受管制品类；许可证号线下取得 |
| 5 | `ciq` | 先用 `quality_cert` + `custom` 过渡，见真实 CIQ 再决定 |

共同成本（每类）：`manifest.json` 加定义与 `fields`（名称/必填/类型/描述）→ `assets.json.templates`
加 HTML（保留 `/*__SHARED_STYLE__*/`）→ 若使用 `$items` 必须在 `render.ts` 的 `ITEM_COLUMNS` 定义固定列
（与 §六 现有约束一致）→ 补 `__tests__/render.test.ts`（含 golden HTML）与 `render-placeholders.test.ts`
（模板用了但 manifest 没声明的字段会被 `trade-doc:check` 抓出）→ 用 A6 真实样例逐字段核对后再生效。

> ⚠️ **A6 是硬前置**：上表任何一类在拿到**真实单据样例**并由业务确认字段/措辞前，**不投产**；
> 尤其 `saso_coc` / `ciq` / `vessel_cert` 属第三方签发，措辞错误会被视为单据不符点/造假风险。

---

## 七、图片字段：公章与产品照片（2026-10-11 新增）

> 背景：PI 是给客户拿去**申请进口许可 / 开信用证**的，客户普遍要求
> 「盖章件 + 货物照片」。模板原先只有一行文字提示
> `Authorised Signature & Company Stamp`，没有图片位 —— 业务只能另做一份
> Word 贴图，单据与实际货物对不上号的风险就出在这里。

| 字段 | 类型 | 渲染位置 | 取值 |
|---|---|---|---|
| `company_stamp` | `image` | PI 签章区（`.sign-box` 内、签字线上方） | `data:image/png;base64,...` 或 `https://...` |
| `product_photos` | `image_list` | PI「金额大写」之后、「收款银行 / 备注」之前 | `[{ "image": …, "caption": … }]` |
| `buyer_confirmation` | `boolean` | PI 签章区左格（买方回签栏），**默认不印** | `true`（用 `buyer.company`）或自定义抬头字符串 |

### 渲染规则（为什么这样实现）

| 规则 | 理由 |
|---|---|
| 值由**渲染器**生成 `<img>`，不是让调用方传原始 HTML | `RAW_HTML_FIELDS` 只有 `other` 的 `content`。单据要发给境外客户与银行，「业务值一律转义」这条口径不能为图片破例 —— 破例就是 XSS 后门。`src` / `alt` / 说明文字都由渲染器转义后拼装 |
| 图片源**白名单**：`data:image/*;base64,<base64>` 或 `http(s)` 绝对地址 | 其余（`javascript:`、相对路径、空值、非字符串）一律丢弃，绝不写进 `<img src>` |
| 没有有效图片 ⇒ **整段不输出**（不是空容器） | 「不带图」的 PI 输出与新增本能力之前**逐字节一致** ⇒ 18 份迁移基线不用重生成，`scripts/verify-trade-doc-fixtures.py` 的「TS == 归档 Python」证明继续成立 |
| 两列网格，单数张补一个空格子；`page-break-inside: avoid` | 版面稳定（审单要求），照片也不会被分页拦腰截断 |
| 图片样式**内联在图片段落里**，没写进 `_shared.css` | 共享样式一改，18 份基线的 `<style>` 全部变化 ⇒ 全线报差异。为两个类名付这个代价不值得 |

### 签章区：买方回签栏默认不印，但两侧必须等高

- **法律 / 银行口径**：PI 是**卖方单方出具**的要约/预告单据（客户拿它去申请进口许可、
  开信用证、付定金），信用证审单只看 PI 内容与**卖方**签章 —— 买方不签也成立。
  因此 `buyer_confirmation` **默认不印**，由数据显式打开。
- **商业口径**：留一栏回签，PI 就同时充当「订单确认书」，客户事后改规格/价格没有依据。
  模板签章区本来就是 50%/50% 两格、**左格一直是空的** —— 回签栏是把这个空位给出名目。
- **等高要求**：两个模块结构必须一一对应 ——「图章位 + 分隔线 + 标题 + 说明行」，
  且图章位共用高度常量 `STAMP_SLOT_MM`（18mm）。卖方放了公章时，买方侧留出同高的
  **空图章位**（供客户盖章/签字）；卖方没放章则两侧都不留。这样左右两个签章框的
  高度与上下沿必然对齐（实测：两个 `.sign-box` 同为 113px、`top` 同为 1327px）。
  买方日期并入说明行（`Accepted by … · Date: ______`），不让买方模块多出一行。

### 用法

值放进单证的 `raw_payload.custom`（与其它字段同一入口），渲染 / 预览 / 打印链路都不用改：

```json
{
  "custom": {
    "company_stamp": "data:image/png;base64,iVBORw0KGgo...",
    "product_photos": [
      { "image": "data:image/jpeg;base64,/9j/4AAQ...", "caption": "Item 1 — Chain Link Fence" }
    ],
    "buyer_confirmation": true
  }
}
```

其它单证要带图：渲染器按**字段名**识别（不挑单证类型），在对应模板里加
`$company_stamp` / `$product_photos` 占位符即可。本期只改了 **PI** 模板 ——
改动面越小，18 份基线的可比性越好。

> 回签栏同理：模板里已有 `$buyer_confirmation` 的位置（PI 左签章格），
> 其它单证要加，把占位符放到对应模板的签章区即可。

### 还未做（本次范围外）

- ✅ **填写入口已落地**（2026-10-11）：单证详情页的「填写单据内容」面板里，
  `image` 字段就是**选文件 → 转 data URI**，不必再手工拼字符串。
- 仍未做：图片走**对象存储**（现在是内联进 `raw_payload.custom`，一张 PI 约 1.4MB base64）；
  以及独立的「公章/产品图素材库」。
- 两个字段都**不是必填**（不带图也是合法单据，`compliance.ts` 不会因此拦住签发）。

---

## 八、占位符一致性门禁（2026-10-11 新增）

渲染器的口径是「**缺失字段渲染为空串**」：好处是单据上不会印出 `$remarks`，
**代价是占位符拼错、或模板用了但 manifest 没声明都不会报错 —— 只是那一格静静空白**。
这类问题肉眼看模板查不出来，所以配了一台仪器：

```powershell
pnpm -C frontend trade-doc:check        # exit 0 = 无问题；1 = 有「模板用了但界面填不到」的字段
# 等价于：tsx ../scripts/check-trade-doc-placeholders.ts
#   --json                     机器可读
#   --fix                      打印修复方案（不改盘）
#   --fix --write              外科式写入 manifest.json（不重排 JSON）
#   --fix --dump <path>        把候选文本写到别处供人工核对
```

**首轮运行就抓出 9 类单证、18 个字段**（例：PI 的 `remarks` / `shipping_marks` /
`country_of_origin` 从未声明 ⇒「填写单据内容」面板**列不出唛头与备注**）。
现已补齐 18 个字段，检查为 **0 ERROR**。

**运行时体检（2026-10-20 新增，TODO A3）**：CI 门禁只在提交时跑，用户编辑时仍可能遇到
「模板引用了、但这一版没值」的空格。渲染器新增纯函数 `findBlankPlaceholders(docType, data)`
（`frontend/src/lib/trade-doc/render.ts`），把会留空的地方分成三类：
`undeclared`（模板用了但 manifest 没登记 —— 拼写错误/模板漏登记，属于要改代码的问题）、
`blankRequired`（必填但为空，签发门禁会拦）、`blankOptional`（可选字段留空，填不填由业务判断）。
单证预览页据此在状态栏显示「模板字段未登记 N 项 / 可选字段留空 M 项」，鼠标悬停列出具体字段。
按设计就为空的（公章位、产品图、买方回签栏）与渲染器自动派生的（金额大写/合计/卖方名/页脚）
不计入 —— 否则体检会天天报噪音。

安全措施（都是踩出来的）：`--fix --write` 只插入 `required: false` 的声明、
**不重排 JSON**、写前 `JSON.parse` 校验、**校验不过拒绝写盘**；可重复执行（幂等）。
开发中它两次拦住了我写错的结构（多一个空行、多一个尾逗号）。

## 九、分页：签章区不许被切开（2026-10-11 新增）

共享样式的 `@media print` 新增（**TS 的 `assets.json` 与归档 `_shared.css` 同步改** ——
只改一边，`verify-trade-doc-fixtures.py` 的逐字节证明立刻断）：

```css
table.sign, table.sign tr, table.sign td,
.certify, .foot { page-break-inside: avoid; break-inside: avoid; }
```

- **为什么 `table.sign` 自己也要 avoid**：原先只保护了内层 `.sign-box`，
  签章表的左右两格**可能被分到两页**（买方回签在上一页、卖方公章在下一页）——
  这是最难看的失败形态。
- **实测结论**（Chromium，2026-10-11）：`break-before/after: avoid` **被忽略** ——
  给 `table.sign` 加与不加，产物 SHA256 完全相同。所以「签章区绝不成为新页上的
  唯一内容」**无法用纯 CSS 保证**；能保证的是**不被切开**，以及声明条款随它同块移动。
  真要杜绝"孤单落在新页"，得让模板把末尾几块包进一个 `break-inside: avoid` 容器
  （会动到全部 18 个模板，本次未做）。

## 十、单证内容版本（2026-10-20 新增 · TODO A1）

**问题**：草稿期「填写单据内容」改的是 `raw_payload`，**整块覆盖** —— 改前写了什么找不回。
`raw_payload._audit` 只有"谁/何时/改了哪些键"（可读、不可回滚，也不含 sources 快照）。

**做法**：新表 `trade_doc_content_versions`（迁移 `202610200001`）按**单据内递增版本号**存
**整份 payload 快照**。五条写路径都留版，`change_source` 标明来源：

| change_source | 触发点 |
|---|---|
| `custom_update` | PATCH `/trade-docs/{id}` 改 `raw_payload`（草稿手工保存） |
| `refresh_sources` | `POST .../refresh-sources` 重新带入上游快照 |
| `translate` | `POST .../translate` AI 翻译写回 |
| `issue` | 签发冻结（含 `_render` 指纹终版；issued 后不再产生新版本） |
| `restore` | 恢复历史版本（恢复本身也留一版，**版本链只增不删**） |

**端点**（worker `ws_docs_ext.py`）：

```
GET  /api/v1/trade-docs/{id}/content-versions                  列表（倒序；不带 payload，只带 custom 键名）
GET  /api/v1/trade-docs/{id}/content-versions/{version_no}     某版整份 payload
POST /api/v1/trade-docs/{id}/content-versions/{version_no}/restore   仅 draft
```

恢复的两条硬边界（与签发冻结口径一致）：**已签发/作废 → 409**（法律凭证内容冻结，不能用"恢复"
绕过锁）；**报价单（`doc_type='quotation'`）→ 409 `QUOTATION_DOC_SYNCED`**（它由报价自动同步，
恢复会被下次报价更新覆盖）。前端「内容版本」面板里对应位置直接禁用并给出原因。

**与文件版本链的关系**：`file_objects.version / is_current / supersedes_id` 管的是**上传的 PDF
文件**（v1/v2 的归档件），本表管的是**内容**（sources + custom 快照）—— 两条链互不替代，
同一份单据可以"内容 v3 + 文件 v2"。
