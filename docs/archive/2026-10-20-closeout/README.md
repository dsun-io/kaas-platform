# 归档批次 · 2026-10-20 收尾（待办清零 + 过时文档归档）

> 归档执行：2026-10-20，用户裁决「把未关闭的待办全部关闭 + 过时文档归档」。**`git mv` 移动（git 历史
> 保留，禁止删除）**。本批共 **22 份**（10-20 深夜再移入 `HANDOVER_2026-10-20`、`USER_ACTIONS_2026-10-19`、
> `MASTER_EXEC_PLAN_2026-10-19`：前者发布检查单已迁入 `HANDOVER_2026-10-20_FINAL.md` §5，后两份为已清零账本）。
> 当前权威口径以根 `README.md` + **`docs/HANDOVER_2026-10-20_FINAL.md`（交接总入口）** +
> `docs/PROBLEM_STATUS_2026-10-11.md` + `docs/ENV_VERIFICATION_2026-10-19.md` 为准。

## 归档理由（分组）

### 1. 已被取代 / 已废弃的决策与计划（口径已并入现行文档）

| 文档 | 归档理由 |
|---|---|
| `DUAL_BACKEND_CONVERGENCE_2026-10-19.md` / `DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md` | A′ 路线被**方案 B** 取代（README §3/§10 + `PLAN_B_EVALUATION_2026-10-19.md` 为现行口径）；A′ 记录与 POC 结论仍作历史证据 |
| `PROD_DB_OPTIMIZATION_PLAN_2026-10-19.md` / `HANDOVER_2026-10-19_P1_PPG_MIGRATION.md` | **决策 1 废弃**（放弃 PPg 回 Neon，README §2.1/§9） |
| `HANDOVER_2026-10-19_CI_AND_PROD_FIXES.md` | 其事项（注册 500 / 定价页白屏 / CI db-tests）已全部完成并入 main 与 PROBLEM_STATUS，「勿重做」内容已被 HANDOVER_2026-10-20 覆盖 |
| `DEPLOYMENT_PLAN_2026-10-18.md` | 10-18 发布**已完成**（22:00，生产迁移至 `202610180010`），历史执行记录；其「税率配置清单」要点已抄录进 `USER_ACTIONS_2026-10-19.md` **U-B2** 行（归档前留痕） |
| `TRADE_DOC_HARDENING_PLAN_2026-10-12.md` | 设计方案未实现；§10 五项口径**已收进 `UNCERTAIN.md` #17**（2026-10-17 已按设计默认值拍板，归档前核对确认） |

### 2. 历史交接 / 会话收尾（滚动状态已被后续交接文档覆盖）

| 文档 | 归档理由 |
|---|---|
| `HANDOVER_2026-10-17.md` / `HANDOVER_2026-10-18.md` | 被 `HANDOVER_2026-10-20.md` 取代（滚动交接，旧版留档） |
| `SESSION_HANDOFF_2026-10-12_PM.md` / `SESSION_CLOSEOUT_2026-10-12.md` | 2026-10-12 会话收尾，事项早已落地或被 PROBLEM_STATUS 覆盖 |
| `ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md` | 账号治理交接事项已落地；仍被 SECURITY_AUDIT 危-2 作历史证据引用（引用已改指本归档路径） |

### 3. 过时执行日志 / 漂移清单 / 模块计划（口径已被后续文档取代）

| 文档 | 归档理由 |
|---|---|
| `CLEANUP_LOG.md` | 清理执行日志，事项已收口，PROBLEM_STATUS 为现行口径 |
| `WORKER_ORCHESTRATOR_DRIFT.md` | 双端漂移清单的数字口径已过期（S4 单应用收口后无「双端」可言） |
| `MULTI_PRODUCT_QUOTE_PLAN.md` / `QUOTE_PRODUCT_OPTIMIZATION_PLAN_2026-10-18.md` / `PRODUCT_MODULE_DECISIONS.md` / `PRODUCT_MODULE_IMPL_PLAN.md` / `PRODUCT_MODULE_MERGE_PLAN.md` | 产品模块/报价优化各计划已落地收口（10-17~10-18 多轮完成并留痕 PROBLEM_STATUS），剩余小尾巴已入 MASTER 批次 7 触发条件制 |

## 引用修复

归档后已对活文档（根 `README.md`、`docs/README.md`、`MASTER_EXEC_PLAN`、`PROBLEM_STATUS`、
`SECURITY_AUDIT`、`UNCERTAIN`、`POC_WORKER_SQLALCHEMY`、`PLATFORM_UPGRADE_PLAN`、
`TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN`、`HANDOVER_2026-10-20`、`USER_ACTIONS`）逐一修复引用链接，
改指本目录或删除引用行。代码注释中的历史文档引用（非链接用途）保持原样未动。
