# 归档区

> ⚠️ 归档文件不反映当前架构，只读留档。

- 当前架构文档：[../WORKSTATION_DESIGN.md](../WORKSTATION_DESIGN.md)
- 约定：链接检查等文档校验**排除 docs/archive/\*\***。

## 批次一览

| 目录 | 归档日期 | 内容 | 处理方式 |
|---|---|---|---|
| [2026-09-22-pre-workstation-graph/](./2026-09-22-pre-workstation-graph/) | 2026-09-22 | 工位能力网之前的旧版 WORKSTATION_DESIGN、DEPLOY、CODEBASE_AUDIT_REPORT_2026-05-13 | 复制（原件保留原位） |
| [2026-09-30-doc-cleanup/](./2026-09-30-doc-cleanup/) | 2026-09-30 | 过时报告：SYSTEM_AUDIT（09-22 体检，整改已随 CLEANUP_LOG 阶段 0–6 执行完）、red-blue-review-20260522（5 月安全审查过程记录） | 移动归档 |
| [2026-10-12-tim-doc-prototypes/](./2026-10-12-tim-doc-prototypes/) | 2026-10-12 | 真实出口单证（Tim 单）的一次性生成/校验原型脚本（生成、导出、一致性矩阵、导出自检、公章紧裁等）；原位置 `D:\projects\报价制作\.tools\` 被 .gitignore 排除，不归档则换设备即丢 | 复制归档（原件仍在原机；公章 PNG 不入库） |

- 2026-09-30 补记：根目录 `CODEBASE_AUDIT_REPORT_2026-05-13.md` 原件已删除——其内容完整保存在 `2026-09-22-pre-workstation-graph/` 副本中（副本仅多归档横幅），不留重复件。本次清理经 `scripts/cleanup-guard.py` 门禁校验通过（3 个路径均不在保护清单内）。
