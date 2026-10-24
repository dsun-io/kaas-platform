# 服务器选型评估：Python 内核脱离 Cloudflare Python Worker 硬限制（2026-10-24）

> **状态：决策支持文档 · 未实施。** 本文只回答「如果租服务器，最低租什么配置才能保证系统与后续系统的稳定运行」，
> 不包含任何采购、部署或代码改动。
> 关联：[INCIDENT_2026-10-24_KERNEL_502.md](./INCIDENT_2026-10-24_KERNEL_502.md)（本次事故取证）·
> [ARCH_AUTH_DB_SPLIT_2026-10-24.md](./ARCH_AUTH_DB_SPLIT_2026-10-24.md)（认证/DB 拆分方案）·
> [ARCH_DECISIONS.md](./ARCH_DECISIONS.md)（ADR-004 连接口径 / ADR-007 Neon 新加坡 / ADR-008 两层架构）·
> [OPTIMIZATION_PLAN_2026-10-21.md](./OPTIMIZATION_PLAN_2026-10-21.md)。
> 数据日期 **2026-10-24**：负载为**本机真实依赖实跑**（Ryzen 5 6600H / Windows / CPython 3.14），
> VPS 单核性能按 **×1.4** 折算；价格为当日官网抓取，取不到的明确标「需核实」。

---

## 0. 结论（TL;DR）

- **最低「保证稳定」配置 = 2 vCPU / 4 GB RAM / 60 GB NVMe / 2.5–3 TB 流量 / 新加坡机房**
  （KVM、Ubuntu 24.04 LTS、**x86_64**），另加 **2–4 GB swap**。月成本 **$9–20（≈¥65–145）**。
- **1C2G 能跑当前负载，但不满足「保证稳定」**：实测进程基线仅 67 MB，可单核会被 18 s 级 xlsx 导入、
  部署、备份完全阻塞；2 GB 在最坏单请求峰值 314 MB 与「未来本地嵌入/同机 PG」前没有余量。
- **要把 Postgres / 本地 PDF 渲染 / 本地向量模型也搬上同一台 ⇒ 直接 4C8G**，不要在 2C4G 上叠加。
- 服务器只解决「Python 运行时」的墙；**门面 `kaas-edge`、TLS、DDoS、静态资产必须继续留在 Cloudflare**，
  否则 2026-10-21 迁新加坡（RTT 245→75 ms）换来的体验会一起丢掉。
- 先决条件：若账户仍是 **Workers Free**，**$5/月 Workers Paid** 能拆掉 CPU 10 ms / subrequest 50 / cron 10 ms
  三道墙（但治不了 128 MB 内存与 Pyodide init bug）。认证/DB 拆分的 **P0 已于 2026-10-24 灰度上线**，
  控制台热读已不依赖 Pyodide（见 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 交接摘要）。

---

## 1. 触发背景：现在撞的是哪几堵墙

### 1.1 2026-10-24 生产事故（已实证）

| 事实 | 数值 | 出处 |
|---|---|---|
| 内核 `scriptThrewException` | **3030** 次；当日成功率 ≈44%，错误率 **≈56%** | [INCIDENT_2026-10-24_KERNEL_502.md](./INCIDENT_2026-10-24_KERNEL_502.md) §1.2 |
| 门面 `kaas-edge` | 1821 请求 **0 错误**（故障源 100% 在内核） | 同上 |
| 异常位置 | 24/24 全在 `initPyInstance`（Pyodide 初始化），栈里无业务帧 | 同上 §1.3 |
| 内存分位 | success 的 `memoryUsageBytes` P99 **137.5 MB**，Workers 上限 **128 MB** | 同上 §1.4 |
| 冷启动成本 | 成功请求 `wallTimeP50` 最低 **5987 ms**（几乎每次请求都在付初始化成本） | [ARCH_AUTH_DB_SPLIT_2026-10-24.md](./ARCH_AUTH_DB_SPLIT_2026-10-24.md) §0 |

### 1.2 平台硬限制（官方口径）

