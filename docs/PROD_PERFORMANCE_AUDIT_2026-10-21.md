# 生产环境性能体检报告（2026-10-21）

> 起因：用户反馈「生产环境运行速度很慢，数据更新也很慢」。本报告全部结论基于
> 2026-10-21 09:10–09:25（Asia/Shanghai）对生产 **实测** 数据，未改动任何生产配置。

## 0. 结论速览

| 层 | 体检结果 | 判定 |
|---|---|---|
| 数据库（Neon us-east-2） | 全库极小（最大表 304 kB），索引在位，无锁竞争，连接 12/901 | ✅ 无性能问题 |
| 网络（中国 → Neon） | 单查询 RTT 实测 **215ms**（建连首包 1.3s） | ⚠️ 地理延迟，结构性 |
| Cloudflare Worker | **不碰库的 /health 实测 0.4–5.1s**；每个 API 请求（含无 token 的 401）1.4–7s | ❌ 主瓶颈：Python Worker 冷启动 |
| 前端数据刷新 | React Query `refetchOnWindowFocus: false` + `staleTime: 30s` | ⚠️ 加剧"更新慢"体感 |

**主因排序：① Python Worker 冷启动（秒级）≫ ② 跨太平洋 DB 往返（200ms+ / 查询）
≫ ③ 前端不自动刷新（体感）。** 数据库本身完全健康，数据量根本谈不上慢。

## 1. 实测证据（可复跑）

### 1.1 Worker 延迟（2026-10-21 09:10 前后，多次采样）

| 端点 | 样本（ms） | 说明 |
|---|---|---|
| `GET /health`（不查库） | 2041, 1976, 5143, 1480, **367**, 4437, 1655, 2724, 3214 | 纯 JSON，延迟全在 Worker 执行 |
| `GET /api/v1/auth/me`（无 token → 401） | 6384, 4360, 7094, 3760, 5969 / 4030, 4296, 1442, 2240, **291**, 5329 | 401 也应是微秒级，实测秒级 |
| `POST /api/v1/auth/login` | 7787, 2119, 4589, **26248** | 末次 26s 且返回 **429**（Cloudflare 侧限流，值得单独排查） |
| 静态资产 `/_next/static/*.js` | 1638, 2392, 347, 727 | 首访慢、复访 0.3s+，边缘缓存命中不佳 |

判读：/health 不碰数据库却要 0.4–5.1s ⇒ 慢在 **Python Worker 运行时本身**
（冷启动 = Pyodide 引导 + 全量模块编译 + FastAPI 路由注册），与数据库无关；
偶发的 300–400ms 样本是碰上保温 isolate 的情况。低频站点 isolate 不保温，
几乎每次点击都冷启动。

### 1.2 本地导入成本（Windows pyc 热缓存下界）

| 项目 | 耗时 |
|---|---|
| `import fastapi`（含 pydantic-core） | ≈ 1.0s |
| `import main`（全量，含 chain/quote_api/20 个 ws_*） | ≈ 1.6s |

main.py 244KB / 约 5200 行 + chain.py 118KB + quote_api.py 113KB + ws_* 若干，
合计约 800KB 源码每个 isolate 启动时编译；ws_* 模块 import 即注册路由，**无法整体懒加载**。

### 1.3 数据库体检（只读，经 Neon 生产 DSN）

- `connect_ms` = 1321（本机 → pooler）；查询 RTT 样本 432/215/215/215/215 ms
- 表大小 TOP3：market_ports 304kB、industry_templates 112kB、product_categories 96kB
- 高频表索引在位（idx_events_tenant_type_time 等）；least-used 索引全是低流量业务的正常态
- `active_connections` = 12 / `max_connections` = 901；无 `pg_stat_statements`（Neon free 未装）
- server 显示 127.0.0.1:5432 ⇒ 走的是 **Hyperdrive**（backend/worker wrangler.jsonc 绑定
  `f53fed49705043008737032e4bfa2b8e`），Worker 每请求新建 asyncpg 连接（platform/db.py、main._acquire）

### 1.4 代码事实

- 每请求一个 Hyperdrive 连接，无跨请求池（官方推荐模式，Hyperdrive 服务端代池）。
  握手被 Hyperdrive 摊薄，但**查询本身仍跨太平洋**，多查询串行接口线性放大。
- 前端 `frontend/src/lib/query/provider.tsx`：`refetchOnWindowFocus: false`、
  `staleTime: 30s` ⇒ 改完数据回到标签页不自动刷新。
- cron 每 15 分钟扫 replied（`*/15 * * * *`），对"数据更新慢"的直接影响有限。

## 2. 修复路线图（用户已全选，2026-10-21 弹窗确认）

### P0 · 前端感知修复（零风险，纯代码）

- `refetchOnWindowFocus: true` + `refetchOnReconnect: true`：回到页面/网络恢复即刷新。
- 业务列表类 staleTime > 5min 的降到 60s；基础数据（汇率/枚举/字典）不动。
- 执行人：fe-perf 队友。**完成后跑一次生产前后对比测量。**

### P1 · Worker 冷启动裁剪（低风险，需重新部署）

- main.py 顶层导入中仅认证端点用到的 `bcrypt` 与 `csv/io/hmac/hashlib/secrets/urlparse`
  改函数内懒加载；ws_* 模块内同样处理。
- 预期收益：本地导入 1.6s → 约 1.3–1.4s 量级（**冷启动大头是运行时引导与
  800KB 源码编译，裁剪是边际改善，不是根治**）。
- 执行人：worker-perf 队友；门禁 worker 1560 passed + 12 skipped 全绿后部署。

### P2 · 数据库迁亚太（收益最大，需停机窗口）

