# Cloudflare 工单证据包（v2，2026-10-24 22:00 重写）

> Python Workers 初始化期崩溃（NoGilError / Pyodide promising-task SystemError）
> **v2 修订说明**：按独立审阅意见重写了数字口径（原文 §1 的 56% 与 §4 表的 4456/4475 混用，是两个不同窗口且数据已增长）、
> 把「复现」拆成「Cloudflare 可执行的最小复现」与「我方黑盒复现」、补 §3A 对照实验与 §8 主动披露、
> 内存改为「风险因子」而非因果、删掉 §9.3 的逆否误推。**所有数字均由 2026-10-24T13:5xZ 重新查询 GraphQL 得到（见 §4）。**

## 0. 环境与影响面（工单第一屏）

| 项 | 值 |
|---|---|
| Account ID | `766f8d7eb5a7d20e272673073ec8c3fd` |
| Python Worker | `kaas`（template `python_workers`，**无公网域名** `routes: []`） |
| 调用路径 | `kaas-edge`（TS Worker）→ **Service Binding** → `kaas`（binding URL `https://kernel.internal`） |
| compatibility_date / flags | `2026-09-18` / `["python_workers"]` |
| Workers 套餐 | Paid（内存上限 128 MB） |
| cron triggers（内核） | `*/15 * * * *`、`30 16 * * *`、`40 17 * * *`（**cron 也会触发 Pyodide init 并计入下文数字**） |
| 影响面 | 前端**需要调用 Python Worker** 的请求成片 502；认证与大部分读已由 TS 门面承担，全程健康 |
| 我们的 workaround | ① 门面对幂等 GET 做最多 5 次退避重试（窗口 ≈4.4s）；② 持续把端点从 Python Worker 迁到门面（本周期已迁 40+ 条） |
| 期望响应 | 是否**已知缺陷** + 官方规避手段 + 修复窗口；请求转 Python Workers 运行时团队 |

## 1. 一句话描述

生产 Python Worker 在**实例初始化阶段**（`initPyInstance` / `preparePython`）间歇抛错，栈里**没有任何应用代码帧**，
运行时自己报 `This is a bug in Pyodide`；同一分钟、同一 URL 的请求 502 与 200 交替出现，约 10 分钟后自愈无部署。

## 2. 我们看到的现象

1. **两类异常，都发生在 init 阶段**：
   - `NoGilError: Attempted to use PyProxy when Python GIL not held`（`preparePython` → `python_getattr`）
   - `PythonError/SystemError: Cannot enter a promising task from inside another running promising task. This is a bug in Pyodide.`（`doPyCallHelper` → `initPyInstance`）
   - 两者是否同根因**我们不知道**，请协助判定（第二类读起来像**重入**）。
2. **同版本、同分钟、同 URL 成败交替**：`GET https://kernel.internal/api/v1/products` 在一分钟内 502/200 交替，10 分钟后无部署自愈。
   ⇒ 这排除了「代码逻辑必定失败」。
3. **匿名健康探针全程 200**（`GET /health`），所以我们的监控当时没报警 —— 这也是我们要补的监控盲区（已加真实 JWT 的错误率门禁）。
4. **采集方法（诚实边界）**：§3 的样本来自**单次 `wrangler tail` 会话**，且当时门面重试正在放大流量；
   24 条是**观察到的全部**异常（并非抽样后挑出的），但样本量小、时窗短 —— 我们会在 A1 补 100+ 条对照与更大样本。

## 3. 异常原文（完整 JSON 行见 A1）

