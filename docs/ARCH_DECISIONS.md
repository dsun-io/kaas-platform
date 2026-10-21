# 架构决策记录（ARCH DECISIONS · ADR 简化版）

> 建档：**2026-10-21**（STRUCTURAL_DEBT S-6「技术选型无论证留痕」治理；见
> [`STRUCTURAL_DEBT.md`](./STRUCTURAL_DEBT.md) S-6 与 [`OPTIMIZATION_PLAN_2026-10-21.md`](./OPTIMIZATION_PLAN_2026-10-21.md) §3）。
> 本项目此前无 ADR 纪律，本文件为**第一版**，首批补录 7 条历史选型决策。
>
> **格式约定**：每条含 编号 / 标题 / 状态 / 背景 / 备选方案 / 决策 / 理由 / 重新评估条件。
> 状态取值：`已决策`（现行有效）/ `已决策 → 已被新决策取代`（注明取代者与文档链接）。
> **新决策从此文件开始先立 ADR 再动手**——W3 TS Worker 迁移（OPTIMIZATION_PLAN §2）期间
> 框架选型（Hono/Node）等必须逐条在此登记。

---

## ADR-001 · raw asyncpg 直连，不用 ORM

- **状态**：已决策（现行有效）
- **背景**：Worker 端要把生产 API 跑在 Cloudflare Python Workers（Pyodide）上，数据访问层选型未定。
- **备选方案**：① SQLAlchemy async + asyncpg；② ORM 留在 orchestrator、Worker 只调远程 API；③ raw asyncpg 直连。
- **决策**：Worker 端一律 **raw asyncpg**（`$1` 占位符手写 SQL），jsonb 列经 `dbjson.row_to_dict(row, 表名)` 统一解码。
- **理由**：SQLAlchemy async 依赖 greenlet，**Workers/Pyodide 无 greenlet 支持**，方案①在目标运行时根本跑不起来（`backend/worker/src/main.py` 头注释、`quote_api.py` 头注释均留证）；方案②会再造一次双后端路由漂移（本项目历史上已为此付过 ROUTE_PARITY 的代价）。raw asyncpg 零额外依赖、SQL 显式可审计。
- **重新评估条件**：W3 迁 TS Worker 后（OPTIMIZATION_PLAN §2），TS 侧驱动选型（postgres.js 等）另行立 ADR；若 Python Worker 提前退役，本条随退役归档。

## ADR-002 · 无 Redis / 消息队列

- **状态**：已决策（现行有效）
- **背景**：本地开发环境曾长期带着一个 Redis 容器，但运行时从未真正接线。
- **备选方案**：① 真接线（缓存/队列）；② 删除 Redis，需要队列语义时用 PG 表 + cron（现状即此形态：`ws_cron.py` 三条 CronTrigger + `domain_events` 设计预留）。
- **决策**：**移除 Redis，不引入独立消息队列**。2026-10-21 从 `docker-compose.yml` 删除 Redis 服务并留注释；「删除或真接线二选一」的悬置项以删除收口。
- **理由**：运行时无任何 redis 客户端引用，留着容器是纯误导；当前负载（单租户工位 SaaS、异步需求 = 三条定时 cron + 事件落 PG）用 PG + cron 足够，引入 Redis 多一个运维面与故障点，免费版额度也不支持再铺一层有状态服务。
- **重新评估条件**：出现以下任一即重评：① 需要秒级异步任务（邮件/渲染扇出超过 cron 分钟级粒度）；② 多 Worker 实例间需要分布式锁/去重；③ 读多写少热点查询实测打满 Hyperdrive。

## ADR-003 · 文件本体三级落点：R2 binding 优先 → S3 预签名 → inline 兜底

- **状态**：已决策（现行有效）
- **背景**：产品图 / 客户盖章回传件 / 系统 PDF 要存对象存储；Worker 内可用手段有 R2 binding、S3 兼容 API、数据库 bytea 三种，上传失败的处理也需定口径。
- **备选方案**：① 只走 R2 binding；② 只走 S3 预签名（浏览器直传）；③ 三级落点 + 显式回退；④ 上传失败直接 500 报错。
- **决策**：**③**。写路径：优先 R2 binding（`from js import FILES`，免密钥）；未配 S3 密钥时由平台 S3 预签名接管直传（`ws_files.py` 文件本体注释：S3/R2 binding/inline 三态）；任一落点异常**自动回退 inline（写 `file_objects.content`）**并如实记 `storage` 实际落点。读路径同理由 `presign_get_url` 出签名 URL。
- **理由**：上传是用户显式动作，**不能因绑定/配置问题直接失败**；行内记录真实落点可审计、可后补迁移。binding 优先因为免密钥、少一跳；S3 预签名给浏览器直传省 Worker 带宽与内存（Worker 单请求内存有限）。
- **重新评估条件**：① inline 兜底写库导致 `file_objects` 体积显著膨胀（审计当前落点分布）；② TS 迁移后（W3 Phase 2 第 4 域）重写该链时逐字节对齐回归；③ R2/S3 密钥管理策略变化（如全面改 dashboard 颁发）。

