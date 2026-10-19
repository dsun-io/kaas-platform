# Worker 跑 SQLAlchemy POC 结论文档（2026-10-19 · P0）

> **状态：POC 完成；未提交/未部署任何生产代码，生产 Worker `kaas` 全程未动**（对 `kaas`
> 只做了 `wrangler deploy --dry-run`）。本文为 task-3 交付物；是否落地由 lead 裁决。
> 关联：[双后端收敛评估](./DUAL_BACKEND_CONVERGENCE_2026-10-19.md) §3.1/§5、
> [执行计划](./DUAL_BACKEND_CONVERGENCE_EXEC_PLAN_2026-10-19.md) Phase 0。
> POC 源码：[`backend/worker/poc-sqlalchemy/`](../backend/worker/poc-sqlalchemy/README.md)。

## 0. 结论（一句话）

**路线 A 不可行（as-is）。** 两个独立的不通过项：

1. **兼容性硬阻塞**：`greenlet` 在 Workers Python runtime 里**没有可安装的 wheel**
   （Pyodide index 无该包；PyPI greenlet 3.5.6 的 79 个文件里 **0 个** wasm/emscripten
   wheel）⇒ `import sqlalchemy.ext.asyncio` 直接 ImportError，异步查询 100% 不可用。
2. **冷启动超门槛**：`Worker Startup Time` 中位 **2059ms → 3913ms（+1854ms）**，
   超出验收口径的 "<1s 量级"。

建议转 **路线 A′**（数据访问层同源，worker 继续裸 asyncpg 执行），并可采用已实测可行的
**"SQLAlchemy 同步 Core 只编译 SQL + asyncpg 执行"**作为共享 SQL 生成器（见 §3.4）。

## 1. 环境与方法

| 项 | 值 |
|---|---|
| Worker runtime | Python Workers（Pyodide 314.0.7 / CPython 3.14.2 emscripten wasm32） |
| 工具链 | wrangler 4.151.1、pywrangler 1.17.3、uv 0.12.16、node 24.21.0 |
| 打包方式 | `pywrangler sync` → `python_modules/`；`pywrangler dev`（本地 workerd）；`wrangler versions upload` / `pywrangler deploy`（仅 POC worker） |
| 数据库 | 本机无 Docker ⇒ 用 `pgserver==0.1.4` 自带的 PostgreSQL **16.2** 二进制，`127.0.0.1:5432`，库 `kaas_poc`，`users` 2 行（见 README） |
| 对照组 | 同一份 Worker 工程**去掉 sqlalchemy**（`poc-baseline`），同一探针代码、同一 DB |
| 规则 | 生产 `kaas` 未 deploy、未 versions upload、未改任何 tracked 文件（`git status` 仅 2 个新 POC 目录） |

## 2. 逐条结果

### 2.1 import 可行性 —— ❌ 不通过（同步可 import，asyncio 不可）

| 探针 | 本地 workerd | 边缘部署版本（真实 Workers runtime） |
|---|---|---|
| `import sqlalchemy` | ✅ 2.1.5 | ✅ 2.1.5 |
| `import greenlet` | ❌ `ModuleNotFoundError: No module named 'greenlet'` | ❌ 同左 |
| `import sqlalchemy.ext.asyncio` | ❌ `ImportError: The SQLAlchemy asyncio module requires that the Python 'greenlet' library is installed...` | ❌ 同左 |
| `import asyncpg` | ✅ 0.31.0 | ✅ 0.31.0 |

可打包性证据：
- `pywrangler sync` 成功解析 14 个依赖（含 `sqlalchemy==2.1.5`），**不含 greenlet**；
- 解析期直接拒绝 greenlet（可复现）：
  `uv pip compile ... --extra-index-url https://index.pyodide.org/314.0.7 --no-build`
  → `Because all versions of greenlet have no usable wheels and you require greenlet`
- Pyodide 包索引 `https://index.pyodide.org/314.0.7/`：有 `sqlalchemy`、**404 无 `greenlet`**；
  PyPI `greenlet 3.5.6` 共 79 个发行文件，wasm/emscripten 文件名 **0 个**。

> 修正评估文档 §3.1 的措辞："SQLAlchemy 本体是纯 Python"只对**同步**成立；
> **asyncio 扩展硬依赖 greenlet**，这是本次 POC 确认的硬阻塞，不是"未验证的工程风险"。

### 2.2 真实查询 —— ❌ 不通过（SQLAlchemy async 端到端不可用）