| 限制项 | 数值 | 备注 |
|---|---|---|
| CPU 时间（HTTP） | Free **10 ms/请求**；Paid 默认 **30 s**，可配到 5 min | 本项目重接口（报价验算 0.2 s、xlsx 导入 18 s）在 Free 档必然 1102 |
| CPU 时间（Cron） | Free **10 ms**；Paid 30 s（间隔 <1 h）/ 15 min（≥1 h） | 归档/指纹对账是遍历任务 |
| 内存 | **128 MB/isolate**（Free/Paid 相同） | P99 已 137.5 MB |
| 单请求出站连接 | **6 条**；Free subrequest **50/请求**（Paid 10,000） | 现有代码「每次 DB 调用一条连接」，`render-data` 一次 10–15 条 |
| 包支持 | 纯 Python + PyEmscripten wheel + Pyodide 内置包；`threading` 不可用 | openpyxl/pandas 等原生包装不上 |
| 冷启动 | 由 Pyodide 架构决定；仓库实测 p50 ≈2.7 s，生产 wall P50 最低 5.99 s | Paid 不会更快 |

> **Free 档前提**：仓库记录账户订阅只有 `teams_free` 与 `r2_paid`（price 0），判定为 Free；
> **本次未调 Cloudflare API 复核**。若已升 Paid，CPU/subrequest/cron 三行按 Paid 口径重算（内存/冷启动不变）。
> 核对方法：Dashboard → Workers & Pages → Plans，或 GraphQL `workersInvocationsAdaptive` 看 `cpuTimeP50`。

### 1.3 租服务器能解决 / 不能解决

| ✅ 能解决 | ❌ 不能解决 |
|---|---|
| CPU 截断（10 ms）、1102 | Anycast 边缘与就近执行 |
| 128 MB 内存墙 | TLS 证书签发/续期、**L3–L7 DDoS**（CF 对所有档免费不限量） |
| Pyodide init bug 导致的间歇 502 | 免运维弹性、按请求计费 |
| 冷启动（常驻进程，0 冷启） | R2 `FILES` / `BROWSER` quickAction / `ASSETS` / Hyperdrive 池化 / Service Binding 零成本互调的**替代成本** |
| 原生 wheel：pandas/numpy/lxml/Pillow/uvloop、异步 ORM、threading | 迁移工程与契约风险（284 route、1854 条 worker 测试、双 Worker 发布纪律） |
| cron 长任务、真正的连接池/出站并发 | |

---

## 2. 负载实测：配置由「峰值」而不是「均值」决定

> 方法：`backend/worker/.venv`（真实依赖 fastapi 0.141 / asyncpg 0.31 / pydantic 2.12 / pyjwt / bcrypt 5.0）+
> stub `workers` 模块后 `import main`；引擎/解析函数直接实跑。脚本临时放在 `%TEMP%`，未写入仓库。
> 复跑方法见附录 A。廉价 VPS 单核 ≈ 本机 0.6–0.9 倍，下表 CPU 数字乘以 **1.4**。

| 指标 | 实测值 | 说明 |
|---|---|---|
| import 全部 284 条 route（进程基线） | **+51.7 MB / 0.96 s**（总 RSS 67.0 MB） | 对比 Pyodide import 4.7 s |
| uvicorn 单 worker 稳态 | **75–100 MB** | 基线 + loop/缓冲/日志 |
| 报价 `calculate-internal` 全套 | **0.20 s / 0.28 MB** | VPS ≈0.28 s |
| `/export-quote/verify` | 0.16 s | |
| bcrypt 登录（cost 12） | **194 ms**（VPS ≈270 ms） | 早高峰并发登录会排队 |
| xlsx 批量导入 2000×12 / ×30 / ×200 | **668 ms / 1.76 s / 18.3 s**；峰值 **19.6 / 46.8 / 313.7 MB** | 唯一能吃掉多秒 CPU 的路径 |
| CSV 导入 2000 行（对照） | 18 ms / 1.6 MB | |
| 文件上传内存 | 文件的 **2–3 倍**（上限 16 MB ⇒ ≈48 MB；render_pdf 32 MB ⇒ ≈96 MB） | `await file.read()` 整块进内存 |
| 文件下载 | 文件的 **1 倍**（上限 32 MB，无流式） | 建议继续走 R2 预签名直链 |
| PDF（BROWSER binding） | 典型 5 MB，上限约 70 MB | 渲染在 CF 侧，本地只中转 |
| 归档 cron（编码阶段） | 1k 事件 48 ms / 10k 0.44 s / 50k 3.0 s，峰值 8.9 / 45 MB | `SELECT` 目前**无 LIMIT** |
| 当前真实流量 | **≈4.5k 次/天 ≈ 0.05 rps** | 事故当日内核调用计数 |
| 仍由内核执行的路由 | **117 条**（87 前缀透传 + 30 显式转发） | P0 拆分后热读已减，但计算面仍在 |

