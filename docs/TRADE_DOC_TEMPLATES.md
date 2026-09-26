# 外贸单证模板规范（单证工位）

> 模板目录：`backend/orchestrator/app/templates/trade_docs/`
> 共享样式：`backend/orchestrator/app/templates/trade_docs/_shared.css`
> 渲染器：`backend/orchestrator/app/renderers/trade_doc_renderer.py`
> 接口：`backend/orchestrator/app/api/trade_doc_render.py`
> 样例产出：`backend/orchestrator/sample_docs/*.html`

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
- 缺失字段渲染为空串，**不会残留 `$placeholder`**；所有值经 HTML 转义防注入
  （仅 `other` 单证的 `content` 按原始 HTML 透传）。

---

## 五、使用方式

```powershell
# 生成全部 9 类英文样例（自包含 HTML，双击即可预览 / 打印 PDF）
cd backend/orchestrator
python scripts/render_all_samples.py
```

接口：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/trade-doc-templates` | 模板清单 |
| GET | `/api/v1/trade-doc-templates/{doc_type}` | 单类字段定义（供前端动态表单 / AI 填充） |
| GET | `/api/v1/trade-docs/{id}/render` | 按业务数据渲染 HTML（可浏览器打印为 PDF） |

---

## 六、扩展新单证

1. 在 `templates.json` 增加一条定义（`name_zh` / `name_en` / `description` / `template_file` / `fields`），
   并在 `description` 中写清**由谁出具**。
2. 新建 `xxx.html`，`<style>` 内写 `/*__SHARED_STYLE__*/` 占位即可复用共享样式。
3. 若表格列需固定，在 `trade_doc_renderer.py::_ITEM_COLUMNS` 增加该类型的列定义
   （格式：`(字段 key, 英文表头, 对齐 c/l/r)`）。
4. 在 `tests/test_trade_doc_renderer.py` 补对应的渲染与字段用例。

**已验证的约束**：凡模板使用 `$items` 的，必须同时在 `_ITEM_COLUMNS` 定义固定列
（由 `test_every_template_using_items_defines_fixed_columns` 自动化卡住）。

**待扩展的常见单证**（可按上述步骤添加）：
SASO / COC 等目的国认证文件、船公司证明（Certificate of Vessel's Ownership）、
出口许可证、商检证书（CIQ）、受益人声明（Beneficiary's Declaration）等。
