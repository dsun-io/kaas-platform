# 2026-10-21 最终收口批（final closeout）

> **性质**：历史留档。本批 5 份文档均已完成使命、被当前实现/账本取代；**不代表当前口径**，
> 不要据此判断现状。当前状态看 [`../../TODO.md`](../../TODO.md)、[`../../README.md`](../../README.md)、
> 根 [`README.md`](../../../README.md) 与代码。
> **归档日期**：2026-10-21（最终收口）。**保留原文**（含文内旧相对链接，可能已失效；
> 链接检查规则见 [`../../README.md`](../../README.md) §6「排除 `docs/archive/**`」）。

## 0. 为什么收进归档

C36/A5/A6/C12/B 产品配置等专项全部收口后，这 5 份文档的「待做/方案/过程记录」属性已经过时：

- 方案稿已由代码实现替代（A5 编辑体验、A6 真实单据校准、B1/B3 产品配置）；
- 验收/过程记录已有结论（C12 PDF 归档、后端 5 项验收基线），结论已并入代码与当前账本；
- 保留在 `docs/` 根会让新读者把「历史方案/差距清单」误当现行规范。

## 1. 文档清单与替代指针（先看这张表）

| 归档文档 | 原用途 | 当前口径看这里 |
|---|---|---|
| [`TRADE_DOC_EDIT_PLAN.md`](./TRADE_DOC_EDIT_PLAN.md) | A5 单证编辑体验方案稿（条款模板/行项批量/金额摘要）；W1/W2/W3 已全部上线 | **[`TODO.md`](../../TODO.md) A-9（A5 已销账）**；现行模板与渲染规范 [`TRADE_DOC_TEMPLATES.md`](../../TRADE_DOC_TEMPLATES.md)；实现 `frontend/src/lib/trade-doc/**` + `custom-fields.ts` |
| [`TRADE_DOC_A6_CALIBRATION.md`](./TRADE_DOC_A6_CALIBRATION.md) | A6 真实单证校准矩阵（G1–G12 差距）；A6-1/P1/P2 已落地 | **[`TODO.md`](../../TODO.md) A-6（已收口）**；字段/版式最终说明见 [`TRADE_DOC_TEMPLATES.md`](../../TRADE_DOC_TEMPLATES.md) §十一（双币种 + G7–G12） |
| [`TRADE_DOC_PDF_ARCHIVAL.md`](./TRADE_DOC_PDF_ARCHIVAL.md) | PDF 留档与对账设计与过程记录（含早期「未验证」章节、C12+ 验收补项）；C12 已完成（22/23 类真 PDF 归档留证） | **[`TODO.md`](../../TODO.md) A-12（C12 已销账）**；实现真相 = 代码：`backend/kaas_common/files/render_pdf.py`、`backend/worker/src/ws_files.py`、`ws_cron.py`、`render_pdf` 对账 SQL |
| [`UI_BACKEND_DEPENDENCIES_2026-10-20.md`](./UI_BACKEND_DEPENDENCIES_2026-10-20.md) | 后端 5 项依赖清单 + 历史验收基线（2026-10-20 全部完成并入 `main`） | 根 [`README.md`](../../../README.md)（架构/门禁/三环境）；[`HANDOVER_2026-10-20_FINAL.md`](../../HANDOVER_2026-10-20_FINAL.md) §0.1（逐项证据）；现状以 [`TODO.md`](../../TODO.md) + 代码为准 |
| [`PRODUCT_CONFIG_TENANT_UNFINISHED.md`](./PRODUCT_CONFIG_TENANT_UNFINISHED.md) | 租户级产品配置化设计与未完成清单；B1/B3 已收口 | **[`TODO.md`](../../TODO.md) B 组（B1/B3 已销账）**；根 [`README.md`](../../../README.md) 与 `backend/kaas_common/domain/`、`ws_products.py` 为当前实现 |

## 2. 归档时的状态快照（仅用于给这批文档标时间，**不是现时口径**）

- 生产版本：`83647f7a`；迁移头：`202610210001`
- 门禁：worker **1560 passed + 12 skipped**；前端 **926 passed / 108 files**；e2e **27 条（27 passed + 0 skipped）**；构建 `frontend/out` **286 文件**
- 任务组：**A 组除 A-11（D6，用户决定挂起）外全部完成**；**B 组用户已确认关闭**

> 状态数字会随批次变化；引述前先看根 README 与 [`TODO.md`](../../TODO.md) 的最新门禁行。

## 3. 本批目录约定

- 本目录只存**原文**，不修改归档文档内容（除本 README）。
- 需要引用归档内容时，用**完整路径**（`docs/archive/2026-10-21-final-closeout/<file>`）并注明「历史留档」。
- `docs/archive/**` 的旧相对链接按约定不纳入链接检查（见 [`../../README.md`](../../README.md) §6）。
