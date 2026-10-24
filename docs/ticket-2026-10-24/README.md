# 工单附件目录（Cloudflare ticket 2026-10-24）

本目录是中英双版工单（`docs/CLOUDFLARE_TICKET_2026-10-24_PYODIDE_INIT*.md`）引用的**附件工件**。
数据于 2026-10-24T14:55Z 由 `scripts/check-kernel-error-rate.py` 同源 GraphQL 查询与 `cloudflare API` 拉取。

| 编号 | 文件 | 内容 | 状态 |
|---|---|---|---|
| **A2** | `A2_hourly_error_rate.csv` | `kaas` 按小时聚合（requests / errors / scriptThrewException / 错误率） | ✅ 85 小时 |
| **A5** | `A5_dependency_inventory.md` | 依赖与包体清单（pylock 哈希、源码规模、工具版本、probe 与克隆探针实测体积/startup） | ✅ |
| **A7** | `A7_edge_hourly.csv` | `kaas-edge` 对照脚本按小时（requests / errors / wallTime 分位） | ✅ 72 行 |
| **A8** | `A8_kaas_hourly.csv` | `kaas` 按小时 × 按 status，含 cpu/wallTime/memory 的 P50/P99 | ✅ 109 行 |
| **A9** | `A9_timeline.md` | UTC 事故时间线（含我们自己的部署、探针实验、缓解动作） | ✅ |
| **A1** | `A1_tail_excerpt.md` | 事故时 tail 抓到的两类异常栈（**仅摘录**；原始 JSONL 未持久化，见该文件说明） | ⚠️ 部分 |
| **A3** | 工单正文 §4.1 | 版本与部署清单 | ✅（在正文） |
| **A4** | `scripts/pyinit-probe/` + `scripts/pyinit-probe-kernel/` | 最小复现 Worker（零依赖）与真实内核克隆探针 + 压测脚本 | ✅ |
| **A6** | 工单正文 §3A–§3F | 对照实验矩阵与结果（E1/E2/E2b/E3 已跑，E4/E5 未做并如实标注） | ⚠️ 部分 |
| **A1 抓取工具** | `scripts/capture-kernel-tail.ps1` | 下次复现时一键抓 rayId/colo 的工具 | ✅（新增） |

## 关键数字（本次重查，替换正文中早期引用）

- `kaas` 峰值小时：**2026-10-24T07:00Z，scriptThrewException 2562 / 2750 请求 ≈ 93%**
- 该峰值紧跟 **2026-10-24T06:42:07Z 开始的 deploy**（commit `c25ffe36`）
- 窗口 A（10-23T00:00Z→10-24T12:00Z）：3063 / 4752 = **64.5%**

## 重新生成方式

```bash
$env:CLOUDFLARE_API_TOKEN=...; $env:CLOUDFLARE_ACCOUNT_ID=...
backend/orchestrator/.venv/Scripts/python.exe .tmp-ticket-artifacts.py   # A2/A7/A8（脚本内容见 git 历史/正文 §4）
```
