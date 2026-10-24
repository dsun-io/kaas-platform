# 工单提交包（可直接照做，2026-10-24 23:30）

> 用户已决定：**现在就提交**。本文件是「照做即可」的单页操作手册 + 粘贴文本 + 附件映射。
> 母版：`docs/CLOUDFLARE_TICKET_2026-10-24_PYODIDE_INIT.md`（中文，含全部证据与披露）
> 提交正文：`docs/CLOUDFLARE_TICKET_2026-10-24_PYODIDE_INIT_EN.md`（英文，直接粘贴）
> 附件工件：`docs/ticket-2026-10-24/`

## 1. 提交前 3 分钟核对

| 项 | 值 | 怎么确认 |
|---|---|---|
| Account ID | `766f8d7eb5a7d20e272673073ec8c3fd` | 已在英文正文 Environment 表里 |
| Worker | `kaas`（python_workers，无公网域名） | 同上 |
| compat | `compatibility_date=2026-09-18`、`flags=["python_workers"]` | 同上 |
| 套餐 | Workers Paid（128 MB） | 同上 |
| 优先级 | **P2 / High**（历史 30h 内 ~65% 调用失败；workaround 已缓解） | 英文正文标题 |
| 附件数 | A1（部分）/A2/A3/A4/A5/A6（部分）/A7/A8/A9 | 见 §3 |

## 2. 提交步骤

1. 打开 Cloudflare Dashboard → **Support → Contact Support → Open a case**；
2. **Product / Topic 选**：`Workers` → `Bug report`（若只有 `Technical issue` 也选它）；
3. **Severity**：`P2 - High`（若表单只给 Urgent/Normal：选 **Normal** 但在正文第一段写「production-impacting, requesting escalation to the Python Workers runtime team」——避免被按低优先级排队）；
4. **Subject**（复制）：
   ```
   P2 — Python Worker (python_workers): intermittent init failure in initPyInstance (NoGilError / "Cannot enter a promising task" SystemError) causing 502s on ~65% of invocations
   ```
5. **Description**：把 `docs/CLOUDFLARE_TICKET_2026-10-24_PYODIDE_INIT_EN.md` **从 "## Summary" 到 "## Attachments" 末尾整段**粘贴进去；
6. **Attachments**：按 §3 上传（A4 用 zip 打包两个 probe 目录 + 压测脚本）；
7. 提交后把工单号回填到 `docs/PROBLEM_STATUS_2026-10-11.md` 顶部与本文 §5。

## 3. 附件打包清单（建议命名 A1_… A9_…）

| 编号 | 来源 | 备注 |
|---|---|---|
| A1 | `docs/ticket-2026-10-24/A1_tail_excerpt.md` | **摘录**，文件里已写明「原始 JSONL 未持久化」 |
| A2 | `docs/ticket-2026-10-24/A2_hourly_error_rate.csv` | 85 小时逐时 |
| A3 | 英文正文「Deploy correlation」表 | 可另存 `A3_deploy_manifest.md`（内容即正文那张表） |
| A4 | `scripts/pyinit-probe/` + `scripts/pyinit-probe-kernel/`（**zip**） | 含 README、wrangler、`pressure.py`、容器构建配方（§3G） |
| A5 | `docs/ticket-2026-10-24/A5_dependency_inventory.md` | pylock sha256 / 体积 / 工具版本 |
| A6 | 英文正文「Control experiments」表 | E1/E2/E2b/E3 已跑（均未复现），E4/E5 标注未做 |
| A7 | `docs/ticket-2026-10-24/A7_edge_hourly.csv` | 门面对照 |
| A8 | `docs/ticket-2026-10-24/A8_kaas_hourly.csv` | 含 cpu/wallTime/memory P50/P99 |
| A9 | `docs/ticket-2026-10-24/A9_timeline.md` | 含**我们自己的部署**（主动披露） |
| 可选 | `scripts/capture-kernel-tail.ps1` | 说明我们已准备好在下次复现时抓 rayId |

## 4. 提交后 24h 内要做的（避免工单被搁置）

1. 若收到「请提供最小复现」→ 直接给 A4（已备）；
2. 若收到「beta/已知问题」→ 追问：**issue 号、受影响 runtime/pyodide 版本、官方规避（是否推荐 Durable Object/Queue 串行化冷启动）、预计修复窗口**；
3. 若收到「你们 init 太重」→ 回 A5 + E2b 实测（**同一份代码换成隔离探针、串行/并发都不崩**），请对方说明「init 重量 ⇒ promising-task SystemError」的机制；
4. 若收到「无法复现」→ 提供 A1 摘录 + A2/A8 时间窗，请他们**按同账号同窗口在内部检索 `scriptName=kaas` + `outcome=exception`**；
5. 任何回复都回填到 `docs/PROBLEM_STATUS_2026-10-11.md`。

## 5. 回填区（提交后填）

| 项 | 值 |
|---|---|
| 工单号 | _待填_ |
| 提交时间（UTC） | _待填_ |
| 优先级 | P2 / High |
| 首次回复时间 | _待填_ |
| 结论 | _待填_ |

## 6. 已如实标注的未完成项（不会给对方留把柄）

- **A1**：只有摘录，原始 JSONL 未持久化（附抓取工具）；
- **E4**（回滚 24h 对照）：未做 —— 需重部署旧版内核，属生产变更，未获批准前不做；
- **E5**（同版本成败各 5 条 ray id）：未做 —— 需要失败发生时的 ray id 样本；
- 我们在正文中**不再主张「任意 Python Worker 必现」**（E1/E2/E2b 均未复现），改为请对方判定触发条件。
