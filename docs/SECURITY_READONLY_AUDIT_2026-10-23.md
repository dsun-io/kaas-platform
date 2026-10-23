# 只读安全审计 · docs/archive/** + archive/**（2026-10-23）

> **执行依据**：用户 2026-10-23 拍板「只做只读审计」——本轮**未修改/删除/移动任何文件**，
> 未做任何口令轮换或仓库可见性变更。仓库当前为 public。
> **方法**：脚本遍历两目录全部文本文件（147 个），按 6 类模式扫描（email / 中国手机号 / 国际电话 /
> 金额 / 18 位身份证号 / 公司名关键词），命中样本一律**脱敏**后记录（不留明文）。

## 0. 结论摘要

| 项 | 数值 |
|---|---|
| 扫描文件 | **147**（archive/ 44 + docs/archive/ 103） |
| 含敏感命中 | **57** |
| 公司名关键词 | 40 个文件（含「联佳」/「XX Co., Ltd」/「XX有限公司」） |
| 金额 | 22 个文件（USD/CNY 报价、单价、总额） |
| 国际电话 | 17 个文件（+86 等） |
| 邮箱 | 15 个文件 |
| 中国手机号 / 18 位身份证 | **0** |
| 银行账号/税号专项 | 未单独命中（金额正则可能覆盖部分数字串，见 §3） |

**最高风险**：`archive/2026-09-trade-doc-xprime-python/sample_docs/` 下 **18 份真实单据样例**（sample_ci/bl/co/contract/...），
同时含公司名+电话+金额，属**真实业务样例**（此前用户已知的 18 份）。

## 1. 逐文件命中（脱敏样本）

