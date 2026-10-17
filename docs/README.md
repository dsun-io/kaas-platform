# 文档索引 · 真相源分层

> 2026-10-17 清理后版本。归档历史见 [`archive/2026-10-17-doc-cleanup/`](./archive/2026-10-17-doc-cleanup/README.md)。

## 真相源分层（谁说了算）

| 层级 | 位置 | 作用 | 说明 |
|---|---|---|---|
| 1 | **代码库**（含 `shared/contracts` 共享契约） | 技术真相源 | 系统怎么算、怎么运转，一律以代码为准 |
| 2 | 线上数据库 | 运行数据 | 实际业务数据（客户、报价单等） |
| 3 | **Notion** | 只做任务管理 | 任务拆分与验收记录；**不是技术真相源** |
| 留档 | [`docs/archive/`](./archive/) 下的历史报告 | 历史参考 | 只读留档，不代表当前架构 |

## 口径与决策账本（先读这些）

| 文档 | 内容 |
|---|---|
| [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | **现存问题当前口径**（实跑门禁取证；交接摘要滚动更新在顶部） |
| [UNCERTAIN.md](./UNCERTAIN.md) | 决策账本：每条存疑/裁决的落盘记录（#17–#21 为 2026-10-17 最新裁决） |
| [CLEANUP_LOG.md](./CLEANUP_LOG.md) | 清理与优化执行日志 |
| [CONTRACT_AND_MOCK_DECISIONS.md](./CONTRACT_AND_MOCK_DECISIONS.md) | 契约与 mock 的既定决策（含已登记待排期缺陷） |
| [WORKER_ORCHESTRATOR_DRIFT.md](./WORKER_ORCHESTRATOR_DRIFT.md) | 双端漂移清单（历史判断，大部分已修，剩余以 PROBLEM_STATUS 为准） |
| [CURRENT_IMPLEMENTATION_MAP.md](./CURRENT_IMPLEMENTATION_MAP.md) | 实现地图（历史判断，同上） |
| [QA_TEST_ACCOUNTS.md](./QA_TEST_ACCOUNTS.md) | 测试账号与验收口径 |

## 测试

| 文档 | 内容 |
|---|---|
| [E2E_GUIDE.md](./E2E_GUIDE.md) | 端到端测试一键可跑说明书 |
| [E2E_STATUS_2026-10-11.md](./E2E_STATUS_2026-10-11.md) | e2e 状态与已知边界 |

## 活跃计划与设计（执行中/被引用）

| 文档 | 内容 |
|---|---|
| [ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md](./ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md) | 账号治理交接（API 契约 §② + UI 设计 §④ + 验收清单 §⑤） |
| [MULTI_PRODUCT_QUOTE_PLAN.md](./MULTI_PRODUCT_QUOTE_PLAN.md) | 多产品报价 + 整单单证实施方案（D3 数量口径裁决来源） |
| [TRADE_DOC_HARDENING_PLAN_2026-10-12.md](./TRADE_DOC_HARDENING_PLAN_2026-10-12.md) | 单证加固方案（事实层/一致性引擎/收款项/导出自检；§10 五项已定稿） |
| [TRADE_DOC_PDF_ARCHIVAL.md](./TRADE_DOC_PDF_ARCHIVAL.md) | 单证 PDF 归档与指纹对账 |
| [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md) | 单证模板参考 |
| [PRODUCT_MEDIA_STORAGE_PLAN.md](./PRODUCT_MEDIA_STORAGE_PLAN.md) | 产品媒体存储三段（S3 预签名/R2/inline 回退） |
| [PRODUCT_MODULE_IMPL_PLAN.md](./PRODUCT_MODULE_IMPL_PLAN.md) / [PRODUCT_MODULE_MERGE_PLAN.md](./PRODUCT_MODULE_MERGE_PLAN.md) / [PRODUCT_MODULE_DECISIONS.md](./PRODUCT_MODULE_DECISIONS.md) / [PRODUCT_CONFIG_TENANT_UNFINISHED.md](./PRODUCT_CONFIG_TENANT_UNFINISHED.md) | 产品模块 P13–P16 线程（编辑器/差异覆盖/权限矩阵的未竟清单） |
| [TEAMS_AND_VISIBILITY.md](./TEAMS_AND_VISIBILITY.md) | 团队与数据可见性（三层组织规则） |
| [PLATFORM_UPGRADE_PLAN.md](./PLATFORM_UPGRADE_PLAN.md) | 平台升级方案（客户主线设计） |
| [TECH_STACK_UPGRADE_2026-10-17.md](./TECH_STACK_UPGRADE_2026-10-17.md) | 技术栈升级评估（依赖矩阵 / A/B/C/D 批次路线；2026-10-17 裁决：暂不执行） |
| [CUSTOMER_DOCUMENTS_VIEW.md](./CUSTOMER_DOCUMENTS_VIEW.md) | 客户单据视图（报价单 1:1 产物的依据） |
| [PLAN_CUSTOMER_RECORDS.md](./PLAN_CUSTOMER_RECORDS.md) | 客户往来记录树设计 |
| [SESSION_HANDOFF_2026-10-12_PM.md](./SESSION_HANDOFF_2026-10-12_PM.md) / [SESSION_CLOSEOUT_2026-10-12.md](./SESSION_CLOSEOUT_2026-10-12.md) | 2026-10-12 交接/收尾（P13 未竟细节引用源） |
| [WORKSTATION_DESIGN.md](./WORKSTATION_DESIGN.md) | 工位能力网设计（历史设计债标注在文档内） |

## 其它入口

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目总览与协作规范 |
| [../DEPLOY.md](../DEPLOY.md) | 部署说明（线上域名 kaas.powervoy.com） |
| [archive/](./archive/) | 归档资料（不反映当前架构；2026-10-17 清理清单见子目录 README） |
