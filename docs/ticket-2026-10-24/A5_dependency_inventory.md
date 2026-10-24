# A5 依赖与包体清单

> 采集时间 2026-10-24T14:55Z。命令与来源都已写明，便于 Cloudflare 核对。

## 1. 生产内核 `kaas`

| 项 | 值 | 来源 |
|---|---|---|
| 依赖锁 | `backend/worker/pylock.toml`���**66 行**，sha256 = `b3cd332c94ef0abce5a7b3eb6ca1ce9703502f0af8d786803d704978ff84dd44` | `Get-FileHash` |
| Python 源码 | **106 个 .py 文件 / 1,985,110 字节（≈1.89 MiB）** | `Get-ChildItem -Recurse` |
| 依赖（pyproject） | fastapi / asyncpg / pydantic / pyjwt / python-multipart / bcrypt>=5.0.0 | `backend/worker/pyproject.toml` |
| 运行时 | Python 3.13（pyproject `requires-python >=3.13`）；部署侧实际 pyodide 3.14.2（pywrangler 解析） | pywrangler 日志 |
| compatibility_date / flags | `2026-09-18` / `["python_workers"]` | `backend/worker/wrangler.jsonc` |
| cron | `*/15 * * * *`、`30 16 * * *`、`40 17 * * *` | 同上 |
| 内存上限 | 128 MB（Workers Paid） | 套餐 |

### 1.1 同源代码克隆探针的实测体积（我们用它做 E2b，可代表生产包体量级）

| 项 | 值 |
|---|---|
| 源码 | 同一份 209 个文件（含 `kaas_common` 镜像） |
| **上传体积** | **13171.25 KiB / gzip 3388.38 KiB** |
| **Worker Startup Time** | **3580 ms**（生产实测 2.6–3.9 s，同量级） |
| 部署工具 | `pywrangler`（uv 0.13.5、node 22.23.4、npm 10.9.9） |

## 2. 工具版本（事故发生时段）

| 工具 | 版本 |
|---|---|
| uv | 0.13.3（事故时）→ 0.13.5（2026-10-24 实验时升级） |
| node | v24.20.0（本机）；容器实验用 v22.23.4（wrangler 4.151.2 要求 ≥22） |
| wrangler | 4.151.2 |
| pywrangler | 由 `workers-py` 提供（随 `uv sync` 解析） |

## 3. 包体与 init 成本的对照（我们已做过的实验）

| 变体 | 依赖面 | 上传体积 | Startup | 并发 20 结果 |
|---|---|---|---|---|
| 零依赖 probe | 仅 workers SDK | 112.85 KiB | **427 ms** | 20/20 成功 |
| +fastapi/pydantic | 10.1 MiB | — | **620 ms** | — |
| +asyncpg/pyjwt/bcrypt/multipart | 12.4 MiB | — | **943 ms** | 20/20 成功 |
| **真实内核克隆** | 同生产（pyodide wheel） | 12.87 MiB | **3580 ms** | 15/15 成功 |

> 结论（详见工单 §3C/§3D/§3F）：**包体与 init 重量单项不足以复现该缺陷**。