| 文件 | 命中类别 | 脱敏样本 |
|---|---|---|
| `archive\2026-09-trade-doc-xprime-python\app\templates\trade_docs\insurance.html` | company_kw×2 | 海运******公司 / 签发****公司 |
| `archive\2026-09-trade-doc-xprime-python\app\templates\trade_docs\templates.json` | company_kw×2 | 正本******公司 / 正式*****公司 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_beneficiary_cert.html` | intl_phone×1 | +8******21 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_bl.html` | intl_phone×1 | +8******21 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_ci.html` | intl_phone×1、money×1、company_kw×2 | +8******21 / US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_co.html` | intl_phone×1、company_kw×2 | +8******21 / Ca******ce |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_contract.html` | intl_phone×2、money×1、company_kw×2 | +8******21 / US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_customs_declaration.html` | intl_phone×1、money×2、company_kw×2 | +8******21 / US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_draft.html` | money×1 | US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_insurance.html` | money×1、company_kw×2 | US******00 / 海运******公司 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_manufacturer_cert.html` | intl_phone×1 | +8******21 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_non_wood_packing.html` | intl_phone×1 | +8******21 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_other.html` | intl_phone×1 | +8******21 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_pi.html` | intl_phone×1、money×1、company_kw×2 | +8******21 / US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_pl.html` | intl_phone×1、company_kw×2 | +8******21 / Ca******ce |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_quality_cert.html` | intl_phone×1、company_kw×2 | +8******21 / Ca******ce |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_quotation.html` | intl_phone×1、money×1、company_kw×2 | +8******21 / US******00 |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_shipping_advice.html` | intl_phone×1、company_kw×2 | +8******21 / Ca******ce |
| `archive\2026-09-trade-doc-xprime-python\sample_docs\sample_weight_list.html` | intl_phone×1、company_kw×2 | +8******21 / Ca******ce |
| `archive\2026-09-trade-doc-xprime-python\scripts\render_all_samples.py` | email×2、intl_phone×1、money×1、company_kw×2 | ex******om / ja******au |
| `archive\2026-09-trade-doc-xprime-python\tests\test_trade_doc_renderer.py` | money×1、company_kw×3 | US******00 / 安平******公司 |
| `docs\archive\2026-09-22-pre-workstation-graph\CODEBASE_AUDIT_REPORT_2026-05-13.md` | company_kw×1 | 联*** |
| `docs\archive\2026-09-22-pre-workstation-graph\DEPLOY.md` | email×2 | a@**co / ad******ev |
| `docs\archive\2026-10-12-tim-doc-prototypes\check_ct_vs_pi.py` | money×6 | CN***50 / CN***00 |
| `docs\archive\2026-10-12-tim-doc-prototypes\check_pi_sc_ci.py` | email×1、money×19 | ti******om / CN******66 |
| `docs\archive\2026-10-12-tim-doc-prototypes\make_tim_post_pi_docs.py` | email×4、intl_phone×4、money×35、company_kw×26 | sa******om / ti******om |
| `docs\archive\2026-10-17-doc-cleanup\ADMIN_TENANTS_CONTRACT_REPORT.md` | company_kw×2 | 联*** |
| `docs\archive\2026-10-17-doc-cleanup\DB_LAYER_OPTIMIZATION.md` | money×4 | $*** / $*** |
| `docs\archive\2026-10-17-doc-cleanup\DUAL_BACKEND_CONVERGENCE.md` | money×2 | $*** |
| `docs\archive\2026-10-17-doc-cleanup\QUOTE_WORKSTATION_WIRING_PLAN.md` | company_kw×1 | 客户******公司 |
| `docs\archive\2026-10-17-doc-cleanup\TODO_REMAINING_2026-10-10.md` | company_kw×6 | 联*** / 别*** |
| `docs\archive\2026-10-17-doc-cleanup\TRADE_DOC_DELIVERY_2026-09-26.md` | company_kw×1 | 买方**公司 |
| `docs\archive\2026-10-17-doc-cleanup\TRADE_DOC_WORKSTATION_PLAN.md` | company_kw×1 | 买方**公司 |
| `docs\archive\2026-10-20-closeout\ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md` | email×7、company_kw×3 | ad******ev / qa******al |
| `docs\archive\2026-10-20-closeout\HANDOVER_2026-10-17.md` | email×1、company_kw×5 | qa******om / 河北**公司 |
| `docs\archive\2026-10-20-closeout\HANDOVER_2026-10-18.md` | email×1、company_kw×1 | e2******al / 河北**公司 |
| `docs\archive\2026-10-20-closeout\HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md` | email×1 | da******om |
| `docs\archive\2026-10-20-closeout\HANDOVER_2026-10-19_P1_PPG_MIGRATION.md` | email×3、company_kw×2 | ds******om / ..******io |
| `docs\archive\2026-10-20-closeout\MULTI_PRODUCT_QUOTE_PLAN.md` | company_kw×1 | Li******ce |
| `docs\archive\2026-10-20-closeout\PRODUCT_MODULE_IMPL_PLAN.md` | company_kw×1 | 联*** |
| `docs\archive\2026-10-20-closeout\PRODUCT_MODULE_MERGE_PLAN.md` | money×1、company_kw×1 | $*** / 产品**公司 |
| `docs\archive\2026-10-20-closeout\QUOTE_PRODUCT_OPTIMIZATION_PLAN_2026-10-18.md` | money×1、company_kw×1 | ¥1*00 / 中*** |
| `docs\archive\2026-10-20-closeout\SESSION_HANDOFF_2026-10-12_PM.md` | email×1、company_kw×2 | no******om / 河北**公司 |
| `docs\archive\2026-10-20-closeout\TRADE_DOC_HARDENING_PLAN_2026-10-12.md` | money×1、company_kw×1 | US******49 / 推出**公司 |
| `docs\archive\2026-10-20-closeout\USER_ACTIONS_2026-10-19.md` | email×1 | ds******om |
| `docs\archive\2026-10-20-p2-closeout\E2E_STATUS_2026-10-11.md` | company_kw×2 | 联*** |
| `docs\archive\2026-10-20-p2-closeout\QUOTE_COST_INSURANCE_2026-10-18.md` | company_kw×1 | 报价******公司 |
| `docs\archive\2026-10-20-p2-closeout\SECURITY_AUDIT_2026-10-19.md` | email×3、money×1 | da******om / qa******om |
| `docs\archive\2026-10-21-cutover\HANDOVER_2026-10-20_FINAL.md` | email×1 | ds******om |
| `docs\archive\2026-10-21-cutover\HANDOVER_STRUCTURAL_DEBT_2026-10-21.md` | email×1 | pa******ch |
| `docs\archive\2026-10-21-cutover\UI_UX_OPTIMIZATION_2026-10-20.md` | company_kw×1 | 联*** |
| `docs\archive\2026-10-21-doc-closeout\CUSTOMER_DOCUMENTS_VIEW.md` | money×3、company_kw×2 | US******00 / US*****00 |
| `docs\archive\2026-10-21-doc-closeout\PRODUCT_MEDIA_STORAGE_PLAN.md` | email×4、company_kw×2 | qa******al / ad******ev |
| `docs\archive\2026-10-21-doc-closeout\TEAMS_AND_VISIBILITY.md` | company_kw×12 | 联*** / 其*** |
| `docs\archive\2026-10-21-final-closeout\TRADE_DOC_A6_CALIBRATION.md` | money×4、company_kw×3 | US***00 / CN******00 |
| `docs\archive\2026-10-21-final-closeout\TRADE_DOC_PDF_ARCHIVAL.md` | money×1 | $0*09 |
| `docs\archive\verify_crud_smoke.py` | money×20、company_kw×1 | $*** / $*** |

## 2. 风险分级与建议（仅建议，未执行）

| 级别 | 范围 | 建议 |
|---|---|---|
| **高** | `archive/.../sample_docs/*.html`（18 份真实样例：公司/电话/金额） | 若要保 public：把真实值替换为占位符（如 `ACME TRADING CO.`、`+1 555 *** ****`），或迁出到私有存储；改动前需你确认（本轮不动）。 |
| **中** | `docs/archive/**` 审计/设计文档中的邮箱/电话/公司名；`templates.json` 的样例值 | 可批量脱敏（脚本替换为占位符）；同样需你确认。 |
| **低** | 金额/模板占位 | 金额本身不含个人身份信息；保留可读性即可。 |

## 3. 局限

- 扫描基于正则关键词，**不能**保证覆盖：银行账号、税号、地址、人名（中文人名）、非 +86 电话格式。
- 若决定脱敏，建议按 §1 清单逐文件处理并加回归脚本（防止再次出现），而不是一次性删除历史。
- 本轮按裁决**保持现状**：仓库仍 public，历史样例仍在 `docs/archive/**`+`archive/**`。

## 4. 复核命令

```powershell
# 重新扫描（只读；不修改文件）
Get-ChildItem -Recurse -File archive, docs/archive | Measure-Object   # 147
```
