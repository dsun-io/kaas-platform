# 认证与数据库连接从 Pyodide 内核拆分到 TS 网关 · 设计与执行方案

> 日期：2026-10-24 · 状态：**设计已定稿，待用户批准后实施**（未提交、未部署）
> 关联事故：docs/INCIDENT_2026-10-24_KERNEL_502.md（生产 502 根因取证）
> 关联架构：ADR-008 两层架构、docs/OPTIMIZATION_PLAN_2026-10-21.md §TS3

## 0. 为什么要做这件事（本次事故的直接结论）

2026-10-24 生产事故的根因**不在业务代码**，而在 Cloudflare Python Worker 的运行时初始化：

```
NoGilError: Attempted to use PyProxy when Python GIL not held
  at async preparePython (pyodide:python-entrypoint-helper:230:28)
  at async initPyInstance (pyodide:python-entrypoint-helper:328:36)

PythonError: SystemError: Cannot enter a promising task from inside another running promising task.
             This is a bug in Pyodide.
  at callPyObjectKwargsPromising
  at async initPyInstance (pyodide:python-entrypoint-helper:291:17)
```

- wrangler tail 抓到的 **24/24 异常全部发生在 `initPyInstance`（Python 实例初始化）**；
- 当日内核 `kaas` 统计：`scriptThrewException` 3030 次、错误率约 56%；门面 `kaas-edge` 1821 请求 **0 错误**；
- 内存分位已到上限边缘：success 的 memoryUsageBytes **P99 最高 137.5MB**（Workers 上限 128MB）；
- 失败请求 cpuTimeP50 仅 274–1293µs（**启动期即崩**），成功请求 wallTimeP50 最低 5987ms（**每次请求都在付完整初始化成本**）。

**结论**：只要"带登录的业务请求必须经过 Python 实例初始化"，平台侧的初始化抖动就会 100% 转嫁成用户端 502。
把**认证与数据库连接**从 Python 内核移出，等于把"用户能不能打开页面"从"Pyodide 能否初始化"里解耦。

## 1. 目标与非目标

**目标**
1. 认证（JWT 校验、登录、口令校验）与数据库连接（Postgres 查询/事务）**只存在于 TS 门面**；
2. Python 内核保留 AI/报价引擎/单证渲染等 **Python 特有计算能力**，通过 Service Binding RPC 被按需调用，**不持有数据库连接、不校验用户 JWT**；
3. 外部 API 契约（路径/方法/状态码/响应体/错误信封）**保持不变**；
4. 内核即使初始化失败，控制台主要页面（产品/客户/订单/审批/通知/仪表盘）仍可用；
5. 可灰度、可一键回退。

**非目标（明确不做）**
- 不把 AI 推理、报价引擎、单证渲染、caas_common 业务规则改写成 TypeScript；
- 不重写 `kaas_common/export_quote`、`kaas_common/trade_doc` 的算法；
- 不在本期改动 MCP server、cron 语义。

## 2. 现状事实（本次逐项核对，非推测）

| 事实 | 证据 |
|---|---|
| 门面**已具备** Hyperdrive 直连能力 | `backend/ts-worker/src/db.ts`（postgres.js，每请求连接，`prepare:false`，语义对齐 `platform/db.py`） |
| 门面**已具备** JWT 校验 | `src/auth.ts` `verifyToken`（HS256，与 Python 同 secret/claims）、`src/session.ts` `requireUser` |
| 门面**已具备**内核 Service Binding + 短时效内部 JWT | `src/proxy.ts` `forwardKernelRequest` / `mintInternalJwt`（TTL 60s，不转发 `kaas_oat_` 明文） |
| 门面已直连 DB 实现 193 条路由中的大部分 | `src/routes/{customers,orders,teams,files,admin,auth,...}.ts` |
| 仍有 **85 条**前缀透传 + 若干**显式透传**业务端点留在内核 | `backend/ts-migration/route-classification.md` §1 |
| 内核耦合规模 | main.py：**79 处** `get_current_user` 依赖、**242 处** SQL 调用点；另有 20 个 `ws_*.py` 模块（如 `ws_files.py` 22 处鉴权、`ws_docs_hardening.py` 13 处） |
| 内核 DB 访问方式 | `backend/worker/src/platform/db.py`：asyncpg + Hyperdrive，每请求连接 |
| 匿名健康探针会掩盖故障 | 事故期间 `/health`、`/health?deep=1` 一直返回 ok（匿名请求不触发鉴权路径），而带 JWT 请求成片 502 |

## 3. 职责拆分表

分类口径：**TS-DB** = 门面直连 Hyperdrive 完成（鉴权+SQL+序列化）；**Py-RPC** = 保留 Python 计算，门面供数、内核返回结果；**保持** = 本期不动。

