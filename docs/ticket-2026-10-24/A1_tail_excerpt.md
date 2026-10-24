# A1 tail 原始样本（**部分**，含重要限制说明）

## 状态：⚠️ 仅摘录，未能提供完整 JSONL

事故当时我们用 `wrangler tail kaas --format json` 抓了**单次会话**的异常（共 24 条，全部 `scriptThrewException`，
栈全部落在 `initPyInstance`），但**只把栈摘录留在了事故文档里，原始 JSONL 没有持久化**（当时未接 Logpush）。
这是我们的疏漏，在此如实说明；**不提供无法核实的"完整日志"**。

## 我们能确定提供的（两类异常栈，逐字取自当次 tail）

### 1. `NoGilError`（发生在 `preparePython` 的 getattr 路径）

```text
NoGilError: Attempted to use PyProxy when Python GIL not held
    at throw_no_gil (pyodideRuntime-internal)
    at python_getattr
    at preparePython
    at async initPyInstance (pyodide:python-entrypoint-helper:286:24)
```

### 2. `PythonError / SystemError`（发生在 `doPyCallHelper` 路径）

```text
PythonError: SystemError: Cannot enter a promising task from inside another running promising task.
This is a bug in Pyodide.
    at new_error (pyodideRuntime-internal:emscriptenSetup:21276:12)
    at callPyObjectKwargsPromising
    at doPyCallHelper
    at async initPyInstance (pyodide:python-entrypoint-helper:291:17)
```

## 我们另外能提供的确定事实

- 24/24 条异常的 `outcome` = `scriptThrewException`，`scriptName` = `kaas`；
- 请求 URL 为绑定地址 `https://kernel.internal/api/v1/products`（Service Binding）；
- **栈内没有任何 `kaas_common/**` / `main.py` 帧**；
- 同分钟同 URL 出现 502 与 200 交替，约 10 分钟后无部署自愈。

## 下次复现时如何拿到完整 A1（已备工具）

见 `scripts/capture-kernel-tail.ps1`：它会同时抓 `wrangler tail --format json`（含 `rayId`/`colo`/`eventTimestamp`/`scriptVersion`）
与门面侧 502 计数，并把失败行单独筛出来落盘。若缺陷再次出现，我们能立刻产出真正的 A1。

## 建议 Cloudflare 侧如何配合

即使没有完整 JSONL，我们仍希望你们能：
1. 用**同一账号 + 同一时间窗（2026-10-23T00:00Z→2026-10-24T12:00Z）**在内部按 `scriptName=kaas` + `outcome=exception` 检索；
2. 或用 A2/A8 的按小时序列与我们核对——若你们内部指标与我们一致，即可直接进入「init 路径为何抛错」的机制讨论。
