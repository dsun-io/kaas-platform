# 文档索引 · 真相源分层

> 2026-10-20 深夜收尾后版本（S5 预览交付 + 云资源治理 + 交接文档定稿；
> 本轮新增归档：`HANDOVER_2026-10-20`、`USER_ACTIONS_2026-10-19`、`MASTER_EXEC_PLAN_2026-10-19`
> → `archive/2026-10-20-closeout/`）。
> 历史清理版本：[`archive/2026-10-17-doc-cleanup/`](./archive/2026-10-17-doc-cleanup/README.md)。

## 真相源分层（谁说了算）

| 层级 | 位置 | 作用 | 说明 |
|---|---|---|---|
| 1 | **代码库**（含 `shared/contracts` 共享契约） | 技术真相源 | 系统怎么算、怎么运转，一律以代码为准 |
| 2 | 线上数据库 | 运行数据 | 实际业务数据（客户、报价单等） |
| 3 | **Notion** | 只做任务管理 | 任务拆分与验收记录；**不是技术真相源** |
| 留档 | [`docs/archive/`](./archive/) 下的历史报告 | 历史参考 | 只读留档，不代表当前架构 |

## 当前权威（先读这些 · 2026-10-20 定稿）

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | **主交接文档（唯一权威）**：架构 / 三环境隔离矩阵 / 方案 B 决策 / 冷启动线 / 测试策略 / 门禁 |
| [HANDOVER_2026-10-20_FINAL.md](./HANDOVER_2026-10-20_FINAL.md) | **2026-10-20 最终交接**：S5 预览交付与验证、三环境现状、云资源清单（含已删/保留）、踩坑结论、发布检查单、待办与提醒 |
| [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 问题状态滚动口径（顶部交接摘要按时间倒序；2026-10-20 = 待办清零 + 预览链交付） |
| [ENV_VERIFICATION_2026-10-19.md](./ENV_VERIFICATION_2026-10-19.md) | 三环境配置与连接核对 + 发布前检查单与回滚预案 |
| [UNCERTAIN.md](./UNCERTAIN.md) | 决策账本：每条存疑/裁决的落盘记录（含单证加固 5 项口径 #17） |
| [UI_UX_OPTIMIZATION_2026-10-20.md](./UI_UX_OPTIMIZATION_2026-10-20.md) | 全系统 UI/UX 优化方案（纯前端展示与交互层）；**第一批已落地**：客户管理 + 登录页（浅色毛玻璃 + 电光蓝、详情弹窗、询盘后续），其余页面待迁移；实施记录见 §0.1 |

## 2026-10-19 决策与证据（方案 B 收口链）

| 文档 | 内容 |
|---|---|
| [PLAN_B_EVALUATION_2026-10-19.md](./PLAN_B_EVALUATION_2026-10-19.md) | 方案 B 阶段一评估（四问取证，结论 B-可行 + 三项已确认修正） |
| [POC_WORKER_SQLALCHEMY_2026-10-19.md](./POC_WORKER_SQLALCHEMY_2026-10-19.md) | 路线 A 否决证据（greenlet 无 wasm wheel + 冷启动 +1854ms 超线） |
| [S4_SINGLE_APP_PLAN_2026-10-19.md](./S4_SINGLE_APP_PLAN_2026-10-19.md) | S4 单应用收口设计（worker 为唯一运行时；已完成） |
| [S4_TEST_MIGRATION_2026-10-19.md](./S4_TEST_MIGRATION_2026-10-19.md) | 测试处置记录（1,220 → 222 保留；15 个引擎测试迁 worker） |
| [MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md](./MIGRATION_DOWNGRADE_AUDIT_2026-10-19.md) | 迁移链 downgrade 审计（`drop_table` 精确 3 个，旧口径「35」已更正） |
| [SECURITY_AUDIT_2026-10-19.md](./SECURITY_AUDIT_2026-10-19.md) | 安全审查报告（危/高/中/低 + 三环境核对 + 用户动作汇总） |
| [TECH_STACK_UPGRADE_2026-10-17.md](./TECH_STACK_UPGRADE_2026-10-17.md) | 技术栈升级账本（2026-10-20 已全量完成：Next 16 / React 19 / ESLint 10 / TS 6） |

## 2026-10-18 业务口径（本轮上线内容依据）

| 文档 | 内容 |
|---|---|
| [TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md](./TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md) | 税务档案改造交接执行计划（已上线） |
| [TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md](./TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md) | 税务档案重设计方案 |
| [BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md](./BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md) | 批量报价重设计（已上线） |
| [QUOTE_COST_INSURANCE_2026-10-18.md](./QUOTE_COST_INSURANCE_2026-10-18.md) | 成本手填 / 整单保险 / 计量口径（已上线） |
| [SHEET_CALC_VERIFICATION_2026-10-18.md](./SHEET_CALC_VERIFICATION_2026-10-18.md) | 智能表格算价核验（缺口留作历史记录，不阻塞上线） |

## 口径与决策账本（历史判断，仍以现行文档为准）

| 文档 | 内容 |
|---|---|
| [CURRENT_IMPLEMENTATION_MAP.md](./CURRENT_IMPLEMENTATION_MAP.md) | 实现地图（历史判断，以代码与 PROBLEM_STATUS 为准） |
| [WORKSTATION_DESIGN.md](./WORKSTATION_DESIGN.md) | 工位能力网设计（历史设计债标注在文档内） |
| [PLATFORM_UPGRADE_PLAN.md](./PLATFORM_UPGRADE_PLAN.md) | 平台升级方案（客户主线设计；部分引用已随 10-20 归档改指） |
| [TEAMS_AND_VISIBILITY.md](./TEAMS_AND_VISIBILITY.md) | 团队与数据可见性（三层组织规则） |
| [CUSTOMER_DOCUMENTS_VIEW.md](./CUSTOMER_DOCUMENTS_VIEW.md) | 客户单据视图（报价单 1:1 产物的依据） |
| [PLAN_CUSTOMER_RECORDS.md](./PLAN_CUSTOMER_RECORDS.md) | 客户往来记录树设计（worker `/records` 已上线） |
| [PRODUCT_MEDIA_STORAGE_PLAN.md](./PRODUCT_MEDIA_STORAGE_PLAN.md) | 产品媒体存储方案（R2 桶 `kaas-files` 实配口径） |
| [PRODUCT_CONFIG_TENANT_UNFINISHED.md](./PRODUCT_CONFIG_TENANT_UNFINISHED.md) | 租户级产品配置化未竟清单（I-7 触发条件制） |
| [TRADE_DOC_PDF_ARCHIVAL.md](./TRADE_DOC_PDF_ARCHIVAL.md) | 单证 PDF 归档与指纹对账 |
| [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md) | 单证模板参考 |
| [QA_TEST_ACCOUNTS.md](./QA_TEST_ACCOUNTS.md) | 测试账号与验收口径 |

## 测试

| 文档 | 内容 |
|---|---|
| [E2E_GUIDE.md](./E2E_GUIDE.md) | 端到端测试一键可跑说明书 |
| [E2E_STATUS_2026-10-11.md](./E2E_STATUS_2026-10-11.md) | e2e 状态与已知边界 |

## 归档入口（历史留档，不代表当前架构）

| 位置 | 内容 |
|---|---|
| [archive/2026-10-20-closeout/](./archive/2026-10-20-closeout/README.md) | **2026-10-20 收尾批**：被方案 B 取代的 A′ 计划、决策 1 废弃的 PPG 迁移、已完成的历史交接/部署/模块计划等 22 份；**含本轮移入的** `HANDOVER_2026-10-20.md`（其发布检查单已迁入 `HANDOVER_2026-10-20_FINAL.md` §5）、`USER_ACTIONS_2026-10-19.md`、`MASTER_EXEC_PLAN_2026-10-19.md`（待办已清零/转触发条件制） |
| [archive/2026-10-19-master-exec/](./archive/2026-10-19-master-exec/) | 契约与 mock 既定决策（已归档；口径以 README + PROBLEM_STATUS 为准） |
| [archive/2026-10-17-doc-cleanup/](./archive/2026-10-17-doc-cleanup/README.md) | 2026-10-17 清理批（含清理清单） |
| [archive/](./archive/) | 更早归档批次（2026-09 等） |
