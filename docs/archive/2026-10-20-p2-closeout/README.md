# 2026-10-20 P2 收尾归档批

> 归档日期：2026-10-20
> 原则：**只归档已完成 / 已被现行代码取代 / 只作历史证据的文档**；当前架构、接口、待办、交接仍留在 `docs/` 根。

## 为什么归档

这一批文档曾在 2026-10-17 ~ 10-20 支撑方案 B、S4 单应用、技术栈升级、税务/批量报价上线；相关内容均已落地或被 `README.md` + `PROBLEM_STATUS` + 代码取代。继续放在 `docs/` 根会让交接 agent 误把“当时的计划”当成“现在的口径”。

## 归档清单

| 文档 | 原用途 | 现行口径 |
|---|---|---|
| `PLAN_B_EVALUATION_2026-10-19.md` | 方案 B 评估 | 已落地；看 `README.md` §1 |
| `POC_WORKER_SQLALCHEMY_2026-10-19.md` | 路线 A 否决证据 | 历史证据；运行时口径看 `README.md` |
| `S4_SINGLE_APP_PLAN_2026-10-19.md` | S4 单应用收口 | 已完成；看 `README.md` §1 |
| `S4_TEST_MIGRATION_2026-10-19.md` | 测试迁移记录 | 已完成；看当前测试门禁 |
| `MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md` | 迁移 downgrade 审计 | 审计完成；看迁移链 |
| `TECH_STACK_UPGRADE_2026-10-17.md` | 技术栈升级账本 | 已完成；看 `README.md` + `AGENTS.md` |
| `SECURITY_AUDIT_2026-10-19.md` | 安全审查报告 | 历史报告；新问题进 `PROBLEM_STATUS` / `TODO.md` |
| `TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md` | 税务档案交接执行 | 已上线 |
| `TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md` | 税务档案重设计 | 已上线 |
| `BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md` | 批量报价重设计 | 已上线 |
| `QUOTE_COST_INSURANCE_2026-10-18.md` | 报价成本/保险口径 | 已落代码；算价以代码为准 |
| `SHEET_CALC_VERIFICATION_2026-10-18.md` | 智能表格算价核验 | 历史核验记录 |
| `E2E_STATUS_2026-10-11.md` | e2e 旧状态 | 看当前 `pnpm e2e` + `E2E_GUIDE.md` |
| `CURRENT_IMPLEMENTATION_MAP.md` | 旧实现地图 | 代码是唯一真相源 |
| `PLAN_CUSTOMER_RECORDS.md` | 客户往来记录树计划 | 已上线 |

## 当前先读

1. [`../../README.md`](../../README.md) —— 主交接（架构/环境/门禁唯一权威）
2. [`../../HANDOVER_2026-10-20_FINAL.md`](../../HANDOVER_2026-10-20_FINAL.md) —— 最新交接
3. [`../../PROBLEM_STATUS_2026-10-11.md`](../../PROBLEM_STATUS_2026-10-11.md) —— 问题状态滚动口径
4. [`../../TODO.md`](../../TODO.md) —— 活跃待办唯一账本
5. [`../../UI_UX_OPTIMIZATION_2026-10-20.md`](../../UI_UX_OPTIMIZATION_2026-10-20.md) + [`../../UI_BACKEND_DEPENDENCIES_2026-10-20.md`](../../UI_BACKEND_DEPENDENCIES_2026-10-20.md) —— UI 现状与后端依赖
