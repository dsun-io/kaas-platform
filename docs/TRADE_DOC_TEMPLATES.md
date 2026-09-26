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

| 类型 | 单据名 | 出具方 | 本系统产出的性质 |
|---|---|---|---|
| `quotation` | Quotation | **出口商** | 正式报价单 |
| `pi` | Proforma Invoice | **出口商** | 正式形式发票 |
| `contract` | Sales Contract | **买卖双方** | 正式合同（双签） |
| `ci` | Commercial Invoice | **出口商** | 正式发票，可直接报关、议付、收汇 |
| `pl` | Packing List | **出口商** | 正式装箱单 |
| `bl` | Bill of Lading | **承运人 / 船公司** | ❗仅为**托运单/提单确认件（Draft）**，页面明确标注 *To Be Issued by the Carrier*，正本由船公司签发 |
| `co` | Certificate of Origin | **贸促会（CCPIT）/ 海关** | ❗仅为**申报信息表**，正式证书按法定格式（FORM A / CO / FORM E 等）由签证机构出具 |
| `insurance` | Insurance Policy | **保险公司** | ❗仅为**投保信息**，正式保单由保险公司签发 |
| `other` | 通用单证 | 视具体单据而定 | 受益人证明、装运通知等由出口商出具的辅助单据 |

后三类单据模板底部均带**声明条款**说明签发方，签章栏也按真实签发方设置（承运人 / 签证机构 / 保险公司），
不会误导使用者把它当成已生效的正式凭证。

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

**待扩展的常见单证**（当前未做，可按上述步骤添加）：
装运通知（Shipping Advice）、受益人证明（Beneficiary Certificate，现可用 `other`）、
汇票（Bill of Exchange / Draft）、报关单、商检证书、船公司证明（Certificate of Ownership）、
SASO / COC 等目的国认证文件。
