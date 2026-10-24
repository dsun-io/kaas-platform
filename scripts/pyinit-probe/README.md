# kaas-pyinit-probe（工单附件 A4）

最小 `python_workers` Worker，用于回答 Cloudflare 工单里的两个问题：

1. **E1**：去掉我们的业务代码与依赖面之后，Pyodide 初始化还会失败吗？
2. **E3**：失败是否只在**并发**冷启动时出现（重入假设）？

## 实测结论（2026-10-24T13:52Z）

- 串行 8/8 成功、并发 20/20 成功（`pressure.py`，1.4s 内 20 并发）；
- **未复现** `initPyInstance` 类异常 ⇒ 工单不能断言「任意 Python Worker 必现」；
  下一步是 E2 **依赖二分**（probe 111 KiB / 465ms 启动 vs 生产内核 11.79 MiB / 2.6–3.9s）。

## 与生产内核保持一致
- `compatibility_date = 2026-09-18`、`compatibility_flags = ["python_workers"]`
- 由 `pywrangler` 部署（CI 路径）或用 `wrangler` + 预置 `python_modules`（见下）

## 刻意不同
- **零业务依赖**（`dependencies = []`），不 import 任何 kaas 模块
- 无 routes / 无 cron / 只看 `workers_dev`；worker 名 `kaas-pyinit-probe`，不触碰生产 `kaas` / `kaas-edge`

## 怎么跑

### CI（推荐，ubuntu；pywrangler 已验证可用）
`.github/workflows/pyinit-probe.yml` 手动触发即可（会部署 + 跑串行/并发 + 上传日志）。

### 本机（Windows）
本机 `pywrangler deploy` 会在创建 `.venv-workers/pyodide-venv` 时失败；可用 `wrangler` 直连方式：

```bash
uv pip install --target python_modules workers-runtime-sdk   # wrangler 原生 Python 构建需要 workers SDK
wrangler deploy --config wrangler.jsonc                      # 需要 CLOUDFLARE_API_TOKEN
python pressure.py https://kaas-pyinit-probe.<subdomain>.workers.dev --mode serial --n 8
python pressure.py https://kaas-pyinit-probe.<subdomain>.workers.dev --mode concurrent --n 20
```

> `workers.dev` 会按 UA 拦机器人（Error 1010）⇒ `pressure.py` 固定带一个稳定 UA。

## 部署踩坑记录（写在这里省得下次重踩）
1. `pywrangler` 要求 **uv ≥ 0.13.4**；
2. 本机（CJK 路径）`pywrangler` 建 pyodide venv 失败；
3. `wrangler` 原生 Python 构建要求 `python_modules` 里有 `workers` SDK（否则 build 期 `introspection.py: from workers import ...` 失败）；
4. handler 必须能被识别，否则 `code 10068 no registered event handlers`。
