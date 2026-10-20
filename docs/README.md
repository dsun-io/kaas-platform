# 文档索引 · 交接从这里开始

> 更新时间：**2026-10-20 下午（P2 收尾后）**
> 当前状态：**前端 P0/P1/P2 已全部完成**（报价工位重构、a11y/1366、P2 增强）；**后端 5 项并行任务进行中**（见 `UI_BACKEND_DEPENDENCIES_2026-10-20.md`）。
> 历史文档已分批归档到 [`archive/`](./archive/)；**不要用归档文档判断当前口径**。

## 0. 交接 agent 先读（按顺序）

| 顺序 | 文档 | 读它来回答什么 |
|---|---|---|
| 1 | [../README.md](../README.md) | 架构、三环境隔离矩阵、方案 B 决策、冷启动线、测试与门禁（**主交接/唯一权威**） |
| 2 | [HANDOVER_2026-10-20_FINAL.md](./HANDOVER_2026-10-20_FINAL.md) | 最新交接：S5 预览、云资源、发布检查单、踩坑、待办 |
| 3 | [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 滚动问题状态（顶部按时间倒序，含 UI P2 记录） |
| 4 | [TODO.md](./TODO.md) | **活跃待办唯一账本**（A 单证 / B 产品 / C 其他 / D 发布 / E UI） |
| 5 | [UI_UX_OPTIMIZATION_2026-10-20.md](./UI_UX_OPTIMIZATION_2026-10-20.md) | UI 现状、§9 路线、§10 报价重构、§11 终验 |
| 6 | [UI_BACKEND_DEPENDENCIES_2026-10-20.md](./UI_BACKEND_DEPENDENCIES_2026-10-20.md) | 后端 5 项接口/验收基线（并行任务中） |

## 1. 真相源分层（谁说了算）

| 层级 | 位置 | 作用 |
|---|---|---|
| 1 | **代码库**（含 `shared/contracts`） | 技术真相源：怎么算、怎么运转一律以代码为准 |
| 2 | 线上数据库 | 运行数据 |
| 3 | Notion | 只做任务管理，不是技术真相源 |
| 留档 | `docs/archive/` | 只读历史，不代表当前架构 |

## 2. 当前权威与运行手册

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 主交接（**唯一权威**） |
| [HANDOVER_2026-10-20_FINAL.md](./HANDOVER_2026-10-20_FINAL.md) | 2026-10-20 最终交接 |
| [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) | 问题状态滚动口径 |
| [TODO.md](./TODO.md) | 活跃待办唯一账本 |
| [ENV_VERIFICATION_2026-10-19.md](./ENV_VERIFICATION_2026-10-19.md) | 三环境配置核对 + 发布前检查单/回滚 |
| [UNCERTAIN.md](./UNCERTAIN.md) | 决策账本（存疑/裁决落盘） |
| [QA_TEST_ACCOUNTS.md](./QA_TEST_ACCOUNTS.md) | 测试账号与验收口径 |
| [E2E_GUIDE.md](./E2E_GUIDE.md) | e2e 一键运行说明 |

## 3. UI/UX（本轮主线）

| 文档 | 内容 |
|---|---|
| [UI_UX_OPTIMIZATION_2026-10-20.md](./UI_UX_OPTIMIZATION_2026-10-20.md) | 全系统 UI/UX 方案；P0/P1/P2 已完成，§11 为终验结论 |
| [UI_BACKEND_DEPENDENCIES_2026-10-20.md](./UI_BACKEND_DEPENDENCIES_2026-10-20.md) | 后端 5 项依赖（并行任务中；完成前不动前端业务逻辑） |

## 4. 业务/设计参考（仍有效）

| 文档 | 内容 |
|---|---|
| [WORKSTATION_DESIGN.md](./WORKSTATION_DESIGN.md) | 工位能力网设计 |
| [PLATFORM_UPGRADE_PLAN.md](./PLATFORM_UPGRADE_PLAN.md) | 平台升级方案（客户主线） |
| [TEAMS_AND_VISIBILITY.md](./TEAMS_AND_VISIBILITY.md) | 团队与数据可见性（三层组织规则） |
| [CUSTOMER_DOCUMENTS_VIEW.md](./CUSTOMER_DOCUMENTS_VIEW.md) | 客户单据视图 |
| [PRODUCT_MEDIA_STORAGE_PLAN.md](./PRODUCT_MEDIA_STORAGE_PLAN.md) | 产品媒体存储方案 |
| [PRODUCT_CONFIG_TENANT_UNFINISHED.md](./PRODUCT_CONFIG_TENANT_UNFINISHED.md) | 租户级产品配置化未竟清单 |
| [TRADE_DOC_TEMPLATES.md](./TRADE_DOC_TEMPLATES.md) | 单证模板规范 |
| [TRADE_DOC_PDF_ARCHIVAL.md](./TRADE_DOC_PDF_ARCHIVAL.md) | 单证 PDF 留档与对账 |

## 5. 归档入口（历史留档，不代表当前架构）

| 位置 | 内容 |
|---|---|
| [archive/2026-10-20-p2-closeout/](./archive/2026-10-20-p2-closeout/README.md) | **2026-10-20 下午批**：方案 B/S4/技术栈/安全/税务/批量报价/旧 e2e/旧实现地图等 15 份已完成或已被取代文档 |
| [archive/2026-10-20-closeout/](./archive/2026-10-20-closeout/README.md) | 2026-10-20 收尾批：A′ 计划、PPG 迁移、历史交接/部署/模块计划等 22 份 |
| [archive/2026-10-19-master-exec/](./archive/2026-10-19-master-exec/) | 契约与 mock 既定决策（已归档） |
| [archive/2026-10-17-doc-cleanup/](./archive/2026-10-17-doc-cleanup/README.md) | 2026-10-17 清理批 |
| [archive/](./archive/) | 更早归档批次（2026-09 等） |

## 6. 维护规则

- 新文档先判断：**当前权威 / 运行手册 / 历史证据**。历史证据直接进 `archive/<日期>-<批次>/`，并在本页登记。
- 改代码必须同步改文档并 push `main`（`AGENTS.md` 规则 1）。
- 归档文档内链可能仍指向旧相对路径；链接检查**排除 `docs/archive/**`**，以本页和 `archive/README.md` 为准。