| 端点 | 实现 | 结果 |
|---|---|---|
| `/sqla/select1` | SQLAlchemy async + `postgresql+asyncpg` | ❌ 本地 500；边缘 500（ImportError 未捕获） |
| `/sqla/users_count` | 同上，`SELECT count(*) FROM users` | ❌ 本地 500（同因） |
| `/pg/users_count` | **裸 asyncpg 对照**（同 DSN/同表） | ✅ `{"ok":true,"users_count":2}`（本地 + 200） |
| `/sqla-core/compile` | SQLAlchemy **同步 Core** 只编译 SQL | ✅ `SELECT users.id, users.email FROM users WHERE users.id > %(id_1)s::INTEGER` |

⇒ 数据库连通性、asyncpg 驱动、Workers socket 路径都正常；**唯一失败点就是
SQLAlchemy async 需要 greenlet**。

### 2.3 冷启动与包体积 —— 冷启动 ❌ / 包体积 ✅

`Worker Startup Time`（Cloudflare 在 upload/deploy 时实测返回，DEPLOY.md §0.2 同口径）：

| 样本来源 | baseline（无 SQLAlchemy） | +SQLAlchemy | 差值 |
|---|---|---|---|
| `wrangler versions upload` 中位（有效样本） | **2059 ms**（1736/1814/2059/2109/2115，n=5 全有效） | **3913 ms**（3348/3374/3853/3972/4713/6152，n=6 有效） | **+1854 ms** |
| `pywrangler deploy` 单次 | 2953 ms | 3348 / 3686 ms | +395 / +733 ms |

- 两组 upload 样本**不重叠**：baseline 最大 2953 < SQLAlchemy 最小 3348。
- 说明：SQLAlchemy 侧 11 次 upload 中另有 **5 次**返回 `Worker Startup Time: 0 ms`
  （疑似同内容去重未实测），已按无效样本剔除；原始样本见 §5。
- 本地 `pywrangler dev` 冷启动：baseline 46.19s/14.73s，SQLAlchemy 80.26s/32.86s/18.32s
  —— 受 wrangler/workerd/pyodide 缓存初始化支配、方差极大，**不作为判据**，以 CF
  实测 `Worker Startup Time` 为准。

包体积：

| 指标 | baseline | +SQLAlchemy | 差值 |
|---|---|---|---|
| Vendored modules | 10,804.41 KiB / 516 模块 | 19,251.86 KiB / 786 模块 | +8,447.45 KiB（+78%），+270 模块 |
| Total Upload（非压缩，限值口径） | 10,809.98 KiB | 19,257.44 KiB | +8,447.46 KiB |
| gzip（仅参考） | 2,695.74 KiB | 4,535.80 KiB | +1,840.06 KiB（+68%） |
| `python_modules/` 目录 | 10.55 MiB / 516 文件 | 18.80 MiB / 786 文件 | `sqlalchemy` 包本身 8.22 MiB |
| 生产 worker 现状（dry-run，未部署） | 11,588.84 KiB / gzip 2,934.96 KiB | 推算 ≈ 20.0 MiB | — |

限值：Cloudflare 2026-09-04 起**取消 3MB(Free)/10MB(Paid) 压缩限制，改为全套餐 64 MiB
非压缩**（[changelog](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)）。
19.26 MiB ≪ 64 MiB ⇒ **包体积不构成不通过项**（但 +70% 会放大上传/发布窗口）。

部署后稳定性：SQLAlchemy POC worker 重新 deploy 后连续 20 次 `/health`：**20/20 = 200**，
首请求 1775ms（冷），后续约 196–268ms（热）。未观察到 isolate 启动失败（注意：POC
访问面很轻，不能外推生产流量）。

### 2.4 依赖切分 —— 建议（未落地，等 lead 裁决）

**worker-only（`backend/worker/pyproject.toml` 的 `[project].dependencies`，pywrangler
只读这一段）**：`fastapi`、`asyncpg`、`pydantic`、`pyjwt`、`python-multipart`、`bcrypt`；
`workers-runtime-sdk` 由 pywrangler 自动管理。

**local-only（绝不进 worker 包）**：`sqlalchemy`、`greenlet`、`alembic`、`psycopg2-binary`、
`oss2`、`minio`、`openpyxl`、`apscheduler`、`opentelemetry-*`、`langfuse`、`structlog`、
`prometheus-fastapi-instrumentator`、`slowapi`、`cachetools`、`uvicorn`、`httpx`、
`pydantic-settings`、`pyyaml`、`Pillow`、`passlib`。

落地方式建议（P3 时执行）：orchestrator 与 worker 各自保留 `pyproject.toml`；worker 的
`[project].dependencies` 只放上表第一行；local-only 放独立依赖组/文件（例如
`backend/local-requirements.txt` 或 orchestrator 的 `[project].dependencies`），
CI 增加产物审计：`worker/pylock.toml` 出现 local-only 名单即 FAIL + 部署后 import 探针。

