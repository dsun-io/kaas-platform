# scripts/archive —— 已退役的门禁脚本（2026-10-19 S4）

方案 B S4 把 orchestrator 业务壳删除后，worker 成为**唯一后端实现**。以下脚本失去存在前提，
移入本目录留档（不再接入 CI；保留代码是为了让后来者能看到当年的判据与允许清单）：

| 文件 | 原用途 | 退役原因 |
|---|---|---|
| `route-parity.py` | 静态解析 orchestrator 与 worker 两侧路由，要求「orchestrator 有、worker 没有」的路由必须登记 | 单应用后没有第二实现可比；S3 的 parity 测试（auth/CRM/quote 三域棘轮清零）已经承担了「行为对等」职责 |
| `route-parity-allowlist.txt` | 上述缺失路由的逐条登记（最后状态：8 条，全部为有意不做：平台运维、本地探针、OSS presign、comtrade） | 随脚本退役；内容冻结留档 |
| `export_openapi.py` | 从 orchestrator `app.main` 导出 `docs/openapi.json` | `app.main` 已删除，无法再生成；artifact 冻结作为前端契约基准（contracts R6 已退役） |

**现在的对应门禁**：`contracts:check`（前端 zod ↔ 共享内核/冻结契约快照）、
`check-schema-coverage.py`、`check-schema-drift.py`、`check-runtime-deps.py`、
`sync-shared.ps1 -Check`、worker 全量测试。

> 如果要跑 `route-parity.py` 复盘历史差异：它读同目录的 `route-parity-allowlist.txt`，
> 但 orchestrator 源码已不在，结果只反映历史，不代表当前状态。
