# POC：Cloudflare Workers Python runtime 跑 SQLAlchemy（task-3 / P0）

> **仅 POC，未进生产 worker，不要 merge 进部署链。** 结论与数字见
> [`docs/POC_WORKER_SQLALCHEMY_2026-10-19.md`](../../../docs/POC_WORKER_SQLALCHEMY_2026-10-19.md)。
>
> 一句话结论：`sqlalchemy` 可 import，但 **asyncio 扩展硬依赖 greenlet，而 greenlet 在
> Pyodide/Workers runtime 没有可用 wheel** ⇒ `sqlalchemy.ext.asyncio` ImportError；
> 且加上 SQLAlchemy 后 `Worker Startup Time` 中位 +1.85s（超 <1s 门槛）。

## 目录结构

- `src/main.py` — FastAPI 探针 Worker（模块级 import 探针 + SQLAlchemy async / Core /
  裸 asyncpg 三组端点），任何 import 失败都不影响 worker 启动，以便拿到原始错误。
- `wrangler.jsonc` — 独立 POC Worker（`kaas-poc-sqlalchemy`，`workers_dev: true`，
  无自定义路由，复用生产 Hyperdrive config 只为本地 emulation）。
- `pyproject.toml` — `fastapi + asyncpg + sqlalchemy`（pywrangler 会按 Pyodide 索引解析）。
- `.dev.vars` — 本地 DSN（gitignored）。
- `../poc-baseline/` — 同一份探针代码**去掉 sqlalchemy**，用于冷启动/包体积对照。

## 前置

- node/npx 在 PATH（本机 `C:\Program Files\nodejs`）；wrangler 4.151+（`npx wrangler`）
- `uv` 0.12.3+；worker 的 `.venv` 里已有 `pywrangler`（1.17+）
- 本机无 Docker；用 `pgserver==0.1.4` 自带的 PostgreSQL 16.2 二进制起本地库
  （**必须放到纯 ASCII 路径**，中文用户目录会让 initdb 报
  `invalid byte sequence for encoding "UTF8": 0xba`）：

```powershell
# 1) 装 pgserver（Python 3.12；pgserver 无 cp313/cp314 wheel）
$tmp = "$env:TEMP\kaas-saq-poc"
uv venv "$tmp\pgvenv312" --python 3.12
uv pip install pgserver --python "$tmp\pgvenv312\Scripts\python.exe"

# 2) 二进制复制到 ASCII 路径并 initdb（locale=C 必带）
Copy-Item -Recurse "$tmp\pgvenv312\Lib\site-packages\pgserver\pginstall" 'D:\kaas-poc\pginstall'
D:\kaas-poc\pginstall\bin\initdb.exe -D D:\kaas-poc\pgdata -U postgres --auth=trust -E UTF8 --locale=C
D:\kaas-poc\pginstall\bin\pg_ctl.exe -D D:\kaas-poc\pgdata -l D:\kaas-poc\pg.log -o "-p 5432 -h 127.0.0.1" start

# 3) 造 POC 库/表（与任务清单的 users 表对应）
D:\kaas-poc\pginstall\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "CREATE DATABASE kaas_poc;"
D:\kaas-poc\pginstall\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d kaas_poc -c `
  "CREATE TABLE users (id serial primary key, email text not null unique, display_name text); INSERT INTO users (email, display_name) VALUES ('poc-a@example.com','A'),('poc-b@example.com','B');"
```

## 本地跑 POC（workerd emulation）

```powershell
$env:PYTHONUTF8='1'
$env:UV_PYTHON_INSTALL_DIR='D:\uv-python'   # 中文用户名需要 ASCII 目录
$env:UV_CACHE_DIR='D:\uv-cache'
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE='postgresql://postgres:postgres@127.0.0.1:5432/kaas_poc'

cd backend/worker/poc-sqlalchemy
..\.venv\Scripts\pywrangler.exe sync     # 解析/安装 pyodide 依赖到 python_modules/
..\.venv\Scripts\pywrangler.exe dev --port 8791

# 另开一个终端：
curl.exe -s http://127.0.0.1:8791/health              # 探针结果（sqlalchemy OK / greenlet FAIL）
curl.exe -s http://127.0.0.1:8791/sqla/select1         # 500（greenlet ImportError）
curl.exe -s http://127.0.0.1:8791/pg/users_count       # {"ok":true,"users_count":2}
curl.exe -s http://127.0.0.1:8791/sqla-core/compile    # 同步 Core 编译 SQL（可行）
```

## 边缘验证（只碰独立 POC Worker，**绝不 deploy 生产 `kaas`**）

```powershell
cd backend/worker/poc-sqlalchemy
npx --yes wrangler versions upload      # 首次会报 "Worker does not yet exist"
..\.venv\Scripts\pywrangler.exe deploy  # 仅创建 kaas-poc-sqlalchemy（独立名字/无路由）
npx --yes wrangler versions upload      # 之后每次 upload 都会返回 Worker Startup Time
# 边缘探针：
curl.exe -s https://kaas-poc-sqlalchemy.dspro0124.workers.dev/health
```

对照工程：`cd backend/worker/poc-baseline` 重复 `sync` / `deploy` / `versions upload`。

## 观察到的关键数字

| 项 | baseline | +SQLAlchemy |
|---|---|---|
| Vendored modules | 10,804.41 KiB / 516 | 19,251.86 KiB / 786 |
| Total Upload（非压缩） | 10,809.98 KiB | 19,257.44 KiB |
| gzip | 2,695.74 KiB | 4,535.80 KiB |
| Worker Startup Time（versions upload 中位） | 2059 ms | 3913 ms |

## 清理

```powershell
npx wrangler delete --name kaas-poc-sqlalchemy
npx wrangler delete --name kaas-poc-baseline
D:\kaas-poc\pginstall\bin\pg_ctl.exe -D D:\kaas-poc\pgdata stop
```