### 3.1 认证域（全部 → TS-DB）

| 路由 | 现在 | 目标 | 备注 |
|---|---|---|---|
| `POST /auth/login` | 内核（bcrypt 校验 + 签发 JWT） | **TS-DB** | 需在 TS 侧校验 bcrypt 哈希，见 §7 决策 D1 |
| `GET /auth/me` | 内核心（`_get_current_user` + DB） | **TS-DB** | 门面已可解析 claims，补一条 users 查询 |
| `POST /auth/logout` | 内核 | **TS-DB** | 仅会话/审计写 |
| `POST /auth/change-password` | 内核（bcrypt） | **TS-DB** | 同上 D1 |
| `POST /auth/forgot-password` / `reset-password` | 内核（bcrypt + Resend） | **TS-DB** | Resend 门面已有绑定 |
| `POST /auth/register` | 内核 | **TS-DB** | 含客户编码生成，需把编码规则单源化（见 §7 D2） |
| `POST /auth/bootstrap-admin` | 内核（ADMIN_SETUP_TOKEN） | **TS-DB** | 门面已有该 secret |

### 3.2 控制台热路径（P0，本次事故里刷屏的端点）

| 路由 | 现在 | 目标 | 理由 |
|---|---|---|---|
| `GET /products` | 透传内核 | **TS-DB** | 产品页首屏，事故中成片 502 |
| `GET /products/{key}/profile` | 透传内核 | **TS-DB** | 同上 |
| `GET /products/{key}/media` | 透传内核 | **TS-DB** + 图片字节仍走 `/file-objects/{id}/content`（见 3.4） | 同上 |
| `GET /notifications/unread-count` | 透传内核 | **TS-DB** | 每个页面都会拉，事故中大量 502 |
| `GET /approvals?view=pending...` | 透传内核 | **TS-DB** | 待办角标 |
| `GET /dashboard/*`（3 条） | 透传/部分门面 | 先 **TS 取数 + Py-RPC 聚合**，后收敛 | `receivable_summary` 是口径唯一实现，禁止第二份（见 §7 D3） |

### 3.3 其余业务 CRUD

| 域 | 路由数 | 目标 |
|---|---|---|
| customers | 21 | TS-DB（门面已大部分实现，补齐显式透传项） |
| teams | 19 | TS-DB |
| orders | 24 | TS-DB |
| files（元数据） | 9 | TS-DB |
| outreach | 12 | TS-DB |
| admin | 11 | TS-DB |
| workstations | 35 | CRUD → TS-DB；AI/spec 注册表/价格生命周期/difflib 近似名 → **Py-RPC** |
| intel | 37 | 数据查询 → TS-DB；需求指数/抓取/ProductSpec 计算 → **Py-RPC** |

### 3.4 引擎与文件字节（保留 Python）

| 域 | 路由数 | 目标 | 说明 |
|---|---|---|---|
| quotes | 37 | **Py-RPC**（改为"TS 供数 → Python 算 → TS 落库"） | 报价引擎是 kaas_common 唯一实现，禁止 TS 重写 |
| trade-docs | 38 | 同上（facts/render/pdf） | 渲染仍需 Python；数据由 TS 查好传入 |
| ai | 8 | **Py-RPC** | 纯推理 |
| events（cron 2 条） | 2 | 保持 | 定时任务，无用户请求 |
| 文件字节 / PDF 渲染 | — | **Py-RPC**（可后续迁 TS+R2/Browser binding） | 见 §7 D4 |

## 4. 变更文件清单（P0 增量，逐文件职责）

| 文件 | 职责 | 类型 |
|---|---|---|
| `backend/ts-worker/src/db/`（新）| 请求级 SQL 句柄 + 事务帮助函数（复用 `db.ts` `withDb`） | 新增 |
| `backend/ts-worker/src/routes/products.ts`（新）| `GET /products`、`/{key}/profile`、`/{key}/media` 直连 SQL | 新增 |
| `backend/ts-worker/src/routes/notifications.ts`（新）| `GET /notifications/unread-count` 直连 SQL | 新增 |
| `backend/ts-worker/src/routes/approvals.ts`（改）| 列表查询由透传改为直连 SQL（写入/审批动作暂留 RPC） | 修改 |
| `backend/ts-worker/src/scope-map.ts`（改）| 权限判定与 Python `kaas_common.workstation.scope` 对齐（golden 锁定） | 修改 |
| `backend/ts-worker/src/boot-flag.ts`（新）| 灰度开关：`AUTH_DB_SPLIT`（全局）+ 按路由前缀覆盖 | 新增 |
| `backend/ts-worker/src/proxy.ts`（改）| 开关关闭时仍走旧透传（回退路径） | 修改 |
| `backend/worker/src/main.py`（改，P2）| 删除 P0/P1 已迁移端点的注册与 `get_current_user` 依赖 | 修改 |
| `backend/worker/src/platform/db.py`（P3 删除）| 内核不再持有 DB 连接 | 删除 |
| `docs/INCIDENT_2026-10-24_KERNEL_502.md` | 事故与拆分依据 | 文档 |
| `docs/PROBLEM_STATUS_2026-10-11.md` | 进度回填（每完成一阶段） | 文档 |