## ADR-004 · Hyperdrive 每请求直连，无跨请求连接池

- **状态**：已决策（现行有效）
- **背景**：Worker 与 Neon Postgres 之间经 Hyperdrive 连接；连接粒度（每请求新建 vs Worker 级常驻池）需定。
- **备选方案**：① Worker 级 asyncpg Pool 常驻复用；② 每请求 `asyncpg.connect` 直连，靠 Hyperdrive 服务端池化。
- **决策**：**②**。`platform/db.py` 的 `acquire` docstring 与 `main._acquire` 同语义：每请求建立一个 Hyperdrive 连接，请求结束关闭，代码侧不保留任何跨请求连接。
- **理由**：Cloudflare 官方推荐模式——Hyperdrive 在边缘侧做连接池与预热，Worker 端无需（也不应）再池化；Workers isolate 模型下常驻池反而引入生命周期管理难题（isolate 随时被回收，池内连接可能已失效）。
- **重新评估条件**：① Hyperdrive 官方推荐模式变更；② 实测建连开销成为瓶颈（2026-10-21 性能审计 §4.2：迁新加坡后建连 1509→467ms、查询 RTT 245→75ms，当前不是瓶颈）；③ TS 迁移后 postgres.js 驱动语义不同需重评。

## ADR-005 · 生产 API 由 Python Worker（FastAPI on Workers）承载

- **状态**：**已决策 → 已被新决策取代（2026-10-21）**
- **背景**：2026-09 双后端收敛评估选定由单个 Cloudflare Worker 承载生产 API（`python_workers` 运行时上跑 FastAPI，`wrangler.jsonc` 的 `compatibility_flags` 留证），dev 侧 orchestrator 逐步让位。
- **备选方案**：当时可选：① Python Worker（FastAPI + Pyodide）；② TypeScript Worker（Node 运行时）。
- **决策（历史）**：选 Python Worker，复用 `kaas_common` 纯标准库内核一套代码两端跑，避免当时重写全部业务逻辑。
- **理由（历史）**：团队全部业务资产在 Python；内核刻意保持纯 stdlib 正是为了能在 Pyodide 里跑；TS 重写成本高而当时无迁移预算。
- **取代**：**2026-10-21 用户拍板全量迁 TS Worker**（Hono + Node，分四阶段，3–5 周）——见 [`OPTIMIZATION_PLAN_2026-10-21.md` §2 W3](./OPTIMIZATION_PLAN_2026-10-21.md)。拍板动因：Python Worker 冷启动编译 ~800KB 源码每 isolate 0.4–5.1s（`PROD_PERFORMANCE_AUDIT_2026-10-21.md` §1.4）、bundle 11.7MB、巨石不可懒加载。迁移完成后 Python Worker 退役（W4），本条归档为历史。
- **重新评估条件**：W3 任一 Phase 金标对照发现 TS 无法无损承载某域（如纯 stdlib xlsx 读取无等价物）时回到用户拍板。

## ADR-006 · 兄弟模块用「文件末尾 import 挂载」，不用 APIRouter

- **状态**：已决策（现行有效，但对 W3 为过渡形态）
- **背景**：`main.py` 膨胀后需拆出兄弟模块（`chain.py` / `quote_api.py` / 各 `ws_*.py`），挂载方式需定。
- **备选方案**：① FastAPI `APIRouter` 显式注册；② 独立模块在文件尾由 `main.py` 的 `import chain` 等副作用挂载（模块导入时执行路由装饰器完成注册）。
- **决策**：**②**。模块头注释留证（`chain.py`：「由 main.py 文件末尾 `import chain` 挂载，复用 main 的 app / 鉴权 / 连接封装」；`quote_api.py`：「独立模块 + main.py 末尾 import 挂载，chain.py 已证明这条路可行」）。
- **理由**：`platform` 目录与 Python 标准库同名只能按文件加载（素材见 `platform/db.py` 头注释），包级导入本就受限；副作用挂载让模块零样板直接复用 `main` 的 `app` / 鉴权 / 连接封装，新增工位照抄即可。代价（循环 import 需 noqa 压制、私有函数跨文件硬引用 44 处）已登记为 STRUCTURAL_DEBT S-1/S-2。
- **重新评估条件**：W3 迁 TS Worker 后此约定**整体作废**（Hono 应用天然分模块注册）；届时 S-1/S-2 以「被 W3 解决」销账。

