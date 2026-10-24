# Cloudflare 工单证据包：Python Workers 初始化期崩溃（NoGilError / Pyodide promising-task SystemError）

> 用途：可直接作为 Cloudflare Support 工单正文提交。整理时间 2026-10-24。
> 涉及账号：`766f8d7eb5a7d20e272673073ec8c3fd`（Dspro0124@163.com's Account）
> 涉及 Worker：`kaas`（Python，`compatibility_date=2026-09-18`，`compatibility_flags=["python_workers"]`）
> 相关脚本版本：`f6bf1a83-a254-45b6-8fee-7dee57787b2c`

## 1. 一句话描述

我们的 Python Worker 在生产上对**带 Authorization 头的正常业务请求**间歇性返回 502；Workers 侧记录的 outcome 是
`scriptThrewException`，异常发生在 **Pyodide 实例初始化**（`initPyInstance` / `preparePython`），
异常消息自身声明 *"This is a bug in Pyodide"*。当日内核错误率约 **56%**（3030/4456 次调用），
同一时刻同一门面的其他请求 0 错误。

## 2. 复现

**稳定复现路径**（同一分钟内、同一出口 IP、交替发）：

1. 匿名 `GET /api/v1/products` → **401**（内核正常响应）
2. `POST /api/v1/auth/login` → **200**（数据库正常，返回 JWT）
3. 带 `Authorization: Bearer <jwt>` 再 `GET /api/v1/products` → **502 `{"error":"kernel_error","message":"kernel unreachable"}`**
4. 约 10 分钟后再发同一请求 → **200**（自愈）

⇒ 失败与鉴权逻辑无关，是 **isolate 初始化失败后，落到该 isolate 的所有请求都 502**，直到它被替换。

**注**：匿名健康探针 `GET /health` 与 `/health?deep=1` **全程返回 200/ok**（不触发鉴权路径），因此平台侧监控未报警。

## 3. 真实异常（wrangler tail，`--format json`）

24 个异常事件**全部** `outcome=exception`、`scriptName=kaas`、请求 URL `https://kernel.internal/api/v1/products`。
两类异常各 12 次（每次失败重试中各出现一次）：

```json
{
  "name": "NoGilError",
  "message": "Attempted to use PyProxy when Python GIL not held",
  "stack": "    at throw_no_gil (pyodideRuntime-internal:emscriptenSetup:22096:11)\n    at wasm://wasm/0249d42a:wasm-function[450]:0x6e2e7\n    at python_getattr (pyodideRuntime-internal:emscriptenSetup:24657:11)\n    at Object.get (pyodideRuntime-internal:emscriptenSetup:24731:119)\n    at async preparePython (pyodide:python-entrypoint-helper:230:28)\n    at async initPyInstance (pyodide:python-entrypoint-helper:286:24)\n    at async Proxy.<anonymous> (pyodide:python-entrypoint-helper:328:36)"
}
```

```json
{
  "name": "PythonError",
  "message": "SystemError: Cannot enter a promising task from inside another running promising task. This is a bug in Pyodide.",
  "stack": "    at new_error (pyodideRuntime-internal:emscriptenSetup:21276:12)\n    at wasm://wasm/0249d42a:wasm-function[275]:0x65562\n    at wasm://wasm/0249d42a:wasm-function[276]:0x6562a\n    at callPyObjectKwargsPromising (pyodideRuntime-internal:emscriptenSetup:24011:97)\n    at async doPyCallHelper (pyodide:python-entrypoint-helper:245:20)\n    at async initPyInstance (pyodide:python-entrypoint-helper:291:17)"
}
```

两条栈里**没有任何应用代码帧**，全在 Pyodide/Workers 运行时初始化路径。

## 4. 量化数据（Cloudflare GraphQL `workersInvocationsAdaptive`）

**按状态聚合（2026-10-23T00:00Z 起，script=kaas）**

| status | requests | errors |
|---|---|---|
| `scriptThrewException` | **3030** | 3030 |
| `success` | 1426 | 0 |
| `exceededResources` | 15 | 15 |
| `clientDisconnected` | 4 | 0 |

**门面对照（script=kaas-edge）**：`success` 1821，`errors 0`。

**内存分位（同脚本，按状态）**

| status | memoryUsageBytes P50 | memoryUsageBytes P99 |
|---|---|---|
| success | 95–118 MB | **137.5 MB** |
| scriptThrewException | 96–101 MB | 119.6 MB |
| exceededResources | 96–119 MB | 138.9 MB |

Workers 内存上限 128 MB ⇒ 初始化期长期贴上限（P99 已超）。`wasmMemoryBytesP99` 稳定 52–62 MB。

**失败请求的耗时特征**：`cpuTimeP50` 仅 **274–1293 µs**、`wallTimeP50` 651–1895 ms（启动期即失败）；
成功请求 `wallTimeP50` 最低 **5987 ms**（每次请求都在付完整 Python 初始化成本）。
tail 事件里 `executionModel: "stateless"`。

**时间线（小时）**：10-22 全天 0 错误；10-23 00:00Z 起成簇（单小时最高 247 次）；10-24 06:49Z 部署后 07:00Z 单小时 **993 次**。

## 5. 我们的排查已排除的可能