## 5. 关键实现片段

### 5.1 JWT 校验（门面既有，沿用）

```ts
// src/auth.ts（已存在）
const claims = await verifyToken(token, env.JWT_SECRET); // HS256，claims: sub/tenant_id/team_id/scope
```

### 5.2 Hyperdrive 查询（门面既有，沿用）

```ts
// src/routes/products.ts（新增，示意）
app.get("/products", requireUser, (c) => respond(c, async () => {
  const env = getEnv(c);
  return withDb(env, async (sql) => {
    const rows = await sql`
      SELECT id, product_key, title, subtitle, is_quotable, sort_order
        FROM product_profiles
       WHERE tenant_id = 'default'
       ORDER BY sort_order, product_key`;
    return { items: rows.map(toProductRow), media_kinds: MEDIA_KINDS };
  });
}));
```

### 5.3 Service Binding RPC（门面既有 + 新增纯计算入口）

```ts
// 门面供数 → Python 纯计算（内核不再自己连库）
const res = await kernel.fetch(new Request("https://kernel.internal/internal/quote/calculate", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${await mintInternalJwt(actor, env.JWT_SECRET)}` },
  body: JSON.stringify({ spec, pricing_data: rowsFromTs }),
}));
```

### 5.4 错误映射（四类分离，不再用单一"内核不可达"掩盖根因）

| 场景 | 状态码 | 信封 |
|---|---|---|
| 认证失败（token 缺失/过期/签名错） | 401 | `{ detail: { error: "unauthorized", code } }`（不变） |
| TS-DB 查询失败 | 503 | `{ error: "db_unavailable", retryable: true }` |
| 内核初始化失败（fetch 抛错/重试耗尽） | 502 | `{ error: "kernel_unavailable", retryable: true, attempts, elapsed_ms }`（**已实现**） |
| 内核业务异常（已返回 5xx） | 原状态 | `{ error: "kernel_error", message, status }`（不变） |

## 6. 测试清单（每阶段必须覆盖）

| # | 用例 | 期望 |
|---|---|---|
| 1 | 匿名访问受保护资源 | 401，不打到内核 |
| 2 | 登录成功 | 200 + token（哈希口径与历史 bcrypt 兼容） |
| 3 | 带 JWT 访问 P0 热端点 | 200，**全程不经内核**（断言 KERNEL.fetch 未被调用） |
| 4 | JWT 过期 / 签名错 / 缺 JWKS | 401，不触达 DB/内核 |
| 5 | Hyperdrive 查询成功 / 超时 / 连接失败 | 200 / 503 db_unavailable / 503 |
| 6 | Python RPC 成功 | 200，形状与旧内核一致（golden 对照） |
| 7 | Python 初始化失败（注入 fetch 抛错） | 502 kernel_unavailable + retryable，**前端降级逻辑不被破坏** |
| 8 | Python 业务异常 | 原状态码 + kernel_error |
| 9 | 重试只作用于幂等请求 | POST 不重试（已有测试 345 条） |
| 10 | 回退开关生效 | `AUTH_DB_SPLIT=off` 时全部走旧透传路径，行为与今天一致 |

现有基线（改动前）：ts-worker **28 文件 / 345 测**；frontend **228 文件 / 1684 测**；worker **1842 passed + 12 skipped**；orchestrator 273 测。

## 7. 风险与未决问题（需拍板）

**D1 · 登录口令校验放哪**：用户密码是 **bcrypt** 哈希（`$2b$`），Python 侧用 `bcrypt` 包。
- 方案 A（推荐）：TS 引入 `bcryptjs`（纯 JS，无 WASM，哈希完全兼容），登录/改密走门面；
- 方案 B：登录暂留 Python RPC（`/internal/auth/verify`），其余认证拆走 —— 代价是登录仍依赖 Pyodide；
- 方案 C：迁移到 PBKDF2/WebCrypto 并做"登录时渐进重哈希"（安全最好，但改动面最大）。

**D2 · 客户编码生成等"规则类"逻辑**：内核 `build_number`/`build_inquiry_no` 等来自 `kaas_common`（唯一实现）。这类规则若要 TS 直连写库，必须决定是"下沉 TS 并在迁移完成后删除 Python 版（单源迁移）"还是"调 RPC 生成"。**建议**：规则仍留 Python（纯函数、无 DB），TS 只负责落库。

**D3 · 口径唯一实现类聚合**（`receivable_summary`、`funnel`、`channel_conversion_rates`）：本期**不重写**，TS 取数 → Python 算 → TS 返回；待口径稳定后再评估是否下沉 TS（须先扩 golden harness）。**这是"禁止第二份实现"铁纪律的边界，必须用户知情。**

**D4 · 单证 PDF/文件字节**：Python 侧用 Browser Rendering binding 出 PDF。门面也有 `BROWSER` 绑定，可后置迁移；本期保持 Python。

**D5 · 平台侧不确定性**：NoGilError/SystemError 是 Pyodide 运行时 bug，**我们无法根治**，只能降低触发面。是否向 Cloudflare 提工单由用户决定（证据包已具备：tail 栈、错误率、内存分位、时间线）。

**D6 · 内核冷启动成本**：即使拆分完成，引擎端点仍需 Python 冷启动。建议后续把 `main.py` 末尾 17 个路由模块的重依赖惰性化（内核队友已开始，因拆分指令而暂缓，改动已回退避免半成品污染）。

## 8. 灰度与回退

1. **开关**：`AUTH_DB_SPLIT=off|on`（Worker var，可即时改）+ 路由前缀白名单（`AUTH_DB_SPLIT_ROUTES=products,notifications`）；关闭 = 完全回退到"全透传"，行为与今天一致。
2. **顺序**：TS 先**同时**具备新旧两条路径（旧路径默认），P0 路由灰度 on（先只读 GET）→ 观察 24h → 再改默认。
3. **一键回退**：`wrangler versions deploy <上一个版本 id>`（保留当前版本 id；内核未改动时只需回退门面）。
4. **放量判据**：带 JWT 请求 5xx 率 < 0.1%、p50 延迟不劣化 > 20%、无新增 4xx。

## 9. 迁移前后对比指标（可观测性）

必须**分开**记录并在文档回填（本次事故的教训：匿名探针健康 ≠ 用户可用）：

| 指标 | 采集方式 |
|---|---|
| 带 JWT 请求 5xx 率 | Workers Analytics（新增合成探针：每分钟一次**带真实 JWT** 的 `GET /products`） |
| auth 失败率 / db 失败率 / kernel_init 失败数 / kernel 业务失败数 | 门面结构化日志（`error` 字段四分类）+ Analytics Engine |
| p50/p95 延迟（按是否触达内核分组） | Workers Analytics `durationP50/P95`，按 `kernel_used` 维度 |
| 内核冷启动次数 / 初始化异常次数 | `workersInvocationsAdaptive`（script=kaas，status 维度） |
| 内存分位 | `memoryUsageBytesP50/P99`（当前 P99 137MB / 上限 128MB，是硬指标） |

## 10. 分阶段计划（每阶段独立可交付、可回退）

| 阶段 | 内容 | 预估 | 风险 |
|---|---|---|---|
| **P0** | products / notifications / approvals 热读走 TS-DB + 灰度开关 + 四类错误映射 + 带 JWT 合成探针 | 1–2 天 | 低（只读，形状由 golden 锁） |
| **P1** | 认证域全部（D1 方案 A）+ customers/teams/orders 剩余显式透传项 | 2–3 天 | 中（口令/编码规则，需兼容测试） |
| **P2** | quotes/trade-docs 改"TS 供数 → Python 算 → TS 落库"；内核移除对应 DB 访问 | 3–5 天 | 中高（引擎契约，需 golden 全绿） |
| **P3** | 内核删除 `platform/db.py`、`get_current_user`、bcrypt/jwt 依赖 → 内存/启动成本大降 | 1 天 | 中（需确认无残留调用） |

## 11. 明确未改动的 Python/AI 业务代码

- `backend/kaas_common/export_quote/**`（报价引擎：公式/导入/数值口径）——**一行不改**
- `backend/kaas_common/trade_doc/**`（单证 facts/render/translate/consistency）——**一行不改**
- `backend/kaas_common/files/**`（S3 签名/PDF 渲染/印章 PNG 校验）——**一行不改**
- `backend/worker/src/ws_cron.py`（3 条 cron 语义）——**一行不改**
- 所有 AI/抓取/需求指数实现——**一行不改**
- 仅调整"入口形态"（RPC 方法）与"数据来源"（由门面传入），不触碰算法本体。