```json
{
  "outcome": "scriptThrewException",
  "scriptName": "kaas",
  "eventTimestamp": "<A1 内逐条>",
  "event": { "request": { "url": "https://kernel.internal/api/v1/products" } },
  "exceptions": [{
    "name": "NoGilError",
    "message": "Attempted to use PyProxy when Python GIL not held",
    "stack": "throw_no_gil (pyodideRuntime-internal) -> python_getattr -> preparePython -> initPyInstance"
  }]
}
```
```json
{
  "name": "PythonError",
  "message": "SystemError: Cannot enter a promising task from inside another running promising task. This is a bug in Pyodide.",
  "stack": "new_error (pyodideRuntime-internal:emscriptenSetup) -> wasm-function[275] -> callPyObjectKwargsPromising -> doPyCallHelper -> initPyInstance"
}
```
```
两类栈的共同点：**入口都是 `initPyInstance`，终点都在 pyodideRuntime-internal**，中间无 `kaas_common/**`、无 `main.py` 帧。
```

## 3A. 对照实验（A6；**未完成项如实标 pending**）

| # | 实验 | 目的 | 状态 |
|---|---|---|---|
| E1 | 最小 `python_workers` Worker（同账号/compat_date/flags、**零业务依赖**）压测 | **去掉我们的代码是否仍崩**（决定「平台缺陷 vs 我们的包体」） | ✅ **已跑**：见 §3C（结果：**不复现**） |
| E2 | 依赖二分：hello-world → +fastapi/pydantic → +asyncpg → +PyJWT/bcrypt → 全量 `python_modules` | init 崩溃是否依赖我们的依赖面 | **下一步（E1 结果指向这里）** |
| E3 | 串行 vs 并发冷启动 | 验证 `promising task` 的**重入**假设 | ✅ **已跑**：见 §3C（结果：**不复现**） |
| E4 | 把内核回滚到事故前版本观察 24h | 控制「我们 06:49Z 部署」这个混淆因子 | **未做（如实披露，见 §8.1）** |
| E5 | 同版本、同 5 分钟窗口内：失败 5 条 + 成功 5 条（含 ray ID） | 证明「同代码既有失败也有成功」 | pending（A1 已有 24 失败，缺成功对照） |


### 3C. E1/E3 实测结果（2026-10-24T13:52Z，**零业务依赖的最小 probe**）

**probe 配置**（源码与会话已入库：`scripts/pyinit-probe/`，可作附件 A4）：
- worker 名 `kaas-pyinit-probe`；`compatibility_date=2026-09-18`；`compatibility_flags=["python_workers"]`；
- `dependencies = []`（**不 import 任何 kaas 模块**），handler = `WorkerEntrypoint.Default.fetch` 返回一行 JSON；
- 无 routes / 无 cron / 仅 `workers_dev`；部署后 **Worker Startup Time 465 ms**、上传 111.78 KiB（gzip 31.87 KiB）。

**压测结果**（`scripts/pyinit-probe/pressure.py`，带稳定 UA 绕过 workers.dev 的 1010 拦截）：

| 组别 | 请求数 | 成功 | 失败 | 耗时 | 异常签名 |
|---|---|---|---|---|---|
| **串行**（间隔 1s） | 8 | **8** | 0 | 12.7 s | 无 |
| **并发**（同一瞬间） | 20 | **20** | 0 | 1.4 s | 无 |

**结论（必须谨慎表述）**：
1. 在**零业务依赖 + 小包体（111 KiB）**的 Python Worker 上，串行与并发压测**都没有复现** `initPyInstance` 类异常；
2. 因此本工单**不能**断言「任何 `python_workers` Worker 在初始化时必现该缺陷」；
   更可能的解释是：**触发条件与 init 的重量/依赖面有关**（我们生产内核：`python_modules` 11.79 MiB / 606 文件、~800 KB 源码、冷启动 2.6–3.9 s，
   而 probe 仅 111 KiB / 465 ms 启动）⇒ 下一步是 **E2 依赖二分**，找出从哪一档开始出现异常。
3. **方法学边界（我们主动说明）**：本轮并发压测的 isolate 可能已被 warmup 预热，「严格冷启动」需要等 isolate 回收（分钟级）后再打；
   我们会补一组「长时间空闲 → 首请求」的对照，并在 E2 里同时记录每档的 startup 时间与失败率。

**对工单诉求的影响**：第 1/3 问仍然成立（是否已知缺陷、两类异常是否同根因），但我们在正文中**不再暗示**「任意 Python Worker 必现」；
改为请 Cloudflare 判定「**init 成本/依赖面到何种程度会触发**」，并给出 128 MB 与 init 峰值的关系（第 4 问）。


### 3D. E2 依赖二分（2026-10-24T14:05Z，本地 wrangler 部署同一 probe）

同一份 probe 源码（handler 在模块导入期**尽力 import** 生产内核的主要依赖，缺包则跳过并回报），逐档加重后重新部署压测：

| 档 | `python_modules` 内容 | 上传体积 | **Worker Startup Time** | 串行 | 并发 20 | 实际 import 成功 |
|---|---|---|---|---|---|---|
| V1 | 仅 `workers-runtime-sdk` | 112.85 KiB | **427 ms** | 8/8 | 20/20 | jwt、multipart 都没有 |
| V2 | + fastapi + pydantic | 10372.94 KiB (~10.1 MiB) | **620 ms** | — | — | 见下 |
| V3 | + asyncpg + pyjwt + bcrypt + python-multipart | 12673.16 KiB (~12.4 MiB) | **943 ms** | 8/8 | **20/20** | ⚠️ 只有 `jwt`、`multipart` |

**结论（含重要的自我限制）**：
1. 包体从 113 KiB → **12.4 MiB（已超过生产内核的 11.79 MiB）**，startup 从 427 ms → 943 ms，
   **并发 20 依然 20/20 成功、零异常** ⇒ 单靠「包体大 + 并发」不足以复现；
2. ⚠️ **但这档实验并不完整**：部署后 worker 内 `loaded` 只有 `jwt`/`multipart`，
   `fastapi`/`pydantic`/`asyncpg`/`bcrypt` 全部 `missing` —— 因为本地用 `uv pip install --target` 装的是**本机平台 wheel**，
   Pyodide 里加载不了（正确做法是 `pywrangler` 安装 pyodide wheel）。
   ⇒ **真正的「重 pure-python 依赖面」对照还没做到**，E2 不能就此结案。
3. 下一步（E2b）：把**真实内核源码**克隆部署（`scripts/pyinit-probe-kernel/`，CI 运行时从 `backend/worker/src` 同步、用 pywrangler 装 pyodide 依赖），
   压它的 `/health`（不触库）—— 这能区分「源码/模块图规模」与「生产 bindings」两个假设。
   **当前阻塞**：CI 的 `CLOUDFLARE_API_TOKEN` 似乎**没有创建新 worker 的权限**（本地用 DSH-Admin token 部署 probe 成功；CI 在 API 层失败且无 Python 错误；
   而 CI 部署 `kaas`/`kaas-edge` 一直成功，那是因为这两个 worker **已存在**）。E2b 需要在有创建权限的凭据下跑（或先手工创建一个同名空 worker）。

### 3E. 本轮新增的可复现资产（都在仓库里）
- `scripts/pyinit-probe/`：最小零依赖 probe（A4）+ `pressure.py`（E1/E3 压测，带 UA 绕 1010）
- `scripts/pyinit-probe-kernel/`：真实内核源码克隆探针（E2b，CI 同步源码）
- `.github/workflows/pyinit-probe.yml`：手动触发，`target=probe|kernelclone`


### 3F. E2b 真实内核源码克隆（2026-10-24T14:35Z）—— **决定性阴性结果**

为排除「我们的模块图/源码规模」这个变量，把**生产内核的同一份 `backend/worker/src/**`（209 个文件）** 原样克隆，
用**同一份 pyproject 依赖**（fastapi/asyncpg/pydantic/pyjwt/python-multipart/bcrypt）经 `pywrangler` 部署成隔离探针：

| 项 | 克隆探针 | 生产内核 |
|---|---|---|
| 源码 | 同一份 209 文件 | 同一份 |
| 依赖 | 同 pyproject（pyodide wheel） | 同 |
| 上传体积 | **13171 KiB（gzip 3388 KiB）** | 同量级 |
| **Worker Startup Time** | **3580 ms** | 冷启动实测 2.6–3.9 s |
| 差异 | 无 routes/cron、**不绑 HYPERDRIVE/DB/Service Binding** | 有生产 bindings |

**压测结果（打 `/health`，不触库）**：

| 组别 | 请求 | 成功 | 失败 | 耗时 | 备注 |
|---|---|---|---|---|---|
| 单请求 | 1 | 200 | 0 | — | 响应含 `shared.core=kaas_common, loaded=true` |
| 串行（间隔 1.5s） | 6 | **6** | **0** | 23.4 s | ≈3.9 s/次 ⇒ 几乎每次都付冷启动成本 |
| **并发 15** | 15 | **15** | **0** | 4.2 s | 无异常 |

**这个阴性结果告诉我们什么（老实说）**：
1. **不是**「源码规模/模块图」单独导致的 —— 同一份代码、同一份 pyodide 依赖、同样重的 init（3580ms），
   在隔离环境里串行/并发都不失败；
2. **也不是**「任意并发 init 必然重入崩溃」—— 15 并发同时冷启动没触发 `promising task` 异常；
3. 因此**剩余变量只剩**：生产 bindings（HYPERDRIVE/DB 连接）、事故当时的特定版本、或真实流量形态（长时间 isolate 频繁回收 + 重试放大）；
4. 对工单的影响：我们把「**已排除项**」又扩充了一条（源码/依赖面），并据此向 Cloudflare 提出更具体的问题 ——
   **init 失败是否与 bindings 初始化（Hyperdrive/DB 连接创建）在 Pyodide 内的时序有关**（这是我们唯一无法在隔离环境复现的部分）。

### 3G. 可复现配方（容器内构建，本机 Windows 可直接跑）

本机 Windows 上 `pywrangler` 会因 CJK 路径/pyodide venv 失败；用 Linux 容器绕开（已实测）：

```bash
# 1) 准备克隆目录：拷贝 backend/worker/src + pyproject（改 name）+ wrangler.jsonc（新 worker 名、只在 workers_dev）
# 2) 在 node:22-bookworm 里装 uv 后部署（需要 node≥22 + build-essential，因为 workers-py 的 pyjson5 要编译）
docker run --rm -v "<repo>/.tmp-kc2:/w" -e CLOUDFLARE_API_TOKEN=*** \
  -e CLOUDFLARE_ACCOUNT_ID=*** node:22-bookworm bash /w/run.sh
# 3) run.sh 内：apt install curl build-essential；装 uv；cp -r /w /build（**不要**在 bind mount 上建 venv，符号链接会坏）；
#    uv sync；uv run pywrangler deploy
# 4) 压测：python scripts/pyinit-probe/pressure.py https://<worker>.workers.dev/health --mode concurrent --n 15
```

> 踩坑清单（都已实测）：容器里的 uv 必须 ≥0.13.4；`pywrangler` 需要 node（pyodide venv 用 node 查询解释器）且 **node ≥22**（wrangler 4.151 要求）；
> bind mount（Windows）上建 `.venv-workers` 会因符号链接失败 ⇒ 必须复制到容器本地磁盘构建；`workers-py` 的 pyjson5 需要 `build-essential`。

### 3B. E1 本机阻塞记录（已解决，留档避免重复踩坑）

我们已经把最小 probe Worker 写好（`.tmp-pyinit-probe/`：`pyproject.toml` + `wrangler.jsonc`（name `kaas-pyinit-probe`、
`compatibility_date=2026-09-18`、flags `[\"python_workers\"]`、只开 `workers_dev`）+ `src/entry.py`（只 `from js import Response`，零依赖）），
但**部署侧**在本地环境遇到三层阻塞：

| # | 路径 | 结果 |
|---|---|---|
| 1 | `uv run pywrangler deploy`（uv 0.13.3） | 报「uv version at least 0.13.4 required」→ 已 `uv self update` 到 **0.13.5** |
| 2 | `uv run pywrangler deploy`（uv 0.13.5） | `Failed to inspect Python interpreter ... .venv-workers\pyodide-venv\Scripts\python.exe`（pyodide-venv 创建失败；清 `.venv-workers`、先 `pywrangler sync` 均复现） |
| 3 | `wrangler deploy`（原生 Python 支持，wrangler 4.151.2） | 上传成功但服务端构建失败：`introspection.py: from workers import (...)` ⇒ 原生路径要求 `python_modules` 内含 `workers` SDK，而该 SDK 正是由 pywrangler 安装的 |

⇒ **E1 需要在 CI（ubuntu，pywrangler 可正常工作）或已装好 pyodide 工具链的机器上跑**；本机今天不硬凑。
代码与配置已备好，下轮可直接搬进 workflow 或用 CI runner 部署后压测。
## 4. 量化数据（2026-10-24T13:5xZ 重新查询，script=`kaas`）

**三个窗口（分子分母都写清，避免混用）**：

| 窗口 | 起（UTC） | 止（UTC） | 合计 invocations | scriptThrewException | 错误率 |
|---|---|---|---|---|---|
| **A** | 2026-10-23T00:00Z | 2026-10-24T12:00Z | **4752** | **3063** | **64.5%** |
| B | 2026-10-22T00:00Z | 2026-10-24T12:00Z | 5158 | 3063 | 59.4% |
| C | 2026-10-21T00:00Z | 2026-10-24T12:00Z | 5566 | 3064 | 55.0% |

窗口 A 明细：`scriptThrewException 3063` / `success 1670` / `exceededResources 15` / `clientDisconnected 4`。
（原文 v1 写过 3030/4456=「56%」与 3030/4475 — 前者是更早窗口、后者是更早时点的表，**两个数都不是错数，是本稿混用**；v2 统一到上表。）

**必须声明的分母口径（否则会被质疑流量口径）**：
- **invocation ≠ 用户请求**：门面对幂等 GET 最多重试 5 次（≈4.4s），1 次用户动作最多产生 5 次 invocation ⇒ 3063 含重试放大；
- 我们同时承认：重试**也真实增加了 init 压力**（重试发生在冷启动失败的 isolate 上），这是双刃。
- **cron 计入**：内核 3 条 cron 也会初始化实例，包含在上表里。

**内存：只作风险因子，不作因果**（原文把它写成因果是错的）：
| status | memory P50 | memory P99 |
|---|---|---|
| success | 95–118 MB | **137.5 MB** |
| scriptThrewException | 96–101 MB | 119.6 MB |
| exceededResources | 96–119 MB | 138.9 MB |

> **反直觉点必须自己先说**：失败的请求内存**低于**成功的请求（119.6 < 137.5）。
> 这与「init 期就 abort、WASM 堆还没长满就被统计」一致，所以我们在 v2 里**不主张 OOM 是主因**；
> 真正的 OOM 证据只有 `exceededResources` 那 15 次。128 MB 上限 + P99 137.5 MB 只说明**余量很小**。

**耗时特征**：失败请求 `cpuTimeP50` 274–1293 µs、`wallTimeP50` 651–1895 ms（启动期即失败）；
成功请求 `wallTimeP50` 最低 5987 ms。**我们不断言「每次请求都在付完整 init」**（缺逐 isolate 证据），
只说「低流量期 + isolate 频繁回收 ⇒ 大量请求落在冷启动」这一更弱的表述，并将在 A8 补冷/热对照。

**时间形态**（以 A2/A8 CSV 为准）：10-22 全天 0 错误；10-23 起成簇（单小时最高 247）；
**10-24T06:42Z 我们开始部署新内核版本，07:00Z 单小时 `scriptThrewException` 达 2562/2750 ≈ 93%（全窗口峰值）**。

### 4.1 部署与错误率对齐（A3/A9）

| UTC 时间 | 事件 |
|---|---|
| 2026-10-24T06:41:25Z | commit `c25ffe36`（第三轮收口，37 文件） |
| 2026-10-24T06:48:06Z→06:48:19Z | **我们跑了 DB migration**（alembic upgrade head） |
| 2026-10-24T06:48:22Z→06:49:46Z | **内核 kaas 部署**（新版本） |
| 2026-10-24T06:49:48Z→06:50:32Z | **门面 kaas-edge 部署** |
| 2026-10-24T07:00Z | 该小时错误数 993（此前峰值 247）⇒ **紧跟我们自己的部署** |

> 我们**主动标注**这个相关性：在未完成 E4（回滚 24h 对照）之前，我们**不声称**部署与该尖峰无关。

## 5. 我们已排除 / 未排除

**已排除**（有对照数据）：
- ❌ 业务代码异常：栈无应用帧；**同版本代码在事故前后都能成功处理同一请求**；
- ❌ 绑定/额度：`exceededResources` 仅 15/4752，主失败是 `scriptThrewException`；
- ❌ 门面侧故障：同窗口 `kaas-edge` 1821 次调用 **0 错误**；
- ⚠️ 鉴权逻辑：我们**不能**用「匿名 401 正常」来证明与鉴权无关（那是另一次成功的 init）。只能说「同 URL 同分钟成败交替」，并把「鉴权分支会让请求更晚进入 init 路径」列为**未排除的假设**。

**未排除**（见 §8 披露）：我们自己的部署、重试放大、拓扑变更（10-22 起无公网域名）、init 本身很重（~800KB 源码/isolate、`python_modules` 11.79 MiB / 606 文件、冷启动实测 2.6–3.9s）。

## 6. 我们需要 Cloudflare 确认/修复的点（按优先级）

1. **是否已知缺陷**：`initPyInstance` 上出现 `NoGilError`（preparePython）与 `Cannot enter a promising task`（doPyCallHelper）是否为 Python Workers / Pyodide 的已知问题？若有：issue 号、受影响 runtime/Pyodide 版本、预计修复窗口。
2. **官方规避**：是否推荐「把冷启动串行化」（前置 Durable Object / Queue），或有可用的 `compatibility_date` / `compatibility_flags` 组合规避？
3. **两类异常是否同根因**：第二类读起来像**并发重入 init**，请确认或排除（这直接决定我们是否该把内核调用串行化）。
4. **内存口径**：128 MB 是否含 host 堆？init 期 OOM 是否应记为 `exceededResources` 而非 `scriptThrewException`？
5. **内部 trace**：能否用 A1 里的 `rayId`（及 colo）反查失败路径？

## 7. 复现

### 7A 给 Cloudflare 的最小复现（**pending，下一步产出 A4**）
- 一个最小 `python_workers` Worker：同账号、`compatibility_date=2026-09-18`、`compatibility_flags=["python_workers"]`；
- 两个变体：① hello-world（无依赖）② 代表性依赖面（fastapi/pydantic/asyncpg）；
- 压测脚本：并发冷启动 N 次（每次间隔 > isolate 回收窗口），打印 status/rayId；
- 判据：若 hello-world 同样出现 `initPyInstance` 异常 ⇒ 平台侧；若仅重依赖变体出现 ⇒ 指向包体。

### 7B 我方黑盒复现（仅供对照，CF 无法执行）
打我们的 edge 域名需要我们的 JWT 与 DB，且内核无公网域名（只能经 Service Binding 调用）⇒ 仅作现象记录：
```bash
# 1) 登录拿 JWT（需我方 QA 账号）
curl -s -X POST https://api.kaas.powervoy.com/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"<qa-user>","password":"<qa-pass>"}' | jq -r .access_token > /tmp/t
# 2) 交替打（历史现象：同分钟 502/200 交替）
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "%{http_code} " -H "Authorization: Bearer $(cat /tmp/t)" https://api.kaas.powervoy.com/api/v1/products
  sleep 0.5
done
# 3) 抓内核 tail
CLOUDFLARE_API_TOKEN=... npx wrangler tail kaas --format json
```

## 8. 主动披露（可能被用来解释故障的事实，我们不等你问）

1. **10-24T06:48–06:50Z 是我们自己的部署**（见 §4.1），4× 尖峰紧跟其后；**回滚对照（E4）尚未做**，我们不宣称与该部署无关。
2. **重试放大**：门面对幂等 GET 最多重试 5 次/≈4.4s ⇒ 3063 含重试，且重试本身增加了 init 压力。
3. **拓扑变更**：10-22 起内核 `routes: []`、只能经 Service Binding 调用；此前有公网域名 ⇒ **缺少前后可比阶段**。
4. **我们的 init 本就重**：~800KB Python 源码/isolate、`python_modules` 11.79 MiB / 606 文件、冷启动实测 2.6–3.9s（个别 PoP ~10s）；事故前试过懒加载降内存，**已回退**。
5. **事故期间我们在把读流量迁出内核** ⇒ 内核 invocation 大幅下降 ⇒ isolate 更易回收 ⇒ 冷启动更频繁 ⇒ **可能反而放大**该缺陷的暴露面（假设，非结论）。
6. **内核 3 条 cron** 也触发 init 并计入 §4 数字。
7. **窗口内 502 信封变更过**（`kernel_error` → 新的 `kernel_unavailable`），A1 样本会标注对应门面版本。
8. **24 条 tail 样本来自单次会话**、且在重试风暴期间采集，样本量小；A1 会补更大样本与成功对照。

## 9. 附件清单

> 工件已落盘在 **`docs/ticket-2026-10-24/`**（含 README 索引与重新生成方式）。

| 编号 | 内容 | 文件 | 状态 |
|---|---|---|---|
| A1 | tail 原始样本（含 rayId/colo/时间戳/版本） | `A1_tail_excerpt.md` | ⚠️ **仅摘录**（原始 JSONL 未持久化，已在文件里说明；抓取工具见 `scripts/capture-kernel-tail.ps1`） |
| A2 | GraphQL 按小时聚合（requests/errors/scriptThrewException/错误率） | `A2_hourly_error_rate.csv` | ✅ 85 小时 |
| A3 | 版本与部署清单（UTC）+ compat 设置 | 正文 §4.1 / §9 追加段 | ✅ |
| A4 | **最小复现 Worker**（零依赖）+ **真实内核克隆探针** + 压测脚本 | `scripts/pyinit-probe/`、`scripts/pyinit-probe-kernel/`、`pressure.py` | ✅ 已部署并实测 |
| A5 | 依赖与包体清单（pylock sha256 / 源码规模 / 各变体体积与 startup / 工具版本） | `A5_dependency_inventory.md` | ✅ |
| A6 | 对照实验矩阵 E1–E5（含未完成项如实标注） | 正文 §3A / §3C / §3D / §3F | ⚠️ E1/E2/E2b/E3 已跑（均未复现）；E4/E5 未做 |
| A7 | 门面对照（`kaas-edge` 按小时 requests/errors/wallTime） | `A7_edge_hourly.csv` | ✅ 72 行 |
| A8 | `kaas` 按小时 × status，含 cpu/wallTime/memory 的 P50/P99 | `A8_kaas_hourly.csv` | ✅ 109 行 |
| A9 | 事故时间线（UTC，含**我们自己的部署**与实验动作） | `A9_timeline.md` | ✅ |

### 9.1 本次重查修正的两个数字（以 CSV 为准）

- **峰值小时**：`2026-10-24T07:00Z` 的 `scriptThrewException` = **2562 / 2750 请求 ≈ 93%**（此前正文引用的 993 是更早查询口径，已作废）；
- 该峰值**紧跟 `2026-10-24T06:42:07Z` 开始的 deploy**（run 40071240322，commit `c25ffe36`）——见 A9；
- 事故**起点是 10-23T00:00Z**（早于该部署）⇒ 该部署不是起因，但可能加剧。

### 9.2 当前健康状态（对工单有用）

2026-10-24T14:55Z 查询：**最近 90 分钟 45 请求 / 0 错误**（内核健康）⇒ 我们无法即时抓到新鲜的 A1；
下次复现时用 `scripts/capture-kernel-tail.ps1` 立刻抓 `rayId`/`colo`，可补齐真正的 A1。

## 10. 提交用英文正文

见 `docs/CLOUDFLARE_TICKET_2026-10-24_PYODIDE_INIT_EN.md`（与本文同源，数字与 §4 一致）。
