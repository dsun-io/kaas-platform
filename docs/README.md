# 文档索引 · 真相源分层

## 真相源分层（谁说了算）

| 层级 | 位置 | 作用 | 说明 |
|---|---|---|---|
| 1 | **代码库**（含 `shared/contracts` 共享契约） | 技术真相源 | 系统怎么算、怎么运转，一律以代码为准 |
| 2 | 线上数据库 | 运行数据 | 实际业务数据（客户、报价单等） |
| 3 | **Notion** | 只做任务管理 | 任务拆分与验收记录；**不是技术真相源** |
| 留档 | `CODEBASE_AUDIT_REPORT_2026-05-13.md`、`docs/SYSTEM_AUDIT.md` 等历史报告 | 历史参考 | 只读留档，不代表当前架构 |

## 常用文档

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 项目总览与协作规范 |
| [WORKSTATION_DESIGN.md](./WORKSTATION_DESIGN.md) | 工位能力网 + 情报体系 设计 |
| [SYSTEM_AUDIT.md](./SYSTEM_AUDIT.md) | 系统体检报告（2026-09-22 只读审计） |
| [CLEANUP_LOG.md](./CLEANUP_LOG.md) | 清理与优化执行日志 |
| [UNCERTAIN.md](./UNCERTAIN.md) | 存疑清单（等 David 确认） |
| [E2E_GUIDE.md](./E2E_GUIDE.md) | 端到端测试一键可跑说明书 |
| [../DEPLOY.md](../DEPLOY.md) | 部署说明（线上域名 kaas.powervoy.com） |
| [archive/](./archive/) | 归档资料（不反映当前架构） |