**关键结构事实**：服务端**不生成 xlsx**（Worker 无 openpyxl，`format=xlsx` 直接 501，模板由前端 exceljs 生成）；
PDF 由 Cloudflare Browser Rendering 渲染；文件字节走 R2/S3。因此**内存压力主要来自上传/导入/PDF 中转与 Pyodide 本身，
而非业务计算**——这正是 CPython 化后基线能降到 67 MB 的原因。

---

## 3. 最小配置推导（为什么是 2C4G）

| 项 | 最低 | 建议 | 依据 |
|---|---|---|---|
| vCPU | **2** | 2 | 单核遇 26 s（VPS 折算）xlsx 导入 / 0.28 s 报价 / 部署 / 备份就全站排队；2 核 + 导入信号量=1 可让另一核继续服务 |
| RAM | **4 GB** | 4 GB | 2 worker ≈180 MB + OS/Tunnel/Caddy/监控 300–400 MB + 最坏峰值 314 MB + 页缓存 ⇒ 峰值 ≈1.4 GB；4 GB 留 2.5 GB 余量 |
| 磁盘 | 40 GB | **60–80 GB NVMe** | OS 8 + venv/依赖 2 + 日志 10 + 快照/备份 20 + swap 4 ≈ 44 GB |
| 流量 | 1 TB | **2.5–3 TB** | 文件走 R2 预签名直传，不过服务器；实际月流量 <100 GB |
| 地区 | — | **新加坡**（次选香港） | Neon 生产库在 `aws-ap-southeast-1`；同区 DB RTT 1–5 ms，香港 30–40 ms，欧洲/美西 200 ms+ |
| 虚拟化/系统 | KVM | KVM / Ubuntu 24.04 LTS / **x86_64** | 避免 ARM wheel/CI 对齐问题 |
| swap | 2 GB | 2–4 GB | 吸收偶发峰值，避免 OOM killer |

**为什么不是 1C2G**：当前 0.05 rps 确实跑得动，但「保证稳定」要求最坏路径不拖垮全站——
xlsx 宽表导入在 VPS 上约 26 s、部署重建 venv 约 1 GB 峰值、备份/日志轮转都会抢核；
2 GB 在最坏峰值（≈1 GB 常驻 + 314 MB 请求 + 构建）时已无余量，swap 抖动会直接表现为接口超时。

**什么时候必须 4C8G**（任一踩中即选 4C8G，别在 2C4G 上叠）：
1. 把 Postgres 也搬上同一台（+512 MB–1 GB、+磁盘、+运维，且要自己做 PITR/备份）；
2. 自己出 PDF（本地 Chromium，**+300–800 MB 常驻**，2C4G 立刻变紧）；
3. 上本地小嵌入模型/向量检索（+250–500 MB）；
4. 未来 12 个月用户/单据量翻几倍，不想再迁一次。

> 本地 7B 级大模型**不在本命题内**：需 ≥16–24 GB 显存 GPU，租用价 $300+/月，远高于「走远程 LLM API」（现状即是）。

---

## 4. 机型与价格（2026-10-24 抓取，**需下单页复核**）

