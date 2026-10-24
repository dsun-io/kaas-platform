# 事故取证：内核 502 / 前端大面积报错（2026-10-24）

> 现象（用户报障）：产品图**上传成功后前端不展示**；上传多张后控制台大量报错；刷新页面后**产品无法加载**。
> 结论：**不是业务代码 bug，也不是前端展示 bug**，而是 Cloudflare Python Worker 的 Pyodide 运行时在
> **Python 实例初始化阶段**间歇性崩溃，导致内核全部请求 502；前端把后端抖动放大成了"图不显示 + 页面空"。

## 1. 症状与证据

### 1.1 用户侧表现
- 上传队列每行显示 `kernel unreachable`（门面 502 透出的文案）；
- 控制台成片 `502 (Bad Gateway)`：`/api/v1/products`、`/products/{key}/media`、`/products/{key}/profile`、
  `/notifications/unread-count`、`/approvals?view=pending...`；
- 刷新后产品页只剩骨架卡（列表/资料都拉不到）。

### 1.2 谁是故障源（不是门面）
Cloudflare GraphQL `workersInvocationsAdaptive`（2026-10-23T00:00Z 起，script 维度）：

| 脚本 | 状态 | 请求数 | 错误 |
|---|---|---|---|
| `kaas`（Python 内核） | `scriptThrewException` | **3030** | 3030 |
| `kaas` | `success` | 1426 | 0 |
| `kaas` | `exceededResources` | 15 | 15 |
| `kaas-edge`（TS 门面） | `success` | 1821 | **0** |

⇒ 门面全绿，**错误 100% 来自内核**。当日内核错误率约 56%。

时间线（小时聚合）：10-22 全天 0 错误 → 10-23 起成簇（06:00Z 247 次）→ 10-24 06:49Z 部署后 07:00Z 一小时 **993 次**。

### 1.3 真实异常（wrangler tail，scriptVersion `f6bf1a83-a254-45b6-8fee-7dee57787b2c`）

```
NoGilError: Attempted to use PyProxy when Python GIL not held
    at throw_no_gil (pyodideRuntime-internal:emscriptenSetup:22096:11)
    at python_getattr (pyodideRuntime-internal:emscriptenSetup:24657:11)
    at async preparePython (pyodide:python-entrypoint-helper:230:28)
    at async initPyInstance (pyodide:python-entrypoint-helper:286:24)

PythonError: SystemError: Cannot enter a promising task from inside another running promising task.
              This is a bug in Pyodide.
    at callPyObjectKwargsPromising (pyodideRuntime-internal:emscriptenSetup:24011:97)
    at async doPyCallHelper (pyodide:python-entrypoint-helper:245:20)
    at async initPyInstance (pyodide:python-entrypoint-helper:291:17)
```

**24/24 捕获异常全部发生在 `initPyInstance`（Python 实例初始化）**，异常栈里没有任何我们的业务帧。

### 1.4 内存上限（结构性诱因）
| 状态 | memoryUsageBytes P50 | P99 |
|---|---|---|
| success | 95–118MB | **137.5MB** |
| scriptThrewException | 96–101MB | 119.6MB |
| exceededResources | 96–119MB | 138.9MB |

Workers 内存上限 128MB ⇒ 内核长期贴着上限运行。

### 1.5 为什么监控没报警
`/health` 与 `/health?deep=1`（部署冒烟探针）是**匿名**请求，不触发鉴权/DB 路径 ⇒ 事故全程返回 `ok`。
**教训：健康探针必须包含"带真实 JWT 的业务请求"**（已写入拆分方案 §9）。

### 1.6 复现与反证
- 匿名 `GET /api/v1/products` → **401**（内核正常响应，说明内核活着）；
- `POST /auth/login` → **200**（DB 正常）；
- 带 JWT `GET /api/v1/products` → 同一分钟内 **502 ×6**，十分钟后同请求 **200 ×6**；
⇒ **与鉴权无关、与代码分支无关**，是**间歇性初始化失败**（isolate 一旦 init 失败，落到它的请求全部 502）。

## 2. 修复与处置

| 层 | 改动 | 状态 |
|---|---|---|
| 门面 | 内核不可达时按幂等性重试（GET/HEAD/OPTIONS 5 次、退避 200/500/1200/2500ms ±20%，窗口≈4.4s）；502 信封改 `kernel_unavailable`+`retryable`+`Retry-After`；有 body 请求不盲目重试 | ✅ 已实现（ts-worker 345 测全绿） |
| 前端 | 上传成功**立刻写媒体缓存**（不再依赖那次可能 502 的重拉）；5xx 有限退避重试；多张失败只提示一次；可恢复提示 | ✅ 已实现 |
| 内核 | 降低启动内存/时间（惰性 import）——**因架构拆分指令暂缓**，半成品已回退 | ⏸ 并入拆分 P3 |
| 架构 | **认证 + 数据库连接移出 Python 内核**（见 docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md） | 📐 设计完成，待批准 |
| 平台 | 向 Cloudflare 报 Pyodide init 缺陷（证据包=本文 §1.3/§1.4） | 待用户决定 |
| 监控 | **错误率门禁**（治「匿名探针掩盖故障」）：`scripts/check-kernel-error-rate.py` + 每 15 分钟 `kernel-health.yml` | ✅ 已上线（commit `c9490cec`） |

## 3. 复现/取证方法（下次可直接复用）

1. **Cloudflare GraphQL**（账号 analytics，REST 可达，不受 SNI 阻断）：
   `workersInvocationsAdaptive` + `dimensions{scriptName,status}` + `quantiles{memoryUsageBytesP99,cpuTimeP50,wallTimeP50}`。
2. **wrangler tail 在本机被墙**（`tail.developers.workers.dev` DNS 污染 + SNI 阻断）⇒ 用系统代理：
   ```powershell
   $env:CLOUDFLARE_API_TOKEN = ...; $env:HTTPS_PROXY="http://127.0.0.1:7897"
   backend\ts-worker\node_modules\.bin\wrangler.cmd tail kaas --format json
   ```
3. **带 JWT 复现**：`POST /api/v1/auth/login`（QA 账号）拿 token，再带 `Authorization: Bearer` 请求热端点，交替发匿名对照。
