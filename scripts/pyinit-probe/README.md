# kaas-pyinit-probe（工单附件 A4）

最小 `python_workers` Worker，用于回答 Cloudflare 工单里的两个问题：

1. **E1**：去掉我们的业务代码与依赖面之后，Pyodide 初始化还会失败吗？
2. **E3**：失败是否只在**并发**冷启动时出现（重入假设）？

## 与生产内核保持一致的部分
- `compatibility_date = 2026-09-18`
- `compatibility_flags = ["python_workers"]`
- 由 `pywrangler` 部署（与内核同一工具链）

## 刻意不同的部分
- **零业务依赖**（`dependencies = []`），不 import 任何 kaas 模块
- **无 routes / 无 cron / 不开自定义域名**（只用 `workers_dev`）
- 独立 worker 名 `kaas-pyinit-probe`，不触碰生产 `kaas` / `kaas-edge`

## 怎么跑
```bash
# 部署（需要 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID）
uv run pywrangler deploy

# E3：串行 10 次（间隔 1s）
python pressure.py https://kaas-pyinit-probe.<subdomain>.workers.dev --mode serial --n 10

# E3：并发 10 次
python pressure.py https://kaas-pyinit-probe.<subdomain>.workers.dev --mode concurrent --n 10
```

CI 入口：`.github/workflows/pyinit-probe.yml`（手动触发，会跑 E1 的串行/并发两组并上传日志）。

## 注意
本机（Windows + CJK 路径）跑 `pywrangler deploy` 会在创建 `.venv-workers/pyodide-venv` 时失败；
用 CI（ubuntu）或纯 ASCII 路径的 Linux/macOS 环境更可靠。
