# 2026-10-17 文档清理 · 归档清单

> 本次清理原则：**保守移动**——只归档「阶段性报告 / 已被取代的状态快照 /
> 自标过期」文档；活跃口径、决策账本、执行中计划一律留在 `docs/` 根。
> 归档文件只读，不代表当前架构；当前口径一律以
> [`PROBLEM_STATUS_2026-10-11.md`](../../PROBLEM_STATUS_2026-10-11.md) 为准。

## 移入本目录的文件（原路径 → 现路径）

| 文件 | 原位置 | 归档原因 |
|---|---|---|
| EXECUTION_SUMMARY_2026-10-10.md | docs/ | 当日执行摘要，状态已被交接摘要取代 |
| TODO_REMAINING_2026-10-10.md | docs/ | **文档自标过期**；未竟项已转入 PROBLEM_STATUS/UNCERTAIN |
| RELEASE_2026-10-10_quote_model.md | docs/ | 发布说明（历史） |
| ROUTE_PARITY_2026-10-10.md | docs/ | 一次性测量快照（route-parity 门禁现为脚本实跑） |
| PLAN_A_SHARED_API_PROGRESS.md | docs/ | Plan A 进度报告（该线程已收口） |
| ADMIN_TENANTS_CONTRACT_REPORT.md | docs/ | 一次性契约审计报告 |
| FRONTEND_PRODUCTION_READINESS.md | docs/ | 当时判断、部分已修复；口径以 PROBLEM_STATUS 为准 |
| DUAL_BACKEND_CONVERGENCE.md | docs/ | 双后端收敛**已完成**，历史方案 |
| DB_LAYER_OPTIMIZATION.md | docs/ | 一次性优化报告（已执行） |
| ENTITY_LINKS_OPTIMIZATION.md | docs/ | 一次性优化报告（已执行） |
| TRADE_DOC_DELIVERY_2026-09-26.md | docs/ | 已被 TRADE_DOC_PDF_ARCHIVAL + HARDENING_PLAN 取代 |
| E2E_ROUTE_ENDPOINT_INVENTORY.md | docs/ | 一次性端点盘点 |
| QUOTE_WORKSTATION_WIRING_PLAN.md | docs/ | 接线计划（已落地） |
| TRADE_DOC_WORKSTATION_PLAN.md | docs/ | 单证工位方案（已落地并被加固方案取代） |
| TRADE_DOC_WORKSTATION_STATUS.md | docs/ | 状态快照（已落地） |
| PRODUCT_MODULE_P1_REPORT.md | docs/ | P1 阶段报告（已完成；P13–P16 线程看 PRODUCT_MODULE_MERGE_PLAN 等） |

## 仍在 docs/ 根的文档（保留清单见 [docs/README.md](../../README.md)）

口径与账本：PROBLEM_STATUS / UNCERTAIN / CLEANUP_LOG /
CONTRACT_AND_MOCK_DECISIONS / QA_TEST_ACCOUNTS / E2E_GUIDE / E2E_STATUS。
活跃计划：TRADE_DOC_HARDENING_PLAN / TRADE_DOC_PDF_ARCHIVAL /
TRADE_DOC_TEMPLATES / MULTI_PRODUCT_QUOTE_PLAN / PRODUCT_MEDIA_STORAGE_PLAN /
PRODUCT_MODULE_IMPL_PLAN / PRODUCT_MODULE_MERGE_PLAN /
PRODUCT_MODULE_DECISIONS / PRODUCT_CONFIG_TENANT_UNFINISHED /
ACCOUNT_GOVERNANCE_HANDOVER / TEAMS_AND_VISIBILITY / PLATFORM_UPGRADE_PLAN /
CUSTOMER_DOCUMENTS_VIEW / PLAN_CUSTOMER_RECORDS / SESSION_HANDOFF_2026-10-12_PM /
SESSION_CLOSEOUT_2026-10-12 / WORKSTATION_DESIGN / WORKER_ORCHESTRATOR_DRIFT /
CURRENT_IMPLEMENTATION_MAP。