## ADR-007 · 生产库迁 Neon 新加坡（aws-ap-southeast-1）+ 新建 Hyperdrive 绑定

- **状态**：已决策（2026-10-21 执行完成，现行有效）
- **背景**：2026-10-21 性能体检（`PROD_PERFORMANCE_AUDIT_2026-10-21.md` §4.1）实测查询跨太平洋：生产库在 Neon `us-east-2`，国内用户 RTT 245ms，多查询串行接口线性放大；P2 项建议迁东京或新加坡。
- **备选方案**：① 不迁库，靠 Hyperdrive 摊薄建连；② 迁 Neon 东京（ap-northeast-1）；③ 迁 Neon 新加坡（ap-southeast-1）。
- **决策**：**③**。2026-10-21 09:58–10:10 用户批准「现在低峰期直接迁」，新建 Neon 项目 `cold-king-20466417`（KaaS-SG，aws-ap-southeast-1，PG18）+ 新 Hyperdrive `6830420703984a19a99a334afff6776e`（kaas-apac，指向新加坡 pooler）切换。
- **理由**：Neon 免费档无东京区域，新加坡是最近可选；RTT 实测 245→75ms（3.3×）、建连 1509→467ms（§4.2 执行记录）。回滚路径保留：旧库 `falling-salad-31662168` 与旧 Hyperdrive（f53fed…）不删，2026-10-28 复查后请用户确认清理（破坏性操作须确认）。
- **重新评估条件**：① 2026-10-28 复查确认回滚路径可清理；② 用户分布变化（如出现大量欧美用户）需重新权衡区域；③ Neon 开放东京免费档或免费档策略变化。

---

*维护纪律：新选型先立 ADR（状态=已决策）再实施；决策被取代时不删条目，改状态并链接取代者；
每条重新评估条件被触发时，由当时接手 agent 在本文件续写新条目而非覆盖旧条目。*

## ADR-008 · TS 门面 + Python 内核两层架构（2026-10-21，现行架构）

| 字段 | 内容 |
|---|---|
| 状态 | **已决策**（取代 ADR-005 的「Python Worker 承载全部」；ADR-005 保留为历史） |
| 背景 | 用户反馈生产慢，体检定位主因=Python Worker 冷启动（/health 0.4–5.1s，PROD_PERFORMANCE_AUDIT_2026-10-21 §1.1）。初版计划全量迁 TS Worker；用户提出系统定位=智能制造业务管理+工位化+未来 AI+对外 MCP/API，Python 在 AI/数据/业务规则生态占优，且金标资产最厚的 kaas_common 引擎是 Python——全量重写牺牲生态、风险最大。 |
| 备选方案 | ① 全量迁 TS：冷启动全消但引擎重写风险最大、AI/数据生态转 TS；② 不迁、Python 侧缓解（Smart Placement/保温）：实测边际改善，根治不了；③ **分层：TS 门面 + Python 内核（选定）**。 |
| 决策 | 两层永久架构：**TS Worker(Hono)=对外唯一门面**（全部 UI 面路由、鉴权/会话/CRUD/文件、对外 MCP+REST 网关，冷启动 ~50ms）；**Python Worker=智能/计算内核**（kaas_common 报价/单证引擎、未来 AI/数据能力、cron 3 条），经 **Service Binding**（同账号 Worker 互调，免费档可用）被门面调用。生产域名 kaas/api.powervoy.com 指门面；Python Worker 保留内部域。 |
| 理由 | ① 体感速度由门面层决定，引擎端点本就以秒计（loading 呈现）；② 引擎零重写，语义漂移风险归零；③ 免费版配额按 Worker 独立计，多一个 Worker 不摊薄额度，内核 Worker 0 公网请求（service binding 不计请求配额）；④ 对外 MCP/REST 在 TS 生态是一等公民。 |
| 重新评估条件 | ① Service Binding 契约漂移频繁出现且 harness 拦不住；② Python Worker 出现免费档跑不动的负载（CPU 10ms/请求超限）；③ Cloudflare 推出 Python 冷启动根治方案（原生 CPython/快照），届时可回归单运行时。 |
| 防漂移铁纪律 | 业务规则只在 Python 内核一处实现；TS 门面只做鉴权/参数校验/协议转换，禁止业务 if；TS 侧 zod schema 从 Python pydantic 模型代码生成，禁止手抄；金标 harness（backend/ts-migration/golden/）常态化 diff。 |