- ❌ 不是业务代码异常：栈无应用帧，且同版本代码在失败前后均能成功处理同样的请求。
- ❌ 不是鉴权/DB 故障：匿名 401 与 login 200 均正常，DB（Hyperdrive）健康。
- ❌ 不是绑定额度：`exceededResources` 仅 15/4475，主要失败是 `scriptThrewException`。
- ❌ 不是我们并发打爆：失败集中出现，且重试（200/500/1200/2500ms 退避）后大量仍失败。
- ✅ 与"部署后新版本 isolate 首次初始化"以及"运行中 isolate 被替换后重新初始化"高度相关。

## 6. 我们希望 Cloudflare 确认/修复的点

1. `initPyInstance` 阶段出现 `NoGilError` 与 `SystemError: Cannot enter a promising task ...` 是否为已知缺陷？
   是否有已知的触发条件（并发首次请求？某类模块导入？`python_workers` flag 组合？）
2. 是否有**推荐的规避手段**（例如特定 `compatibility_date`、关闭某优化、调整 snapshot/prewarm 设置、限制并发首次请求）。
3. Python Worker 的**启动内存**是否有官方调优建议（我们的 P99 已到 137MB / 128MB 上限）。
4. 是否有可观测手段能在**初始化失败**时给出更明确的错误（目前只看到 scriptThrewException）。

## 7. 复现脚本（供你们内部验证）

```bash
# 1) 取 token
curl -s -X POST https://<our-host>/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"<qa-user>","password":"<qa-pass>"}'

# 2) 交替发匿名 / 带 JWT 请求，观察 502 簇
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "anon %{http_code}\n" https://<our-host>/api/v1/products
  curl -s -o /dev/null -w "jwt  %{http_code}\n" -H "Authorization: Bearer $TOKEN" https://<our-host>/api/v1/products
  sleep 0.5
done

# 3) 抓 tail（Python Worker）
CLOUDFLARE_API_TOKEN=... npx wrangler tail kaas --format json
```

## 8. 我们的临时缓解（供参考）

- 门面 Side 对 `env.KERNEL.fetch` 抛错按幂等性做指数退避重试（GET 5 次、窗口≈4.4s），把单次初始化失败对用户的影响吸收掉一部分；
- 正在把**认证与数据库访问**从 Python Worker 移到 TS 门面（Hyperdrive 直连），使"用户能否打开页面"不再取决于 Pyodide 初始化；
- 增加**带真实 JWT 的合成探针**（匿名探针掩盖了该故障）。
## 9. 迁移完成后的架构证据（2026-10-24 21:45 补充，强化「影响面」论证）

为把「Pyodide 初始化失败」从**影响全站**降级为**影响局部**，我们在这两天把请求路径重构成两层，并留下了可复核的线上证据：

### 9.1 当前形态
```
用户/前端 ──► kaas-edge（TS Worker, Hono + Hyperdrive 直连 Neon）
                ├─ 认证 / 热读 / 大部分只读 / 配置类写  ──► 直接查库（不经过 Python）
                └─ 需要 Python 计算的少数端点 ──► KERNEL.fetch (Service Binding)
                                                     └─ /api/v1/internal/engine/* 纯算 RPC
                                                        （内核此时**不连库**，只做投影/算法）
```

- **已迁移到门面的实路由数（本任务内新增）**：40+ 条（热读 5 + 纯 SQL 只读 12 + 引擎切片 14 + 写路径 6 + 其余批次）
- **内核保留连库的端点**：只剩 41 条跨表事务写 + 约 10 条「保持 Python」（字节流/PDF/AI 执行/出站探针/cron/懒种子），
  已用 `backend/worker/src/kernel_db_allowlist.txt` + `scripts/kernel-db-baseline.json` **静态锁死**（除清单外不得新增连库端点）。

### 9.2 线上证据：内核现在只收到「纯算 RPC」
多轮 `wrangler tail kaas --format json` 抽样（每次带真实 JWT 打 5–7 个业务端点）：
```
内核收到请求数: 6
  /api/v1/internal/engine/quote/import-template
  /api/v1/internal/engine/quote/order-template-info
  /api/v1/internal/engine/quote/products
  /api/v1/internal/engine/trade-docs/list
  /api/v1/internal/engine/trade-docs/detail
  /health
```
⇒ **业务查询已不再落入 Python Worker**；内核收到的是「门面已取好数据、只要算术」的 RPC。

### 9.3 为什么这对你们的缺陷诊断有帮助
1. Pyodide 初始化（preparePython / initPyInstance）**仍然会**在这类 RPC 调用时触发 —— 所以我们的 502 观测依然有效、仍可复现；
2. 但**影响面**已从「所有页面都可能 502」缩到「少数需要 Python 计算的端点」；
3. 这也**排除了「我们的用法问题」**这一解释：我们已把 Python 侧的 DB 访问几乎全部移除（连库只剩例外清单），
   内核初始化仍然失败 ⇒ 故障点在 **Pyodide 初始化本身**，与「Python Worker 里做重活」无关。

### 9.4 我们可以配合提供的材料
- Worker 名称 / account id / 采样时间窗 / 具体 colo（可从 GraphQL 取）；
- 完整 `wrangler tail --format json` 原始行（含 `outcome: scriptThrewException` 与两段堆栈）；
- 我们的 wrangler 版本、`compatibility_date`、`compatibility_flags`（是否 python_workers）、依赖锁（uv lock）；
- 复现脚本（§7）与对照组数据（匿名 vs 带 JWT 的成功率差异）。