| 方案 | 配置 | 月价（性质） | 机房 | 说明 |
|---|---|---|---|---|
| **腾讯云 Lighthouse 国际** | 2C/4G/90G SSD/2.5 TB | **≈$8.5**（常态） | HK / SG / 东京 / 首尔等 | 最低价；SG 区同价与库存需核实 |
| 阿里云 SWAS | 2C/4G/50G | ≈$16（常态） | 香港 / 新加坡 | 有 9.9/年新客促销，续费按常态 |
| **Vultr** | 2C/4G/80G/3 TB | **$20**（官方 API 价） | 新加坡 / 东京等 | 与 Neon 同区，最稳 |
| 阿里云 SWAS 香港 | 4C/8G/70G | $32 | 香港 / 新加坡 | 未来升级档 |
| Vultr | 4C/8G/160G/4 TB | $40 | 新加坡 | 未来升级档 |
| Contabo Core 4 | 4C/8G/100G/200 Mbit | €5.50（1 月期） | 欧洲/美洲/亚洲/澳洲 | **不推荐**：欧洲机房，大陆回源 250–350 ms、到 Neon SG 200 ms+ |
| Hetzner CX23 | 2C/4G/40G NVMe | €5.99 | 仅欧洲（共享型当前售罄） | **不推荐**：同上的延迟问题；CX22/CPX11 已停产 |

**选址结论**：内核与 Neon 必须同区配对（HK/SG ↔ Neon 新加坡）；大陆用户经 CF 边缘（HK/JP/SG PoP）回源，
新加坡综合最优（DB 1–5 ms、用户 60–100 ms），香港在「DB 查询少的路径」更接近大陆（30–60 ms）。
**不要选欧洲/美西**——会把 ADR-007 的 RTT 优化（245→75 ms）反向回滚。

---

## 5. 「稳定」的 6 个前置改造（不满足则 8 GB 也会翻车）

1. **DB 连接池**：现在每个 DB 调用新建一条 asyncpg 连接（Hyperdrive 在 CF 侧池化），`render-data` 一次 10–15 条。
   迁到 VPS 必须改为进程内 `asyncpg.Pool`（每 worker max 8；Neon 用 `-pooler` 主机名），
   并反转 [ADR-004](./ARCH_DECISIONS.md) 的「每请求直连」结论（其重评条件②已成立：建连 467 ms）。
2. **修阻塞 IO**：`backend/worker/src/chain.py` 的 AI 调用（30 s 超时）与网页抓取（15 s）在 async 函数里同步跑
   `urllib` —— 在 uvicorn 下会**卡死整个 worker 的事件循环**（Workers 里走 `js.fetch` 所以未暴露）。
   必须 `asyncio.to_thread` 或换 httpx。
3. **xlsx 导入并发闸门=1**：单次 18 s CPU / 314 MB，2 核上两个并发即全站不可用。
4. **归档 cron 补 LIMIT/分页**：`ws_cron.py` 的 events 归档 `SELECT` 无上限，事件量涨 10 倍就是 OOM。
5. **文件必须继续留 R2/S3**：`S3_ACCESS_KEY` / `S3_SECRET_KEY` 未配时 `ws_files.py` 会退化为把字节写进 PG
   （16 MB 附件进库），磁盘与 DB 都会膨胀；上线前必须验证 S3 预签名链路真实可用。
6. **PDF 不要本地渲染**：继续用 Cloudflare Browser Rendering REST（需 `Browser Run - Edit` 权限的 token）；
   本地 Chromium 是 2C4G 最大的变数（+300–800 MB）。

**运维底线**：2 GB swap、systemd 自动重启、**带真实 JWT 的外部健康探针**（事故里匿名 `/health` 全程 ok，
是本次最大的监控教训）、每日快照 + `pg_dump → R2`、SSH 仅密钥 + ufw 只放 22（或只走 Cloudflare Tunnel 出站、不开 80/443）、
fail2ban + unattended-upgrades、日志轮转与 Sentry 可选接入。

---