> 本次 POC 观测到另一个风险：worker pyproject 若**不锁版本**，pywrangler 会解析到
> Pyodide 索引上的最新版（POC 得到 fastapi 0.146/pydantic 2.14.1/sqlalchemy 2.1.5），
> 与生产锁定的 fastapi 0.141.1/pydantic 2.12.5 不同。正式收敛必须显式锁版本。

### 2.5 部署形态验证 —— ✅ 通过（在独立 POC Worker 上）

- `wrangler versions upload` 对**不存在的 Worker** 报错 `You cannot upload a new version
  of a Worker that does not yet exist. Please run the deploy command first.` ⇒ 先用
  `pywrangler deploy` 创建**独立 POC Worker**（`kaas-poc-sqlalchemy`、`kaas-poc-baseline`，
  `workers_dev: true`，无自定义路由，与生产同名风险为零），随后 `versions upload`
  共 16 次全部成功（不接管流量；其中 1 次首跑报"Worker 不存在"后按此流程修正）。
- 真实边缘结果：`https://kaas-poc-sqlalchemy.dspro0124.workers.dev/health` → **200**，
  body 与本地一致（sqlalchemy OK / greenlet ModuleNotFoundError / asyncio ImportError）；
  `/sqla/select1` → **500**（ImportError 未捕获，FastAPI/ASGI 桥返回 Internal Server Error）。
- 生产 Worker `kaas`：只跑 `wrangler deploy --dry-run`（0 上传），未 deploy / 未 versions upload。
- 未采用 `wrangler dev --remote`：`versions upload` + 独立 Worker 已覆盖真实 runtime 启动验证。

## 3. 复现命令

完整步骤见 [`backend/worker/poc-sqlalchemy/README.md`](../backend/worker/poc-sqlalchemy/README.md)。
最小复现（依赖解析失败，无需 DB）：

```powershell
cd backend/worker/poc-sqlalchemy
uv venv --python cpython-3.14.2-emscripten-wasm32-musl
'greenlet' | uv pip compile - --python cpython-3.14.2-emscripten-wasm32-musl `
  --extra-index-url https://index.pyodide.org/314.0.7 --index-strategy unsafe-best-match --no-build
# 期望：Because all versions of greenlet have no usable wheels ...
```

## 4. 建议与下一步

1. **P0 出口判定：不过**。按 EXEC_PLAN Phase 0 约定，转路线 A′，`§3` 收敛步骤按 A′ 裁剪。
2. **A′ 可立即做**（零运行时风险）：把 SQL 语句/列清单/参数构造器收进 `kaas_common`，
   worker 的裸 asyncpg 只负责执行；注册类默认值/列清单漂移从"靠测试兜底"改为"同源"。
3. **可选强化（本次已实测可行，未做端到端）**：worker 侧装 **SQLAlchemy 同步 Core**
   只做 SQL 编译（`/sqla-core/compile` 返回编译后 SQL），执行仍用 asyncpg ——
   可让"SQL 生成器"与 orchestrator 共用 SQLAlchemy 方言/绑定参数，同时绕开 greenlet。
   代价：包体 +8.2 MiB、启动 +1.8s（同样吃冷启动预算），需权衡；不要为它引入 async engine。
4. **若仍想走路线 A**：唯一缺口是 greenlet 的 Workers/wasm 运行时支持（栈切换）。
   Pyodide 未提供该包，需自建 wasm 构建 + runtime 适配（Wasmer 有先例，但不在 0.5–1 天
   POC 范围，且与 Workers 启动快照模型冲突待评估）⇒ 应单独立项，不作为本轮收敛前提。
5. 文档同步：本次未改 `PROBLEM_STATUS_2026-10-11.md`（POC 临时结论，等 lead 裁决后再写）。

## 5. 证据与残留资源

- 原始样本/日志：`%TEMP%\kaas-saq-poc\`（`dev-*.log`、`deploy-*.log`）；
  关键数字已在上文表格中给出。
- POC 源码（未提交，未部署到生产）：`backend/worker/poc-sqlalchemy/`、
  `backend/worker/poc-baseline/`；本地 PostgreSQL 数据目录 `D:\kaas-poc\pgdata`。
- 独立 POC Worker（可随时删除，不影响生产）：
  `npx wrangler delete --name kaas-poc-sqlalchemy` /
  `npx wrangler delete --name kaas-poc-baseline`。
- 本地 PG 停止：`D:\kaas-poc\pginstall\bin\pg_ctl.exe -D D:\kaas-poc\pgdata stop`。