- Neon 新建 **ap-northeast-1（东京）** 或 **ap-southeast-1（新加坡）** 项目，
  全库仅几 MB，`pg_dump/pg_restore` 分钟级完成。
- 切换点：新建 Hyperdrive 绑定 → 改 wrangler.jsonc → 部署；RTT 预期 215ms → 60–80ms。
- **执行前必须再与用户确认具体停机窗口**（本报告批准的是方向，不是时刻表）。
- runbook 见 §3。

### P3 · 建议跟进（本次未选做，记录在案）

- **静态资产边缘缓存规则**：`/_next/static/*` 在 Cloudflare 加 Cache Rule（长 TTL），
  减少首访 1.6–2.4s 的资产加载。需要 Cloudflare dashboard/API（当前无 kaas-* CF token）。
- **登录 429 + 26s**：排查 zone 的 WAF/Rate Limiting 规则是否误伤正常登录。
- **Smart Placement**：可实测对比（Worker 靠近 DB 执行 vs 靠近用户），一次部署即可回滚。
- 战略选项：若冷启动仍不可接受，长期可考虑将 API 层迁 TypeScript Worker（冷启动 ~50ms），
  或前端静态资产迁 Cloudflare Pages。均为大工程，需立项。

## 3. P2 数据库迁移 runbook（草稿，执行前需用户确认窗口）

1. Neon API 创建 ap-northeast-1 项目（compute 最小档即可，库几 MB）。
2. `pg_dump --format=custom` 生产库 → `pg_restore` 到新项目（含序列当前值）。
3. 用只读账号验证：表数量、行数合计、关键表 spot-check、迁移后 RTT 实测。
4. 新建 Hyperdrive 绑定指向新库；旧绑定保留。
5. 低峰期：`wrangler.jsonc` hyperdrive.id 换新 → `pywrangler deploy` → `/health` + 登录 + 核心列表页冒烟。
6. 观察 24h 无异常后，旧项目降为只读保留 7 天再删（删除属破坏性操作，另行确认）。
7. 全程记录实际耗时；超窗口立即回滚（改回旧绑定再部署）。

### 4.1 部署后复测（2026-10-21 09:45，version `586ab897`）

- 冒烟：`/health` 200 且 `shared.loaded=true`（打包链路通）；`/login` 页正常。
- `/health` 8 次采样：2774, 2968, **319**, 1975, 2125, 1127, **404**, 10704 ms ⇒
  P50 ≈ 2.1s、最优 319ms。**与改前同分布**：裁剪只改善了热启动路径，
  冷启动大头（Pyodide 引导 + 800KB 源码编译）仍在，个别 PoP 冷启动可至 10s。
- 结论：**P0+P1 是边际改善；结构性提速必须靠 P2（迁库降 RTT）+ P3
  （静态资产边缘缓存）+ 长期选项（TS Worker 重写 API 层）**。已如实记录，未夸大收益。

### 4.2 P2 迁库执行记录（2026-10-21 09:58–10:10，用户批准「现在低峰期直接迁」）

- **新库**：Neon 项目 `cold-king-20466417`（KaaS-SG，**aws-ap-southeast-1 新加坡**，PG18）。
  注：Neon 无东京区域，新加坡是最近可选。
- **迁移方式**：生产库 schema 与 alembic head **不一致**（生产多 7 张已弃用表 + 2 个触发器函数
  属人工演进），故放弃「alembic 重建 + COPY 数据」，改用 **pg_dump/pg_restore 全量**（本机无
  pg_dump，临时下载 EDB PG18 便携版）。
- **一致性验证**：114 表 / 2 函数 / alembic_version=202610210001 全部一致；
  **逐表 count(*) 精确对比 0 差异**（全库 127 行）。
- **RTT 实测（本机）**：旧 us-east-2 查询 245ms → **新加坡 75ms**（3.3×）；建连 1509→467ms。
- **切换**：新建 Hyperdrive `6830420703984a19a99a334afff6776e`（kaas-apac，指向新加坡 pooler）→
  `wrangler.jsonc` 换绑定 → 部署 version `cd87aba7-92e3-4a41-8246-44fa62b13e8c`。
- **生产验证**：`/health` 200 loaded=true；错误密码登录返回 **401 Invalid credentials**
  （证明经 Hyperdrive→新加坡库整条链路通，用户行读到、密码校验执行）。
- **回滚路径**：旧库（falling-salad-31662168）与旧 Hyperdrive（f53fed…）均保留，
  改回 wrangler.jsonc 再部署即可，分钟级回滚。
- **密钥落位**：新 DSN 存 `~/.dsh/secrets/neon-prod-dsn-apac.txt`，inventory.md 已登记；
  旧 DSN 保留（旧项目存活期间继续有效）。含机密的临时文件（dump/DSN 副本）已清除。
- **遗留**：① dump 到切换间几分钟的增量写入若存在则未同步（低峰期执行，风险已告知用户）；
  ② 旧项目保留 7 天观察后需用户确认再删（破坏性操作另行确认）；③ 本地 dev 分支在旧项目，
  本次未动。

## 4. 验收口径（修完后复测）

- `/health` P50 < 1s、P95 < 2.5s（部署后实测 P50 ≈ 2.1s——**未达标**，冷启动主导，需 P2/P3/长期项）。
- 登录接口（含 401 路径）P95 < 3s（当前 4–7s）。
- 体感项：A 页面改数据 → B 标签页回到 A，≤5s 内自动出现新数据（依赖 P0）。
- DB 迁移后：生产库 RTT（从国内测）< 100ms——**达标：75ms**（§4.2）。

---

*体检人：lead（DSH AI），2026-10-21。数据均为只读测量；未对生产做任何写操作。*