## 6. 目标架构与迁移清单（若拍板执行）

```
浏览器
  → Cloudflare（kaas-edge：TLS / DDoS / 静态资产 / 鉴权 / 大部分 CRUD）
  → Cloudflare Tunnel（cloudflared 出站，不暴露公网 IP）
  → 服务器 Caddy → uvicorn ×2（kaas 内核：117 条计算/透传路由）
  → Neon 新加坡（-pooler + 连接池）
  → R2 / S3（预签名直传与直链，字节不过服务器）
  → Cloudflare Browser Rendering（PDF）
  → systemd timers（3 条 cron）
```

### 6.1 Binding → 自建替代

| 现在（Worker binding） | VPS 上替代 | 改动点 |
|---|---|---|
| `HYPERDRIVE` | `DATABASE_URL`（Neon `-pooler`）+ asyncpg Pool | `main._acquire` / `platform/db.py` |
| `FILES`（R2 binding） | S3 SDK / 预签名（R2 endpoint 不变） | `ws_files.py` 存储分支 |
| `BROWSER`（quickAction） | Browser Rendering REST + token | `ws_files.py` `_render_pdf_bytes` |
| Service Binding（`env.KERNEL`） | Tunnel hostname + Cloudflare Access service token / mTLS | `backend/ts-worker/src/proxy.ts` |
| Cron Triggers（3 条） | systemd timers → 本机内部端点（带内部 token） | `ws_cron.py` 调度入口 |
| `ASSETS`（frontend/out） | 不动：仍由 `kaas-edge` 伺服 | — |

### 6.2 迁移工作量与风险

- **应用层不用重写**：`backend/worker/src/local_run.py` 已证明同一份 `main.py` 可在 uvicorn 下跑，
  需要补一个生产 ASGI 入口（把 `request.scope["env"]` 的取数改为 `os.environ` / 池注入）。
- **发布流水线**：GitHub Actions → SSH/rsync 或 Docker 镜像 + `systemctl restart`；`wrangler` 仅保留门面发布。
- **门禁口径**：`check-worker-bundle` 的包体积/冷启动门禁对内核失效，需改为镜像体积/启动探针；
  `check-deploy-domains` / 双 Worker 发布纪律需新增「内核回源域名不公开」的断言。
- **单点故障**：1 台 = SPOF。恢复靠快照 + 重建（**RTO 10–30 min**），DB 侧 Neon Launch 有 7 天历史/instant restore
  （RPO 分钟级），文件侧靠 R2 版本。要更高可用：2 台 + Cloudflare Load Balancer（+$8.5–20/月 + $5）。
- **回退**：保留 `kaas` Python Worker 部署能力与 DNS/Tunnel 双路径，灰度按路由前缀切流；`AUTH_DB_SPLIT` 开关同理。

---

## 7. 成本测算

| 方案 | 月成本 | 解决 | 不解决 |
|---|---|---|---|
| **升 Workers Paid** | **$5** | CPU 10 ms→30 s、subrequest 50→1 万、cron→30 s/15 min | 128 MB、冷启动、Pyodide init bug |
| **执行认证/DB 拆分**（已在进行） | 工时 | 用户能否打开页面不再依赖 Pyodide（P0 已上线） | 内核计算端点仍会 502 |
| **2C4G VPS（本文）** | **$10–22**（VPS $8.5–20 + 备份 $1–2；Neon 用 Free scale-to-zero） | 全部 Python 运行时限制 | 边缘/TLS/DDoS/生态绑定仍需自建或保留 CF |
| 同上 + Neon Launch | **$30–42** | DB 常醒（无 0.5 s 唤醒） | 同上 |
| 4C8G VPS | $32–40 +（Neon 视口径） | 同机 PG / 本地 Chromium / 本地嵌入 | 本地大模型需 GPU |
| Cloudflare Containers | **≈$66 + $5**（2C8G 常驻估算） | 免运维 | 常驻贵 5–8 倍、实例上限 4C/12G、临时磁盘、会休眠 |

