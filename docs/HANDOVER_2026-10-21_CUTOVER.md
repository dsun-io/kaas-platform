# 交接 · 2026-10-21 切流收口（当前口径）

> 本文是 **2026-10-21 优化计划执行完成后的交接入口**。历史交接见 `docs/archive/`（不要用归档判断现状）。
> 唯一权威进度/设计：`OPTIMIZATION_PLAN_2026-10-21.md`（已收口）、`ARCH_DECISIONS.md`（ADR-008）、
> `W4_CUTOVER_RUNBOOK_2026-10-21.md`（切流执行记录 §7）、`W5_MCP_REST_DESIGN_2026-10-21.md`（待实施）。

## 1. 现在的生产是什么（关键变化）

**两层架构已生效（ADR-008）**：

| 层 | Worker | 版本 | 职责 | 入口 |
|---|---|---|---|---|
| 门面 | `kaas-edge`（TS/Hono） | `777b55a5` | 全部 UI 面路由（163 直接）+ 引擎域透传（86 前缀）+ 静态资产 | `kaas.powervoy.com` / `api.kaas.powervoy.com` |
| 内核 | `kaas`（Python/FastAPI） | `25133623` | 报价/单证引擎、AI/数据能力、cron 3 条 | **无公网域名**，仅 Service Binding（`env.KERNEL`） |

数据层：Neon **新加坡** `cold-king-20466417` + Hyperdrive `6830420703984a19a99a334afff6776e`（2026-10-21 从 us-east-2 迁入，RTT 245→75ms）；
R2 `kaas-files`；Redis/队列仍不做（ADR-002）。

**已发生的用户可见变化**：切流时 JWT_SECRET 已轮换 ⇒ **所有用户需重新登录一次**（新 secret 已双端同步）。

## 2. 常用运维命令

```powershell
$env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable('CLOUDFLARE_API_TOKEN','User')  # wrangler OAuth 已过期

# 部署门面（改 TS/前端资产后）：
cd frontend; $env:NEXT_EXPORT="1"; pnpm build
cd backend/ts-worker; pnpm wrangler deploy

# 部署内核（改 Python 引擎/cron 后）：
cd backend/worker; uv run pywrangler deploy

# 门禁：
cd backend/ts-worker; pnpm typecheck; pnpm test          # 99 测 / 17 文件
cd backend/worker; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q   # 1565+12skip
cd backend/orchestrator; uv run --extra migrations pytest tests -q                          # 247
backend/orchestrator/.venv/Scripts/python.exe scripts/check-structural-debt.py --allow-known
# 金标对照（门面 vs 基线）：
backend/orchestrator/.venv/Scripts/python.exe backend/ts-migration/golden/diff_responses.py --left <A> --right <B> --only smoke,facade401 --delay 2.0
```

## 3. 剩余事项（已登记，不是遗忘）

| 项 | 状态 | 触发点 |
|---|---|---|
| **W5 对外 MCP+REST** | ✅ **已完成（M1–M4 全部上线：token 基座/OpenAPI+docs/MCP server+token 接入/对外文档+UI 令牌页）** | — |
| W5 后续增强（登记） | token 逐次审计日志、MCP SSE、更多 tools/resources | 按需 |
| 内核瘦身（main.py ≤3000 行） | 等 2 周回滚窗口结束 | 提醒 **2026-11-04**（schedule-50e7d5be） |
| 旧 Neon 项目 `falling-salad` + 旧 Hyperdrive `f53fed…` | ✅ **已删除（2026-10-21，用户授权；验证：hyperdrive 仅剩 kaas-apac、旧项目 404）** | — |
| Notion 集成 token 吊销 | 用户在 Notion 后台操作（API 无端点） | 用户方便时 |
| TS 门面已知差异 | 见 `backend/ts-worker/README.md`（422 措辞/时间戳精度/BigInt 类型/SigV4 TODO:TS5 等） | 各项 TODO 编号 |
| 真源不一致 `ORDER_NEXT` | `TODO.md §F2` | 内核侧收敛时 |

## 4. 接手注意（实测坑）

- 门面与内核**两个 Worker**：改契约必须同 PR + 金标全绿；业务规则禁止写进 TS。
- 门面 = 对外唯一入口；内核域名已摘除，调试需 `wrangler tail kaas` 或经门面透传验证。
- 身份/密钥：JWT_SECRET 双端同值（`~/.dsh/secrets/jwt-secret-20261021.txt`）；写 secret 必须走 CF API（禁 PowerShell 管道）。
- 历史哈希口径：2026-10-21 已做密钥清理重写（1053→774 提交），部分旧文档 hash 失效（见 PROBLEM_STATUS 顶部说明）。
- pnpm 在 PS 下用 `pnpm.cmd`；Python 用各 venv（PATH 的 python 是坏的）；uv 需 `UV_CACHE_DIR=D:\tools\uv-cache`。

---

*交接人：lead（DSH AI），2026-10-21。本文随状态变化更新；过时即归档。*