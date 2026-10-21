# ts-migration（W3 Phase 0 先遣工具箱）

TS Worker 全量迁移（W3，计划见 `../../docs/OPTIMIZATION_PLAN_2026-10-21.md` §2）
Phase 0 的先遣产物。**只新增工具与文档，不改任何现有产品代码。**

## 产物清单

| 路径 | 任务 | 说明 |
|---|---|---|
| `export_routes.py` | 一 | 路由清单导出器（打桩法 import worker main） |
| `route-inventory.md` | 一 | 253 条路由清单：按文件分组 + 域归属 + 总数核对 |
| `golden/diff_responses.py` | 二 | 金标对照 harness 原型（stdlib only） |
| `golden/README.md` | 二 | harness 用法 / diff 规则 / 生产纪律 |
| `golden/smoke-vs-prod.report.md` | 二 | 首次 smoke 对生产基线的报告存档 |

## 任务一 · 路由清单导出器

    backend/worker/.venv/Scripts/python.exe backend/ts-migration/export_routes.py

- 打桩法：sys.modules 注入 asyncpg（PEP 562 模块级 __getattr__ 返回占位类型）
  与 workers（WorkerEntrypoint / asgi.fetch）stub；sys.path 挂
  `backend/worker/src` 与 `backend`（kaas_common）；import main 后
  从 `app.routes` 提取全部 APIRoute。
- **解释器必须是 worker 的 venv**：orchestrator venv 没有 fastapi/pydantic/jwt
  （PATH 上的 python 是坏的 WindowsApps 占位符，两个都不能用）。
- 每行提取：method、path、endpoint 函数名 + 文件:行号、Depends 列表、
  是否挂 _get_current_user（登录态）、是否平台运营闸门
  （Depends 树 ∪ handler 函数体静态扫描 _require_platform_ops( /
  _require_ai_admin( —— 这两个闸门在 main/ws_admin_proposals/chain 里都是
  函数体内调用，不在 Depends 树上）。
- 域归属：前缀规则映射到 auth / customers / orders / quotes /
  trade-docs / files / intel / admin / cron / ai / outreach / teams /
  workstations / dashboard / meta（规则见脚本 _DOMAIN_RULES）。

### 总数核对结论（2026-10-21）

**253 = 249 业务 APIRoute + 4 FastAPI 内置文档路由（/openapi.json、/docs、
/docs/oauth2-redirect、/redoc）**，与计划 §2 Phase 0 登记数一致（exit 0）。
计划口径 = app.routes 全部条目；纯业务迁移面是 249 条。

## 任务二 · 金标对照 harness

见 `golden/README.md`。要点（写成单行避免续行符）：

    # smoke（5 条无副作用）对生产基线
    backend/orchestrator/.venv/Scripts/python.exe backend/ts-migration/golden/diff_responses.py --left http://localhost:8000 --right https://kaas.powervoy.com --only smoke

- 2026-10-21 实测：右端（生产）5 条形状全部符合预期；prod vs prod 自测 5/5
  一致（diff 引擎行为正确）；左端无本地服务时如实记连接失败。
- 生产纪律：清单 side_effect 标注 + 命中生产域名时写请求直接拒绝；
  --delay 默认 2.0 秒（auth 限流 5 次/10 秒）。

## 边界

- 不跑服务器、不连数据库；纯路由元数据 + HTTP 回放。
- 本地 Python worker 起服务（local_run.py，需 Hyperdrive binding）不属于
  本目录范围，harness 左端留到双跑环境就绪后接上。