**Neon 两种口径**（决定 VPS 总成本）：
- **省钱口径**：连接池 `min_size=0`、保留 Free 的 scale-to-zero；首查约 0.5 s 唤醒，需实测 CU-h 消耗
  （Free 100 CU-h；0.25 CU 常驻 24/7 = 182.5 CU-h，不可常醒）。
- **稳定口径**：Neon Launch（0.25 CU ≈$19.4/月、0.5 CU ≈$38.7/月），关闭 scale-to-zero，DB 永远在线。
- 注意：Free 项目自 2026-10-05 起 90 天不活跃可能被删；本项目有日流量，不构成风险。

---

## 8. 决策路径（建议）

1. **今天**：核对 Cloudflare 账户 plan。若是 Free → 先开 **$5 Workers Paid**（随时可停），
   并核实 3 条 cron 最近一次成功记录（Free 档 cron 同样只有 10 ms CPU，归档/对账可能一直没真正跑完）。
2. **本周**：推进已定稿的 [认证/DB 拆分](./ARCH_AUTH_DB_SPLIT_2026-10-24.md) P0→P3（P0 已上线），
   把「用户能否打开页面」与 Pyodide 彻底解耦。
3. **若 1–2 周内仍出现 `kernel_unavailable` 502，或需要重计算/大内存/原生包**：按本文 2C4G 清单租新加坡机器，
   先灰度迁「重活」（PDF / 报价验算 / xlsx 导入 / cron），再决定是否整内核搬迁。
4. **不要**为省几美元选欧洲最便宜机（Contabo/Hetzner）——DB 延迟回 200 ms 等于把上次优化作废。

---

## 9. 证据边界与待核实（不编造）

- **账户 plan**：Free 来自仓库文档记录（`teams_free` / `r2_paid`，price 0），**未调 CF API 复核**。
- **价格**：为 2026-10-24 官网/官方 API 抓取值；DigitalOcean / OVH 官网 JS 渲染未取全，标「需核实」；
  Hetzner 共享型库存与 SIN1 CPX 价格未核实；Netcup 价格取自第三方（2026-07-23），含税口径未核实。
- **RTT**：均为经验量级，上线前应在候选机房用 `mtr -rwzbc 100` 实测到大陆三网与 Neon 区域。
- **Python Workers GA**：官方博客正文未取到，依据官方博客列表条目 + 文档无 beta 标注；
  **无官方 Pyodide ↔ compatibility_date 对照表**（3.14 由 `pylock.toml` 的 cp314 wheel 推得）。
- **Browser Rendering 配额**：仓库记「Free 10 分钟/天、3 并发」，本次未复验。
- 负载数字与本机硬件相关；换机/换 OS 后建议按附录 A 复跑一遍再下单。

---

## 附录 A：复跑方法（无需 Docker / 网络）

```powershell
# 1) 进程基线：stub workers 后 import main，读 WorkingSet64
#    注意：先 import 标准库 platform，避免被 src/platform 遮蔽
$py = "backend/worker/.venv/Scripts/python.exe"
# 脚本见本文提交说明；核心逻辑：
#   import platform; sys.path.insert(0, src); stub workers;
#   import main; 读 Get-Process -Id $pid 的 WorkingSet64  → 实测 67 MB

# 2) 引擎耗时：直接调用 kaas_common.export_quote 的 build / verify_all /
#    build_customer_view / build_internal_view（make_request_from_config 的 fx.rate 必须是数值）
#    → build 23 ms / verify_all 97 ms / calculate-internal 全套 0.20 s

# 3) xlsx 解析：kaas_common.export_quote.xlsx.read_xlsx(bytes)
#    → 2000×12 / ×30 / ×200 = 668 ms / 1.76 s / 18.3 s；峰值 19.6 / 46.8 / 313.7 MB
```

> **维护**：若后续拍板执行迁移，需同步更新 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md)、
> [TODO.md](./TODO.md)、发布流水线与 `AGENTS.md` 的部署纪律（内核不再只有 `wrangler deploy` 一条发布路径）。
