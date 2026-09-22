# kaas Worker (生产单 Worker)

KaaS 平台**生产后端**：单 Cloudflare Worker `kaas`（Python FastAPI + 静态资产），
通过 **Hyperdrive** 连接 Neon PostgreSQL。

- `/api/*` → FastAPI（本目录 `src/`，原生 asyncpg 手写 SQL）
- 其余 → ASSETS（Next.js 静态导出，`../../frontend/out`，SPA 回退）
- 自定义域名：`kaas.powervoy.com`（前端+API 同源）与 `api.kaas.powervoy.com`（仅 API）

## 技术栈

- Python Worker（Pyodide / CPython WASM，需 `python_workers` 兼容标志）
- FastAPI（经 `workers.asgi` 桥接）+ asyncpg（每请求连接，Hyperdrive 负责聚合）
- JWT (pyjwt) + bcrypt 认证，与 `backend/orchestrator` 的用户表完全兼容
- 数据库：Neon PostgreSQL（Hyperdrive config id 见 `wrangler.jsonc`）

## 本地开发

```powershell
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
$env:PYTHONUTF8 = "1"   # 否则 wrangler.jsonc 中文注释在 GBK 下解析失败
# 中文用户名需把 pyodide 解释器放到纯 ASCII 路径
$env:UV_PYTHON_INSTALL_DIR = "D:\uv-python"; $env:UV_CACHE_DIR = "D:\uv-cache"
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

线上地址：`https://kaas.powervoy.com` / `https://api.kaas.powervoy.com`（worker: `kaas`，
workers.dev 默认关闭；旧名 `kaas-intel-api` 已合并为单 Worker，见 `DEPLOY.md`）。

## 源码结构

- `src/main.py` — 核心 API：认证、商情雷达 (intel)、客户/询盘、报价、订单、出运、单证、订阅等
- `src/chain.py` — P1-P7 工位链（raw asyncpg 移植，由 `main.py` 末尾 `import chain` 挂载）：
  AI 层（任务/Provider/绑定/用量）、开发工位+线索池（leadgen runs/leads/scan-replied）、
  触达工位（mailboxes/campaigns/messages/webhook 预留）
- 出站 HTTP（AI Provider / Resend）双后端：`from js import fetch`（Pyodide）→
  ImportError 回退 `urllib.request`（本地 CPython）

## API 一览

### 核心（main.py）

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

### 工位链（chain.py）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/v1/ai/tasks` `…/task-bindings` `…/ai/providers/{name}` | AI 任务元信息 / 绑定（启用+Provider）/ BYOK Provider 配置 |
| POST | `/api/v1/ai/tasks/{key}/run` `…/providers/{name}/test` | 任务执行（模板兜底，全程落 usage）/ 连通性测试 |
| GET | `/api/v1/ai/usage` | 用量审计（items + stats） |
| GET/POST | `/api/v1/leadgen/runs` `…/runs/from-csv` | 抓取运行（demo/CSV，config_hash 幂等） |
| POST | `/api/v1/leadgen/validate` | 配置校验（AI 任务） |
| GET/POST/PATCH | `/api/v1/leads[/{id}]` | 线索池（共享表，跨工位状态只读） |
| POST | `/api/v1/leads/scan-replied` | replied 扫描建询盘（Worker 无 cron，手动触发） |
| GET/POST/PATCH | `/api/v1/outreach/mailboxes[/{id}]` `…/test` | 发件邮箱（单默认，Resend） |
| GET/POST | `/api/v1/outreach/campaigns` `…/{id}/send` | 活动 + 发送（原子抢占，失败可 retry） |
| GET/POST | `/api/v1/outreach/messages[/{id}/retry]` | 消息列表/详情/重发 |
| * | `/api/v1/outreach/webhook` | 501 预留（inbound 回写） |

订阅治理：leadgen/outreach 端点未订阅返回 404 `SUBSCRIPTION_REQUIRED`；`/ai/*` 不查订阅。

## 已知限制（Python Workers beta）

- `asyncpg.create_pool` 在当前 runtime 会挂起 → 使用官方推荐的**每请求连接**模式。
- SQLAlchemy async ORM 不可用（缺 greenlet）→ 全部使用原生 SQL。
- 不要在 dev server 运行期间编辑 `src/main.py`：Windows 上热重载会触发 ECONNRESET 崩溃，
  改完代码需重启 `pywrangler dev`。
- 首次 `uv run pywrangler dev` 若报 pyodide 解释器错误：设置
  `$env:UV_PYTHON_INSTALL_DIR` 与 `$env:UV_CACHE_DIR` 到纯 ASCII 路径（中文用户名会乱码）。
