# kaas-intel-worker

KaaS 平台「商情雷达」工位的后端 API，运行在 **Cloudflare Workers（Python）** 上，
通过 **Hyperdrive** 连接 Neon PostgreSQL。

## 技术栈

- Python Worker（Pyodide / CPython WASM，需 `python_workers` 兼容标志）
- FastAPI（经 `workers.asgi` 桥接）+ asyncpg（每请求连接，Hyperdrive 负责聚合）
- JWT (pyjwt) + bcrypt 认证，与 `backend/orchestrator` 的用户表完全兼容
- 数据库：Neon PostgreSQL（Hyperdrive config id 见 `wrangler.jsonc`）

## 本地开发

```powershell
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
# Hyperdrive 本地模拟：指向 Neon 连接串
$env:CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE = "postgres://..."
uv run pywrangler dev
```

首次需创建 `.dev.vars`（本地密钥，已 gitignore）：

```
JWT_SECRET=<随机值>
ADMIN_SETUP_TOKEN=<一次性初始化令牌>
```

## 测试

```powershell
# 冒烟测试：health/登录/CRUD/统计/渠道（12 项）
.\.venv-workers\Scripts\python.exe -u .tools\test_worker.py http://localhost:8791

# CSV 导入测试
..\orchestrator\.venv\Scripts\python.exe -u .tools\test_csv.py http://localhost:8791
```

## 部署

```powershell
uv run pywrangler secret put JWT_SECRET        # 生产随机密钥
uv run pywrangler secret put ADMIN_SETUP_TOKEN
uv run pywrangler deploy                       # 含 api.kaas.powervoy.com 自定义域名
```

线上地址：`https://api.kaas.powervoy.com`（worker: `kaas-intel-api`）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/bootstrap-admin` | 一次性初始化系统管理员（Bearer setup token） |
| POST | `/api/v1/auth/login` | 登录，返回 JWT |
| GET | `/api/v1/auth/me` | 当前用户 |
| GET/POST | `/api/v1/intel/shipments` | 货运记录列表（筛选/分页）/ 新建 |
| GET | `/api/v1/intel/shipments/{id}` | 货运记录详情 |
| POST | `/api/v1/intel/import/csv` | CSV 导入（中英双语列名映射） |
| GET | `/api/v1/intel/trade-stats` | 贸易统计 |
| GET | `/api/v1/intel/adapter-runs` | 采集任务运行记录 |
| GET | `/api/v1/intel/channels` | 数据源渠道（免费/付费） |
| GET | `/health` | 健康检查 |

## 已知限制（Python Workers beta）

- `asyncpg.create_pool` 在当前 runtime 会挂起 → 使用官方推荐的**每请求连接**模式。
- SQLAlchemy async ORM 不可用（缺 greenlet）→ 全部使用原生 SQL。
- 不要在 dev server 运行期间编辑 `src/main.py`：Windows 上热重载会触发 ECONNRESET 崩溃，
  改完代码需重启 `pywrangler dev`。
- 首次 `uv run pywrangler dev` 若报 pyodide 解释器错误：设置
  `$env:UV_PYTHON_INSTALL_DIR` 与 `$env:UV_CACHE_DIR` 到纯 ASCII 路径（中文用户名会乱码）。
