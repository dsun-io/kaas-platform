# KaaS 平台 · 安全审查报告（静态 · 2026-10-19）

> **性质**：**只读静态审查** + 三环境配置核对。未连库、未部署、未 push、未触发 CI、未执行任何 Cloudflare / Neon API 调用。
> **范围**：仓库当前树（`main` @ `6104f22`）、近期提交历史、`git log` 全历史（680 commits）、
> `backend/worker`（生产唯一入口）、`backend/orchestrator`（本地开发入口）、`backend/kaas_common`（共享内核）、
> `frontend/`（锁文件与构建配置）、`docker-compose.yml`、`.github/workflows/*`、`.env*`（**仅核对键名，不读取/不输出密钥值**）。
> **纪律**：本文件是本次任务**唯一写入**的文件；其它一切只读。**未 commit / 未 push**（由 Lead 决定）。

## 0. 结论摘要

| 级别 | 条数 | 一句话 |
| :--- | :--- | :--- |
| **危 / Critical** | **2** | ① 一个**仍在当前树里**的明文 Notion 集成令牌（已跟踪、已进历史）；② 生产库口令与管理员口令在 git 历史中仍可读（沿用 2026-10-17 结论，用户已裁决暂不轮换） |
| **高 / High** | **4** | ① Worker 的 6 个 `/api/v1/admin/*` 端点**只校验"已登录"**（任意 customer 可写 feature flag、读审计日志）；② orchestrator 的 10 个 admin 端点只校验 `internal`（非管理员的 internal 也能改租户配置/清缓存）；③ Next 14.2.35 已 EOL 且含 2 个 critical RCE；④ 生产 Worker **全站没有任何限流** |
| **中 / Medium** | **7** | 预览环境零落地、生产资源命名与目标态矩阵不一致、第三方 API Key 明文入库、直传 presign 无 owner 授权、部署链缺口、CORS 口径、令牌存储与生命周期 |
| **低 / Low** | **8** | 默认密钥值残留（已被启动校验拦住）、动态 SQL 片段拼接模式、check-then-act 写路径、诊断端点、docs 未关、文档漂移、QA 管理员账号、归档业务数据敏感性 |

**SQL 注入面结论（重要）**：**未发现真正的注入点**。Worker/orchestrator/共享内核中所有 SQL 的
插值表达式，除"占位符序号 / 列名白名单常量 / 表名常量 / 框架常量片段"外**没有一处直接插入请求值**；
所有数据值走 `$n` / `:name` 参数。详见 §2。

**越权面结论（重要）**：management 端点的鉴权强度**三档不一致**：
`accounts`（system_admin）> `proposals`（internal+管理员）> `feature_flag / tenants / audit-log / archive-logs`（**仅"已登录"**）。
前端只按 `account_type === "internal"` 隐藏入口（`frontend/src/components/route-guard.tsx:18`），
**后端对后一组没有任何角色校验** ⇒ 属"前端隐藏但后端不校验"。详见 §3。

**三环境配置结论（重要）**：README §2.2 的矩阵是**目标态**，仓库事实是**单环境**：
生产 Hyperdrive `f53fed49…` ✓、R2 `kaas-files`（≠ 目标 `kaas-prod-storage`）、无 KV 绑定、**无任何预览工作流/PR 前缀机制**。
明细与"哪些只能由用户操作"见 §6。

---

## 1. 密钥与凭据

### 危-1（Critical）`.codex/config.toml` 内含明文 Notion 集成令牌，**已入库且在当前树中**

- **证据**
  - `git ls-files --error-unmatch .codex/config.toml` ⇒ **tracked**。
  - 文件第 4 行为 `args = [ "...", "--api-key=ntn_…" ]`（此处已掩码；完整值见该文件，**本报告不复述明文**）。
  - 引入提交：`91cf0e50 feat(spec-system): …`；`git log --all -S'ntn_'` 命中 **37 个提交**（历史同样可读）。
  - 与 `.gitignore:78`（`.codex/`）冲突：**先被跟踪，再加忽略规则** —— 忽略规则对已跟踪文件无效。
- **影响**：任何能读该仓库的人（**2026-10-17 起仓库曾转为 public**，是否已改回 private **本机无法离线核实**）都能拿到该令牌；
  以只读 MCP 配置形式存在，若该 Notion 集成仍有效，可访问配置过的 Notion 页面/数据库。
- **建议**
  1. **立即在 Notion 侧吊销该集成令牌**（Integration → 撤销/重置 secret），并确认其在 Notion 侧可见范围；
  2. `git rm --cached .codex/config.toml` 并从工作树删除（或改为 `--api-key=${NOTION_API_KEY}` 的模板，值走环境变量）；
  3. 视需要 `git filter-repo` 清历史（破坏性、影响所有 clone，**必须用户拍板**）。
- **需用户操作**：❌ **否 —— 2026-10-20 用户裁决「不清理」**（不吊销、不重写 git 历史；
  `.codex/config.toml` 已从索引删除（`100e767`），历史中的令牌按**用户接受风险**保留）。
  ⇒ 危-1 状态：**按风险接受关闭**，不再作为待办。

### 危-2（Critical，已裁决）生产 Neon 口令 / 管理员口令仍在 git 历史中可读

- **证据（本轮复核，未打印明文）**
  - 当前树：`git grep 'npg_'` 仅命中 `docs/archive/2026-10-20-closeout/ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md:219` 的**说明文字**；
    `backend/.tools/{list_columns,list_tables,seed_ports,seed_port_coords}.py` 已于 `fbced671` 改为读 `KAAS_DSN`
    ⇒ **当前树干净 ✓**。
  - 历史：`git show 5e78d9ce:backend/.tools/list_columns.py` 仍含
    `postgresql://neondb_owner:<REDACTED>@ep-small-brook-b54t5318-pooler.c-7.us-east-2.aws.neon.tech/neondb`
    （4 个文件同源）；`git log --all -S'npg_'` 命中 37 个提交。
  - **与现用口令相同**：`docs/PROBLEM_STATUS_2026-10-11.md:3529` 记录"SHA256 已比对，未打印明文"，
    判定"历史仍可读，且与现用口令相同"。
  - 管理员 `user@example.com` 初始口令：`main` 历史 4 个提交的交接文档（`ff9aa73`…`bb5276e`），
    `fbced671` 已从当前树删除（`docs/PROBLEM_STATUS_2026-10-11.md:3531`）。
  - **用户裁决（2026-10-17）**：不轮换 Neon 口令、不改管理员口令；计划"部署完成后把仓库改回 private"
    （`docs/PROBLEM_STATUS_2026-10-11.md:3562-3569`；`docs/UNCERTAIN.md:24` #18 亦记录同一裁决）。
- **影响**：GitHub 缓存/直链/第三方镜像可能仍持有旧值；"改回 private"**不能**收回已被抓取的内容。
- **建议**：若仓库当前仍是 public ⇒ **立刻改回 private（止血）+ 轮换（治本）**；轮换顺序与影响面（Hyperdrive 连接串需同步更新 + 重新部署、
  本地 `.env`、`KAAS_DSN`）见 `docs/PROBLEM_STATUS_2026-10-11.md:3549-3553`。
- **需用户操作**：✅ **是**（① 确认仓库当前可见性；② 是否推翻 10-17 的"不轮换"裁决）。

### 未发现的项（全历史/当前树 0 命中，阳性对照已做）

| 检查 | 命令 | 结果 |
| :--- | :--- | :--- |
| OpenAI/DeepSeek `sk-…` | `git grep -E 'sk-[A-Za-z0-9]{16,}'` | 0（本地 `.env` 里为 6 字符占位 `sk-xxx`，未入库） |
| AWS `AKIA…` | 同上 | 唯一命中 `backend/orchestrator/tests/test_files_s3_roundtrip.py:39` 的**假 MinIO 值** `AKIAMINIOEXAMPLE0001` |
| GitHub `ghp_` / `xox*` / `AIza` / `whsec_` / 私钥块 | 同上 | 0 |
| JWT 形态串 `eyJ…` | 同上 | 0（`frontend` 只从 storage 读，不硬编码） |
| Neon `npg_` 当前树 | `git grep npg_` | 仅文档说明文字（见危-2） |
| `.env` / `.dev.vars` 是否被跟踪 | `git ls-files | grep '\.env'` | 仅 5 个模板：`backend/orchestrator/.env.{example,production.template}`、`frontend/.env.{development,example,production}` —— **均无密钥值**（Sentry 两项在所有版本为空） |
| 近期提交（近 60）新增行 | `git log -60 -p | grep '^+'` + 模式扫描 | 仅**本地**开发 DSN（`kaas:kaas_dev_pw@localhost`、`postgres:postgres@127.0.0.1`）—— 可接受 |
| Worker secrets 使用点 | `_binding("…")` 全量枚举 | `JWT_SECRET`、`ADMIN_SETUP_TOKEN`、`RESEND_API_KEY`、`RESET_FROM_EMAIL`(可选)、`FRONTEND_BASE_URL`(可选)、`S3_ACCESS_KEY`/`S3_SECRET_KEY`、`BROWSER_RENDERING_TOKEN`(REST 兜底)；非机密 vars 在 `wrangler.jsonc:58-63` |
| 测试/文档里的密钥 | 全脚本扫描（`api_key|token|secret|password = "…"`） | 仅 `cf-token-…` 假值（`backend/orchestrator/tests/test_render_pdf.py:51`、`backend/worker/tests/test_ws_render_pdf.py:41`） |

> **本机 `.env`（未入库，`git check-ignore` 已确认）现状**：`DEEPSEEK/ZHIPU/FASTGPT/CLAWBOT/MINIO` 值为**占位符**
> （长度 3–11，含 `xxx`）；`JWT_SECRET` 96 字符（非默认值）；`DEV_*_PASSWORD` 为真实开发账号口令（**仅本地库**）；
> `DATABASE_URL` 125 字符（指向远端）。**仅本机风险**，未进仓库。

---

## 2. SQL 注入面

### 方法（可复现）

1. 枚举 `backend/worker/src`、`backend/orchestrator/app`、`backend/kaas_common` 中**所有含 SQL 关键字的字符串字面量**；
2. 提取其中**全部 `{…}` 插值表达式**（结果见下表，共 35 个不同表达式）；
3. 逐个回溯表达式来源：占位符序号 / 白名单常量 / 请求值；
4. 另做"租户隔离缺失"扫描（35 张带 `tenant_id` 的模型表 × 不含 `tenant_id` 的字面量），60 个候选**人工逐条判读**。

### 结论：**无真拼接注入点**。35 个插值表达式分类如下

| 类别 | 表达式 | 判读 |
| :--- | :--- | :--- |
| 占位符序号（整数） | `{idx}`×8、`{idx+1}`×4、`{idx + 1}`×2、`{n+1}`×2、`{n+2}`、`{n+3}`、`{len(args)}`、`{len(args)-1}`、`{len(params)}`、`{len(cols)+2}`、`{len(params)+1/2}`（`main.py:3570`、`quote_api.py:1646`、`ws_shipments.py:203`） | 恒为 `int`，**安全** |
| WHERE 片段（全由常量 + `$n` 拼成） | `{where_sql}`×13、`{cond}`×7、`{where}`×5、`{w}`×2、`{" AND ".join(where)}`×2、`{' AND '.join(where)}`×2、`{' AND '.join(conds)}` | 片段来源都是**列名字面量 + 占位符**（例：`chain.py:697` `for col,val in (("task_key",…),…)`），请求值只进 `params` ⇒ **安全** |
| 列名白名单（常量 join） | `{', '.join(sets)}`×6、`{', '.join(set_parts)}`×2、`{", ".join(cols)}`×2、`{cols}`、`{updates}`、`{placeholders}`×4、`{', '.join(_INSERT_COLUMNS)}` | 列名来自**代码内白名单元组**：`ws_crm_ext.py:61`（注释明写"列名直接拼进 SQL，绝不接受外部输入"）、`ws_crm_ext.py:63-71`、`ws_products.py:275`（`k in _UPDATABLE_COLUMNS`）、`main.py:4120`（`_COMPANY_FIELDS`）、`main.py:2071/2279`（`updates` 仅由 `updates["status"]=…` 等字面键构造）⇒ **安全** |
| 框架常量列清单 | `{_META_COLS}`×12 | `ws_files.py:117` / `files.py` 模块常量 ⇒ 安全 |
| 表名/列名（调用方字面量） | `{table}`×2、`{col}`×2（`main.py:2950`、`quote_api.py:1375`） | 4 处调用点（`main.py:3134`、`main.py:3855`、`ws_shipments.py:267`、`quote_api.py:1406`、`quote_api.py:1706`）**全部传字面量**（`"orders"`/`"trade_docs"`/`"shipments"`/`"quote_orders"`/`"cust_inquiries"`）。**现状安全，但模式脆弱** → 低-2 |
| 常量 SQL 片段 | `{_LIVE}`、`{_customer_stage_sql('c')}`×2、`{order_sql}`、`{token_tenant_filter}`、`{dataset_tenant_filter}` | 常量子句/字典查表（`chain.py:1123` `{"recent":…,"name":…}.get(sort, …)`，`sort` 还有 `pattern="^(score|recent|name)$"` 校验）、`dashboard.py:89` 为常量条件串 ⇒ 安全 |
| 整数（已 clamp） | `{lim}`（`main.py:1694`） | `lim = max(1, min(limit,500))` ⇒ 安全 |

### 风格/纵深防御建议（不构成漏洞）

- **低-2**：`{table}`/`{col}`/`{', '.join(sets)}` 这类"把标识符拼进 SQL"的写法虽然**当前全部来自字面量/白名单**，
  一旦未来有人把请求字段名直接塞进来就是真注入。建议：为这类 helper 加**断言/白名单装饰器**，或在注释中固化契约
  （`main.py:2944`、`quote_api.py:1367` 目前无此约束说明）。
- **`%` 格式化占位符编号**：`backend/worker/src/main.py:3052`
  `f"… LIMIT $%d OFFSET $%d" % (len(params)+1, len(params)+2)` —— 传的是整数，安全；但**对 SQL 串用 `%` 是反模式**，建议统一改 f-string。

### 租户/团队隔离（与 §3 合并阅读）

- 设计口径：`tenant_id` 恒为 `"default"`（Worker 硬编码 `DEFAULT_TENANT`），**真实隔离边界是 `team_id`**
  （`backend/orchestrator/app/core/auth.py:50-53`、`README.md` 项目口径）。
- 抽样核对（`customers` / `orders` / `quote_orders` / `trade_docs` / `shipments` / `file_objects` / `tenant_products` / `tax_archives` / `teams`）：
  - **列表/读路径**普遍带 `tenant_id=$1` + 团队谓词
    （例：`main.py:1113-1127` 客户三层可见性、`main.py:3038-3052` 订单 scope、`ws_files.py:69-97` `_team_scope` 严格/宽松两档）；
  - **按 id 读单行**先用带作用域的查询取行、再逐条比对（`ws_products.py:256-271` 别家产品一律 404）；
  - 未发现"跨团队可读/可写"的路径。
- **低-3**：存在 **check-then-act** 模式 —— 预校验有作用域，最终 `UPDATE/DELETE` 只按 `id`：
  `ws_products.py:258→302`、`ws_products.py:317→342`、`main.py:1365`（前置 `_customer_or_404`）、
  `ws_crm_ext.py:201→`（前置 `_check_write_access`）。**均在单连接事务内**（`_acquire` + `conn.transaction()`），
  实际可利用性低；建议把 `tenant_id`/`team_id` 也写进最终 `WHERE`，去掉对该模式的依赖。

---

## 3. 越权面（`/api/v1/admin/*` 全清单 + 鉴权实现）

### 3.1 Worker（**生产唯一入口**）：11 条 admin 路由，鉴权**三档不一致**

| 路由 | 文件:行 | 实际鉴权 | 强度 |
| :--- | :--- | :--- | :--- |
| `GET /api/v1/admin/feature_flag` | `main.py:2561` | `Depends(_get_current_user)` | **仅需登录** ⚠️ |
| `POST /api/v1/admin/feature_flag` | `main.py:2594` | 同上（**写 DB + 写审计**） | **仅需登录** ⚠️ |
| `GET /api/v1/admin/tenants` | `main.py:2645` | 同上 | **仅需登录** ⚠️ |
| `POST /api/v1/admin/tenants/reload` | `main.py:2661` | 同上（写审计） | **仅需登录** ⚠️ |
| `GET /api/v1/admin/audit-log` | `main.py:2689` | 同上（读全表审计） | **仅需登录** ⚠️ |
| `GET /api/v1/admin/archive-logs` | `main.py:2727` | 同上（占位空列表） | **仅需登录** ⚠️ |
| `GET/PATCH /api/v1/admin/accounts` | `ws_admin_accounts.py:53,80` | `_require_system_admin`（`:31-33`：`internal` + `is_admin_role`） | ✅ 强 |
| `GET /api/v1/admin/spec/attribute-proposals` | `ws_admin_proposals.py:71` | `_require_platform_ops`（`:32-38`） | ✅ 强 |
| `GET …/recommended` | `ws_admin_proposals.py:91` | 同上 | ✅ 强 |
| `PATCH …/{proposal_id}` | `ws_admin_proposals.py:108` | 同上（写操作单事务） | ✅ 强 |

### 高-1（High）Worker 的 6 个 admin 端点可被**任意已登录账号（含 customer 账号）**调用

- **证据**
  - 上述 6 条路由的依赖只有 `user: dict = Depends(_get_current_user)`；`_get_current_user`（`main.py:137-150`）
    只做 JWT 解码 + `users.status='active'` 校验，**没有任何 account_type / role 判断**。
  - 同一 repo 内 `accounts`/`proposals` 两个模块已用 `_require_system_admin` / `_require_platform_ops` 做好了强校验
    ⇒ 不是"设计如此"，是**不一致/漏做**。
  - 前端仅按 `account_type === "internal"` 隐藏入口：`frontend/src/components/route-guard.tsx:18-20`；
    设置页再收紧到 `system_admin`：`frontend/src/app/(app)/settings/page.tsx:21`。
    ⇒ **典型"前端隐藏、后端不校验"**：customer 账号直接 `curl` 即可调。
  - 测试也没覆盖这一点：`backend/worker/tests/test_admin_contract.py:199-201` 只断言**无 token ⇒ 401**，
    没有"customer 账号 ⇒ 403"的用例。
- **影响**：任意注册用户（注册接口公开：`main.py:559`）可
  ① **写 feature flag**（`use_v2` 等开关，直接影响线上功能灰度）；
  ② 读审计日志（含 `actor_id`/变更原因）；
  ③ 触发 tenants/reload（no-op 记账，但会污染审计表）。
  这是**对生产产生实际写能力**的越权，建议按 P1 修。
- **建议**：这 6 条统一改为 `_require_platform_ops(user)`（与 proposals 同一把尺），并补 3 条测试
  （customer ⇒ 403 / internal 非管理员 ⇒ 403 或按产品口径放行 / system_admin ⇒ 200）。
- **需用户操作**：❌ 否（纯代码修改；但"internal 普通业务员是否应能看 audit-log"属**策略问题**，需产品口径确认 → 建议由用户裁决一次）。

### 高-2（High）orchestrator 的 10 个 admin 端点只校验 `internal`（**非管理员 internal 亦可**）

- **证据**
  - `backend/orchestrator/app/api/admin.py:27-46`：`require_admin_auth()` 只判 `auth.is_internal()`（`app/core/auth.py:96-97`），
    并以 `dependencies=[Depends(require_admin_auth)]` 挂在 router 上 ⇒ **10 条路由全部**受影响：
    `tenants`(:70)、`tenants/{id}`(:91)、`tenants/reload`(:106)、`feature_flag` POST(:136)/GET(:208)、
    `deployment_audit`(:235)、`audit-log`(:284)、`archive-logs`(:325)、`metrics/summary`(:351)、`cache/clear`(:365)。
  - 同仓**已有更严格的尺**却没用于此：`app/deps/rbac.py:40-45` `require_platform_ops`（internal + admin）；
    `app/core/auth_utils.py:16` `require_internal`（internal + `system_admin`）—— 后者已被 `admin_accounts.py:67` 使用，
    `admin_proposals.py:15,35,53` 用 `require_platform_ops`。
- **影响**：内部普通业务员账号可 **写 `tenants.yaml`（feature flag）/ 热重载 / 清缓存 / 读部署审计**。
  生产不跑 orchestrator（`README.md:36-37`：orchestrator 从未部署到 Cloudflare），故**当前生产影响 = 0**；
  但方案 B 阶段二后 orchestrator 壳并入同一 app，**该缺口会随代码一起进生产**，属"必须在合并前排掉"的债。
- **建议**：`admin.py` 的 router 级依赖换成 `require_platform_ops`（或至少 `require_internal`）；
  `feature_flag` POST / `tenants/reload` / `cache/clear` 三个**写**端点必须 `require_platform_ops`。
- **需用户操作**：❌ 否（代码修改）。

### 其它越权相关核对（结论：未发现未鉴权的敏感端点）

- 全量路由扫描（227 条 Worker 路由 / orchestrator 路由）中**无鉴权依赖**的端点仅：
  `POST /api/v1/auth/{login,register,logout,bootstrap-admin,forgot-password,reset-password}`、
  `GET /health`、`GET /api/v1/enums`（静态常量，`ws_enums.py:25-32` 明示"不需要鉴权"）、
  `POST /api/v1/outreach/webhook`（**501 预留桩**，`chain.py:1674-1689`）。
  `bootstrap-admin` 用 `hmac.compare_digest` 比对一次性令牌且已有管理员时 403（`main.py:276-299`）✓。
- orchestrator `POST /api/v1/oss/presign` 虽未挂 `Depends`，但函数内自查 `request.state.auth`（`oss_presign.py:40-58`）✓。
- `POST /api/v1/events` 早期"无鉴权 + 可指定 tenant"的洞**已修**（`main.py:1616-1622` 注释 + 现在 `tenant_id` 取自常量、`actor` 取自 token）✓。
- `GET /api/v1/file-objects/_r2_debug` 诊断端点**已收紧**为管理员（`ws_files.py:890-900`），但仍建议下线 → 低-4。

---

## 4. 认证 / CORS / JWT / 限流

### 高-4（High）生产 Worker **全站没有任何限流**

- **证据**：`backend/worker/src` 全目录 grep `slowapi|Limiter|rate_limit|throttle` ⇒ **0 命中**；
  `login`（`main.py:302-319`）、`register`（:559）、`forgot-password`（:434-465）均无尝试次数/冷却/验证码。
  对照：orchestrator **有** slowapi（`app/middleware/rate_limit.py:31-34`，默认 `100/minute`，key=`tenant:ip`）。
- **影响**：① 登录口令爆破（bcrypt 只提供常数级成本，无锁定）；② `forgot-password` 可被用来**邮件轰炸/消耗 Resend 配额**
  （该端点当前**恒返回 ok**，不会泄露邮箱存在性 ✓，但也没有频控）；③ 注册可被批量刷号。
- **建议**：Worker 侧加最小限流 —— Cloudflare 原生 **Rate Limiting Rules**（零代码、优先）或 Worker 内用
  Durable Object/KV 计数；至少给 `/api/v1/auth/*` 加 `5/min/IP` + 每邮箱失败计数。注意 `workers_dev=false`，规则挂在两个自定义域名上。
- **需用户操作**：⚠️ **部分** —— 若走 Cloudflare Rate Limiting Rules（推荐），需用户在 **Cloudflare Dashboard/API** 配置（我无凭据、且部署冻结期不动线上）。

### JWT 实现核对（结论：无算法混淆、无默认密钥回退）

| 项 | 证据 | 结论 |
| :--- | :--- | :--- |
| 算法固定 | Worker `main.py:106` `JWT_ALGORITHM="HS256"`，`_decode_token` 传 `algorithms=[JWT_ALGORITHM]`（:130） | ✅ 无 alg confusion |
| 密钥缺失 | Worker `_jwt_secret`（`main.py:98-103`）缺失即 **503**，**保留任何默认值都不允许** | ✅ |
| 过期 | Worker `_create_token`：`exp=+1440min`（`main.py:119-125`）；orchestrator `settings.jwt_expire_minutes=1440`（`settings.py:72`） | ⚠️ 24h 无刷新（见中-7） |
| 撤销 | 每请求回查 `users.status!='active' ⇒ 401`（`main.py:142-149`）⇒ 停用账号立即失效 | ✅ 有效缓解 |
| orchestrator 启动校验 | `app/core/lifecycle.py:12-39`：默认密钥集合 ⇒ 直接 `RuntimeError`；`APP_ENV=production` 时还要求 `len>=32` | ✅（低-1 仍建议删默认值） |
| 重置口令 | token 只存 SHA-256、30 分钟、用后即废（`main.py:351-503`）；错误统一 400/恒 200 | ✅ 做得好 |

### 中-6（Medium）CORS 口径两处不够干净

- **证据**
  - Worker：`main.py:203-240`，`ALLOWED_ORIGINS={https://kaas.powervoy.com, http://localhost:3000, http://127.0.0.1:3000}`；
    **非白名单 Origin 会被回显生产域**（`allowed = origin if origin in ALLOWED_ORIGINS else "https://kaas.powervoy.com"`）。
    浏览器侧不会因此放行（ACAO 与请求 Origin 不匹配即拒），**不构成绕过**；但异常路径把"跨域被拒"伪装成"同域成功"，
    排查时容易误判；且**生产 bundle 里保留了 localhost 来源**。
  - orchestrator：`app/main.py:65-70` `CORSMiddleware(allow_credentials=True, allow_headers=["*"])`，
    来源来自 `CORS_ORIGINS`（默认仅 localhost，生产模板为 `https://kaas.powervoy.com`）。
- **建议**：Worker 对不匹配的 Origin **不回 ACAO 头**；生产构建剔除 localhost；orchestrator 若不用 cookie 认证，
  `allow_credentials` 可设 False（当前用 Bearer，风险低，只是收紧口径）。
- **需用户操作**：❌ 否。

### 中-7（Medium）令牌存储与生命周期

- **证据**：`frontend/src/lib/auth/token-store.ts:23-26` JWT 存 **localStorage/sessionStorage**（`kaas_token`），
  另有 `has_token=1; SameSite=Lax` 仅作 Next 中间件标记（:102-107）；后端 token 24h、无 refresh、无 `aud/iss`。
- **缓解现状**：全仓 `dangerouslySetInnerHTML` **0 命中**（grep 已验证），XSS 面较小；有 CSP 吗？**未见**（无 `next.config` headers / `_headers` 配置）。
- **建议**：① 加 CSP（静态导出可用 `public/_headers`，Worker assets 支持）；② 缩短 access token 至 2–8h 或引入 refresh；
  ③ 后端校验 `aud`（可选）。均为加固，不阻塞上线。
- **需用户操作**：❌ 否（CSP 需与前端一起改，建议排进下一批）。

---

## 5. 依赖与供应链

### 高-3（High）Next 14.2.35（EOL）含 2 个 critical RCE，仍未升级

- **证据**
  - `frontend/package.json:31` `"next": "^14.2.0"`；`pnpm-lock.yaml:4253/9732` 解析为 **`next@14.2.35`**；
    本机 `frontend/node_modules/next/package.json` = **14.2.35**（实测）。
  - 口径来源：`docs/TECH_STACK_UPGRADE_2026-10-17.md:19-31`、`:85`、`:182-183`
    —— `pnpm audit` 实测 **80 条（2 critical / 19 high / 48 moderate / 11 low）**，
    **2 个 critical 均为 Next image optimizer 的 RCE，修复只落在 Next ≥ 15.5.24**；
    14.x 已不在安全补丁线。
  - **真实暴露面受限**（重要限定，原文档同口径）：生产为**静态导出 + `images.unoptimized`**
    （`frontend/next.config.mjs:18-20`），image optimizer 路由**不对外提供** ⇒ 线上可利用性 < 审计计数。
- **建议**：按 `TECH_STACK_UPGRADE_2026-10-17.md` 的**批次 B**（Next 16 + React 19）排期；
  在升级前不要在网关放开任何 `/_next/image` 路由。**重跑 audit 前必读该文档 §1**：
  npmmirror 镜像**没有 audit 端点**，必须 `pnpm audit --registry https://registry.npmjs.org --json`，
  且"命令报错"不等于"没有漏洞"。
- **需用户操作**：⚠️ 需用户排期（跨两代升级、需回归；不属本次可自行完成的改动）。

### Worker Python 运行时依赖：**6 个，已是最小集** ✓

| 依赖 | 锁定版本（`backend/worker/uv.lock`） | 备注 |
| :--- | :--- | :--- |
| `fastapi` | 0.141.1（`starlette` 1.6.0） | |
| `asyncpg` | 0.31.0 | 生产唯一 DB 驱动（路线 A 已否决） |
| `pydantic` | 2.13.5 | |
| `pyjwt` | 2.14.0 | 只用 HS256，无需 cryptography 依赖 |
| `python-multipart` | 0.0.32 | ≥0.0.18，已覆盖 CVE-2024-53981（ReDoS） |
| `bcrypt` | 5.0.0 | |

- 依据：`backend/worker/pyproject.toml:11-18` 的 `dependencies` 恰好这 6 个；
  注释说明剔除 `httpx`/`pydantic-settings` 是为冷启动 CPU 额度（`pyproject.toml:6-10`）。
- 运行时依赖断言门禁存在且已接入 CI：`scripts/check-runtime-deps.py`（`deploy.yml:131-132`、`backend-test.yml`）—— 断言不得出现
  `sqlalchemy/alembic/greenlet/psycopg2` ✓。
- **未发现** ORM/迁移依赖被打进生产 Worker 包。

### CI 工具链（供应链相关）

- **Node 20**：`deploy.yml:39`、`frontend-ci.yml`、`backend-test.yml`、`contracts-check.yml` 均用 `node-version: 20`
  —— **Node 20 已于 2026-04-30 EOL**（`TECH_STACK_UPGRADE_2026-10-17.md:69`），且 Vitest 5 / MSW 3 要求 ≥22.12。
- pnpm 版本三处不一致：本机 10.33.0、CI `corepack enable`（`deploy.yml:34-35`）= 12.x、
  `contracts-check.yml` 固定 `version: 10`（该文件里 `pnpm-lock.yaml` 是 monorepo 单锁，但缓存路径写成 `frontend/pnpm-lock.yaml`）。
- **未发现** GitHub Actions 里除 `secrets.*` 之外的凭据；`frontend-ci.yml` 已加 `permissions: contents: read`
  且 `SENTRY_AUTH_TOKEN` 仅 `push` 注入（`frontend-ci.yml:17-19,50-52`）✓。
- ⚠️ `deploy.yml` **没有 `permissions:` 块**（其余 3 个 workflow 有）→ 见中-5。

---

## 6. 三环境配置核对清单（开发 / 预览 / 生产）

> 口径基准：`README.md:51-97`（§2.2 矩阵 + §2.3 十条硬规则，**文档自己标注为"目标态 · 尚未实施"**）、
> `DEPLOY.md`（生产实配）、`docker-compose.yml`（开发）、`.github/workflows/`（CI 实配）。
> **本轮未执行任何 Cloudflare/Neon 查询** ⇒ 下表"已落实"指**仓库内可核实**的配置；"云端是否真的存在"一列标为需用户核实。

### 6.1 开发（本地 Docker PG + MinIO）

| 项 | 需要什么 | 仓库现状 | 缺口 |
| :--- | :--- | :--- | :--- |
| PG | `DATABASE_URL=postgresql+asyncpg://kaas:kaas_dev@…/kaas_dev` | ✅ `docker-compose.yml:7-22`（`postgres:16-alpine`，含 healthcheck）；`backend/orchestrator/.env` 提供（未入库） | — |
| Redis | `REDIS_URL` | ✅ `docker-compose.yml:25-34` | — |
| MinIO | endpoint/ak/sk/bucket | ✅ `docker-compose.yml:37-53`（`minioadmin/minioadmin`） | ⚠️ **桶名不一致**：compose/`.env` 是 `kaas-events-archive`，README 目标态写 `kaas-dev`；且 compose **不会自动建桶**（需手工 `mc mb`）→ 见中-2 |
| orchestrator 启动 | `APP_ENV=development`、`CORS_ORIGINS`、`RATE_LIMIT_*` | ✅ `.env`+compose 覆盖（`docker-compose.yml:64-77`） | — |
| 前端 | `NEXT_PUBLIC_API_MODE=real`、`NEXT_PUBLIC_API_BASE_URL=http://localhost:8000` | ✅ `frontend/.env.development` | — |
| worker 本地冒烟 | `.dev.vars`：`JWT_SECRET`、`ADMIN_SETUP_TOKEN` | ⚠️ **`backend/worker/.dev.vars` 不存在**（`Test-Path` 实测 False）；文档要求见 `backend/worker/README.md:36-41` | 需开发者本地创建（**不需要用户操作**，但会卡住 `wrangler dev` 冒烟） |
| 开发账号 | `SEED_DEV_ACCOUNTS` | ⚠️ 本机 `.env` 为 **`true`**（会种 `README.md:332-337` 里那 4 个弱口令开发账号） | 仅本地库，可接受；建议默认 false |

### 6.2 预览（每 PR Neon 子分支 + 独立 Hyperdrive + R2 `kaas-preview-storage` + KV 前缀）

| 项 | 需要什么 | 仓库现状 | 缺口 / 谁来做 |
| :--- | :--- | :--- | :--- |
| 预览 workflow | PR 触发、构建+部署、PR 关闭清理 | ❌ **不存在**（`.github/workflows/` 只有 `deploy/frontend-ci/backend-test/contracts-check`，`deploy.yml:16-19` 仅 `workflow_dispatch`） | **代码可做**（需 1–2 人日，属方案 B S5） |
| Neon 子分支 `preview-<pr-slug>` | 从生产派生、独立凭证 | ❌ 无（`git grep 'PR_SLUG'` 全仓 **0 命中**） | **需用户**：Neon 分支策略/凭证（API key） |
| Hyperdrive `kaas-preview-<pr-slug>` | 每 PR 独立 config | ❌ 无（`wrangler.jsonc:24-29` 只有 1 个生产 config `f53fed49…`） | **需用户**：Cloudflare API Token 权限（Hyperdrive 创建/删除） |
| R2 `kaas-preview-storage` | 与生产物理隔离、对象键 `pr-<slug>/` | ❌ 无（仓库只有 `kaas-files`） | **需用户**：建桶 + 授权 |
| KV 预览 namespace + `preview_id` | 键前缀 `pr-<slug>:` | ❌ 无（`wrangler.jsonc` 无 KV 绑定；**Worker 代码也不用 KV**） | **需用户**：决定是否真需要 KV（当前代码零引用 ⇒ 可先不做，见中-2） |
| CI 防污染断言（README §2.4） | 部署前断言 bucket / KV / Hyperdrive 均等于对应环境值 | ❌ 无 | **代码可做**（S5） |
| 清理 | 删 Neon 分支 / Hyperdrive / R2 前缀 / KV 前缀 | ❌ 无 | **代码可做**（S5） |
| CI secrets | `NEON_API_KEY`、`CF_API_TOKEN`（Hyperdrive 权限）等 | ❌ 未配置 | **需用户**：在 GitHub repo secrets 里加 |

> **安全提示**：预览环境"半落地"比"不落地"更危险（最典型的翻车是**预览 Worker 绑到生产 Hyperdrive**）。
> 若不打算做，**不要手工建半个预览环境**；要做就按 §2.4 的断言一起做。

### 6.3 生产（Neon + Hyperdrive `f53fed…` + Worker `kaas`）

| 项 | 需要什么 | 仓库现状（可核实） | 缺口 / 谁来做 |
| :--- | :--- | :--- | :--- |
| Hyperdrive | `id=f53fed49705043008737032e4bfa2b8e` → Neon 生产分支 | ✅ `wrangler.jsonc:24-29`（与 README §2.2、DEPLOY.md 一致） | — |
| Neon 分支 | 受保护 root 分支 | ✅ 文档口径（`.neon`：`projectId=falling-salad-31662168`, `branch=production`）；**是否已设 Protected 需用户核实** | **需用户**（Neon Console） |
| R2 桶 | 目标 `kaas-prod-storage` | ⚠️ 实配 **`kaas-files`**（`wrangler.jsonc:40`、`vars.S3_BUCKET` 在 `:60`） | **需用户**决策：改名（需迁移对象）或修订文档 → 中-2 |
| KV | 生产 namespace | ⚠️ **无绑定，且代码无 KV 使用** | 建议把 KV 从目标态矩阵移除（文档与代码对齐） |
| Worker secrets（代码实际读取） | `JWT_SECRET`、`ADMIN_SETUP_TOKEN`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`RESEND_API_KEY`；可选 `RESET_FROM_EMAIL`、`FRONTEND_BASE_URL`、`BROWSER_RENDERING_TOKEN`(REST 兜底) | ⚠️ **仓库无法证实**（未联网、未执行 `wrangler secret list`）；`DEPLOY.md:180-189` 记录了"换 Worker 名后 secret 不会自动迁移" | **需用户**：跑一次 `cd backend/worker && npx wrangler secret list --name kaas` 核对（只读命令）；缺失即 503（`JWT_SECRET`/`ADMIN_SETUP_TOKEN`）或功能降级（S3→R2 binding→inline 三档回退，见 `ws_files.py:152-160`） |
| Worker vars（非机密） | `S3_ENDPOINT`/`S3_BUCKET`/`S3_REGION`/`S3_PRESIGN_EXPIRES=900` | ✅ 硬编码在 `wrangler.jsonc:58-63` | — |
| bindings | `HYPERDRIVE` / `FILES`(R2) / `BROWSER` / `ASSETS` | ✅ `wrangler.jsonc:24-29,37-42,51-53,76-84` | — |
| 自定义域名 | `kaas.powervoy.com`、`api.kaas.powervoy.com` | ✅ `wrangler.jsonc:64-75`；`workers_dev=false`（`:23`） | — |
| Cron Triggers | 两个定时任务（replied 扫描 / events 归档） | ⚠️ **审查期间由并行任务新增**：`wrangler.jsonc:20-22` + `src/ws_cron.py`（未跟踪）+ `main.py` `Default.scheduled`；**不改变本报告任何结论**，但意味着"生产定时任务"从"从未执行"变为"待发布后生效" | 随该任务提交；发布后需看 CF 的 cron 执行日志 |
| CI 部署凭据 | `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` | ✅ `deploy.yml:136-139` 引用；**是否已配 secret 需用户核实**（Actions 已限额） | **需用户** |
| 自动迁移 | `PROD_DATABASE_URL` | ⚠️ `deploy.yml:69,77-82` —— **未配置时 job 只告警跳过**；文档亦记"当前仍为手动迁移"（`README.md:150-151`） | **需用户**：配 secret 才能真正接管 |
| 前端 Sentry | `SENTRY_AUTH_TOKEN` | ✅ 仅 push 注入（`frontend-ci.yml:52-54`）；`frontend/.env.production` 两值为空 | — |
| 部署开关 | 自动部署冻结 | ✅ `deploy.yml:16-19` 仅 `workflow_dispatch`；`README.md:434-437` 留痕 | — |

### 6.4 「只能由用户操作」汇总（本次审查的最重要产出之一）

1. ~~**吊销/轮换 `.codex` 里的 Notion 令牌**（危-1，最高优先）。~~ → **2026-10-20 已裁决「不清理」**（不吊销、不重写历史；按风险接受关闭）。
2. **确认仓库当前可见性**（public/private）；若仍 public ⇒ 改 private + 决定是否轮换 Neon/管理员口令（危-2，推翻 10-17 裁决需用户点头）。
3. **核对生产 Worker 的 secrets 是否都在**（`npx wrangler secret list --name kaas`，只读）——尤其 `S3_ACCESS_KEY`/`S3_SECRET_KEY`/`RESEND_API_KEY`。
4. **Cloudflare Rate Limiting Rules**（若采纳高-4 的推荐做法）。
5. **Neon 生产分支设为 Protected**（README §2.3 规则 7 的落实状态无法离线核实）。
6. **预览环境所需的一切云资源 + repo secrets**（§6.2；不打算做就明确"不做"，避免半个环境）。
7. **R2 桶命名决策**（`kaas-files` vs 目标 `kaas-prod-storage`）。
8. **`PROD_DATABASE_URL` 是否配置**（决定自动迁移是否生效）。
9. ~~**Next 升级排期**（高-3）与**是否做历史重写**（危-1/危-2 的善后）。~~ → Next 升级已完成（`9e13ef5`）；历史重写已裁决**不做**（危-1 不清理）。
10. **策略确认**：`internal` 普通业务员是否可以看审计日志/切 feature flag（高-1/高-2 的修复口径依赖它）。

---

## 7. 中风险明细（补充证据）

### 中-1（Medium）预览环境零落地 ⇒ 三环境矩阵目前只是文档

- 证据：§6.2；`git grep 'PR_SLUG|kaas-preview|kaas-prod-storage|kaas-dev-storage'` 在 **非文档目录 0 命中**
  （仅 `README.md` 7 处、`docs/MASTER_EXEC_PLAN_2026-10-19.md` 1 处）。
- 建议：要么排进方案 B S5 一次做完（含 CI 断言），要么在 README 把 §2.2 明确标成"未排期"，避免有人按矩阵手工搭半个环境。
- 需用户操作：✅ 排期/范围决策。

### 中-2（Medium）生产资源命名与目标态矩阵不一致（R2 / KV / MinIO dev 桶）

- 证据：`wrangler.jsonc:40,60` = `kaas-files`；`README.md:75` 目标态 = `kaas-prod-storage`；
  `docker-compose.yml:71` / 本地 `.env` = `kaas-events-archive`；`README.md:75` 开发目标 = `kaas-dev`；
  目标态有 KV，代码**零 KV 使用**（`git grep -E 'env\.KV|kv_namespace'` 仅命中变量名 `kv` 的误匹配）。
- 影响：R2 桶名未来若要改，需迁移对象 + 改两处 binding/vars；桶名不一致会让"生产/预览物理隔离"的断言写得含糊。
- 建议：以**代码事实**为准修订 README §2.2（R2=`kaas-files`、删 KV 行或标注"预留"），或按目标态改名（需用户定）。
- 需用户操作：✅ 命名决策。

### 中-3（Medium）第三方 API Key 明文存 Postgres，无加密

- 证据：AI Provider Key 明文列 `ai_providers.api_key`：写入 `chain.py:591-598`、读取用于出站 `chain.py:482-490`；
  输出侧已掩码（`chain.py:76,558,574`）✓。发信邮箱 Key 明文 `outreach_mailboxes.api_key`：写 `chain.py:1409-1431`、输出掩码 `:1374`。
  全仓**无任何加密实现**（`grep -i encrypt|FerNet|KMS|pgp_sym` 仅命中历史 WeChat 表的 `*_encrypted` 列名与 aliyun KMS SDK 依赖）。
- 影响：DB 一旦被读（或备份泄露/只读角色滥用），所有下游供应商 Key 直接可用；这类 Key 通常是长期有效。
- 建议：低成本方案 = 应用层用一主密钥（Worker secret `SECRETS_KEK`）做 AES-GCM 加密入库；或先用 pgcrypto。
  至少把"输出掩码"保持现状（已做到）。
- 需用户操作：❌（代码改动；若引入 KEK 需用户确认密钥托管方式 → 属"策略"）。

### 中-4（Medium）文件直传 presign 不做 owner 授权、也无配额

- 证据：`POST /api/v1/file-objects/presign`（`ws_files.py:861-875`）只校验 `validate_upload`（owner_type/kind/MIME/大小，`kaas_common/files/rules.py:28-55`），
  然后按 `owner_type/owner_id` 直接签名 PUT URL；**没有校验调用者是否有权操作该 owner**（例如别家团队的 `product_key`/`trade_doc_id`）。
  `register`（:877-889）随后才建 DB 行（行上记的是**上传者自己的** `team_id`）。
- 影响：① 存储滥用（无每用户配额，单文件上限 8–32 MB，`rules.py:50-55`）；
  ② 可把对象写进其他团队的 owner 命名空间（对象键含 owner_id）；由于对象键含内容 sha256 且读路径按 `team_id` 过滤，**实际危害有限**。
- 建议：presign 前做 owner 归属校验（复用 `product_info_access`/`_team_scope`）；加粗粒度配额（按 user/team 计 bytes）。
- 需用户操作：❌。

### 中-5（Medium）部署链的安全/一致性缺口

- 证据：① `deploy.yml` 无 `permissions:`（对比 `frontend-ci.yml:17-18` 已收窄）——`workflow_dispatch` + `push` 恢复时会拿到默认写权限；
  ② Node 20 EOL（高-3 同源）；③ `PROD_DATABASE_URL` 未配置 ⇒ **migrate job 静默跳过**（`deploy.yml:77-82`），
  "代码上线但库没迁"的风险仍在；④ `deploy.yml:146-201` 冒烟测试做得很好（`/health` 必须 JSON、`/api/*` 必须 401、
  `shared.loaded=true`），是正面项。
- 建议：加 `permissions: contents: read`；migrate 未配置时改成 **fail（而非 warning）** 或明确标注为"已知人工步骤"；
  Node 升 22/24。
- 需用户操作：⚠️ 配 `PROD_DATABASE_URL`（需 Neon 连接串 + GitHub secret 权限）。

### 中-7 见 §4（令牌存储与生命周期）。

---

## 8. 低风险明细

| # | 项 | 证据 | 建议 | 需用户 |
| :--- | :--- | :--- | :--- | :--- |
| 低-1 | orchestrator `settings.jwt_secret` 仍保留公开默认值 | `app/config/settings.py:70` | 已被 `app/core/lifecycle.py:12-39` 启动校验拦住（默认值直接 RuntimeError）⇒ 实际风险很低；建议删默认值改必填 | ❌ |
| 低-2 | 动态 SQL 片段拼接模式（表名/列名/`%` 占位符） | 见 §2 表；`main.py:2944,3043`、`quote_api.py:1367` | 加白名单断言/注释固化契约；`%` 改 f-string | ❌ |
| 低-3 | check-then-act 写路径 | `ws_products.py:258→302`、`317→342`、`main.py:1365`、`ws_crm_ext.py:201→` | 最终 `UPDATE/DELETE` 也带 `tenant_id`/`team_id` | ❌ |
| 低-4 | `GET /api/v1/file-objects/_r2_debug` 诊断端点仍在生产 | `ws_files.py:890-900`（已限管理员） | 下线（注释自己写"排查完可删"） | ❌ |
| 低-5 | Worker 未显式关闭 FastAPI docs/openapi | `main.py:200` `FastAPI(title=…)` 未传 `docs_url=None`；实际不可达（`wrangler.jsonc:83` `run_worker_first` 只含 `/api/*`、`/health`，其余走静态资产） | 显式 `docs_url=None, openapi_url=None` 消除"将来路由一变就暴露"的可能 | ❌ |
| 低-6 | 文档/模板漂移 | ① `backend/worker/README.md:55` 仍写"push 到 main 自动部署"（与 `deploy.yml:16-19` 冻结矛盾）；② `backend/orchestrator/.env.production.template:20-25` 保留 `minioadmin/minioadmin` 弱默认值；③ `DEPLOY.md:177` 示例含真实 Neon 端点主机名（无口令，可接受） | 同步文档；模板值改 `<CHANGE-ME>` | ❌ |
| 低-7 | 生产 QA `system_admin` 账号长期存在 | `docs/PROBLEM_STATUS_2026-10-11.md:3571-3583`（`qa@example.com`, `users.id=5`, 团队 2） | 验收完成后停用（`PATCH /api/v1/admin/accounts/5` 或改库 `status='disabled'`） | ✅ 用户决定何时停用 |
| 低-8 | 归档业务数据在库 | `archive/.../sample_docs/*` 19 个文件（公司名/联系人/报价样例）；`docs/PROBLEM_STATUS_2026-10-11.md:3532` 记录 `docs/archive` 含真实姓名/成本（本轮 `stowage_raw` **已不在跟踪列表**，需再确认） | 业务方确认是否属商业秘密；若是，从当前树移除（历史仍在） | ✅ 用户/业务确认 |

---

## 9. 方法与局限（诚实声明，避免把"没查"当成"没有"）

**做了什么**
- `git grep` / `git log -S` 全历史模式扫描（密钥、DSN、令牌形态）；**当前树 vs 历史**分开判定。
- 3 个 Python 脚本（只读、`python -` 从 stdin 执行，**不落盘**）：
  ① SQL 字面量 → 插值表达式枚举；② 无 `tenant_id` 的租户表查询候选（60 条 → 人工判读）；
  ③ 无鉴权依赖的路由枚举。
- 逐文件人工核对：`worker/src/*.py`（认证、admin、文件、产品、团队、税务、单证）、orchestrator `admin.py/admin_accounts.py/admin_proposals.py/core/auth*.py/deps/rbac.py/lifecycle.py`、`kaas_common/files/s3.py|rules.py|render_pdf.py`、`frontend` 的 token-store/route-guard/next.config、4 个 workflow、`docker-compose.yml`、`wrangler.jsonc`、env 模板与锁文件。

**没做（因此这些结论有边界）**
- **未连数据库**（没有执行任何 SQL），"表里有没有数据/隔离是否真的生效"未用运行时验证。
- **未联网**：没跑 `pnpm audit` / `npm audit`（依赖漏洞数字引用 2026-10-17 文档口径，需在有网时重跑）；
  `gh` 未登录 ⇒ **仓库当前 public/private 未核实**。
- **未调用 Cloudflare / Neon API**：Hyperdrive/R2/KV/secrets/分支保护的实际状态全部标为"需用户核实"。
- 未做**穷举式**隔离验证：`tenant/team` 隔离是"抽样 + 脚本候选复核"，不是形式化证明。
- 扫描器已知局限：多行字符串会被拆成多个字面量，导致 60 个候选中**多数是假阳性**（租户谓词写在相邻字符串里）——
  这些已逐条判读并在 §2/§3 说明，不要把"候选数"当"漏洞数"。
- **行号基准（重要）**：文中所有 `文件:行` 以 **2026-10-19 审查时的本地工作树**为准。
  审查期间有**并行任务**在同一工作区写入（`backend/worker/src/main.py` 新增 `Default.scheduled` cron 入口与末尾
  `import ws_cron`，共 +18 行；`backend/worker/wrangler.jsonc` 新增 `triggers.crons`，+12 行；新增未跟踪
  `src/ws_cron.py`、`tests/test_ws_cron.py` 等）。这些改动**不影响本报告的任何结论**，但会让提交后/他人机器上的行号偏移。
  ⇒ **复核时请用符号定位（grep 函数名/路由字符串），不要只依赖行号。**

**正面确认（本轮验证过、确实做得好的项）**
- 无真 SQL 注入；所有值参数化（§2）。
- Worker 不保留任何 JWT 默认密钥，缺失即 503；orchestrator 启动即拒绝默认/弱密钥（`lifecycle.py:12-39`）。
- 账号治理端点：`system_admin` 限定 + 响应白名单（绝不含 `password_hash`/token）+ `SELF_PROTECT`/`LAST_ADMIN` 用 `FOR UPDATE` 修了竞态（`ws_admin_accounts.py:107-124`）。
- 口令重置：哈希存储、30 分钟、一次一用、不泄露邮箱存在性（`main.py:434-503`）。
- 文件域：S3→R2 binding→inline 三档显式回退、MIME/大小白名单（`kaas_common/files/rules.py`）、
  外链白名单含 `a.com.evil.com` / `user@evil.com` / 非 http(s) 协议等边界用例（`render_pdf.py:151-185`）——写得很扎实。
- 部署冒烟测试不看"状态码 200"而看"内容正确"（`deploy.yml:146-201`），是防"假绿"的正确做法。
- CI 侧：`frontend-ci.yml` 最小权限 + token 仅 push 注入；`check-runtime-deps.py` 双闸门禁（§5）。

---

## 10. 建议修复顺序（按"风险 × 成本"）

| 顺序 | 动作 | 对应项 | 归属 |
| :--- | :--- | :--- | :--- |
| 1 | ~~吊销 `.codex` 里的 Notion 令牌 + 从树中删除~~ → **已裁决不清理**（2026-10-20） | 危-1 | ✅ 按风险接受关闭（索引删除 `100e767` 保留） |
| 2 | 确认仓库可见性；若 public ⇒ 改 private | 危-2 | **用户** |
| 3 | 6 个 Worker admin 端点统一加 `_require_platform_ops` + 补 403 测试 | 高-1 | 代码（小） |
| 4 | orchestrator `admin.py` router 依赖换 `require_platform_ops` | 高-2 | 代码（小） |
| 5 | Cloudflare Rate Limiting Rules（`/api/v1/auth/*`） | 高-4 | **用户**（控制台）+ 可选代码 |
| 6 | 核对生产 secrets 清单（只读 `wrangler secret list`） | §6.3 | **用户** |
| 7 | 排期 Next 升级（含升级前重跑官方 registry audit） | 高-3 | **用户排期** |
| 8 | presign 加 owner 校验/配额；AI/邮箱 Key 加密（可下一批） | 中-3/中-4 | 代码（中） |
| 9 | 预览环境：一次做完 or 明确不做（修订 README 口径） | 中-1/中-2 | **用户决策** + 代码 |

---

**报告作者**：security-audit（teammate，task-2）
**审查时间**：2026-10-19 22:25–23:xx（Asia/Shanghai）
**基线**：`main@6104f22`；审查读取的是**当时工作树**（期间并行任务在 `backend/worker/src/main.py`、`wrangler.jsonc` 等文件写入未提交改动，见 §9 行号基准说明）。本次未触碰任何非本报告文件。
**写入范围**：仅本文件；**未 commit / 未 push / 未部署 / 未触发 CI**。

---

## 2026-10-20 复核（技术栈升级后）

- **高-3（Next 14 的 2 个 critical RCE）已消除**：Next 14.2.35 → **16.4.2**、React 19.3、
  ESLint 10.13、TS 6.0.3、CI Node 22（提交 `9e13ef5`）。
- `pnpm audit --registry=https://registry.npmjs.org`：**80 → 39 条，critical 2 → 0**；
  剩余 3 high 均为 **dev-only**（`wrangler→miniflare→sharp`、`shadcn→@modelcontextprotocol/sdk`、
  `eslint-config-next→micromatch→braces`（上游无补丁）），不进生产包。
- 越权/权限边界：`internal` 权限已按用户裁决**维持平台运营专属**（6 个 `/admin/*` + `test_admin_authz.py`）。
- 密钥：`.codex/config.toml` 已从索引删除（`100e767`）；**2026-10-20 用户裁决「令牌不清理」**
  （不吊销、不重写历史）⇒ 危-1 按风险接受关闭，`USER_ACTIONS` U-S1 已关闭。
- 用户动作清单更新：`docs/USER_ACTIONS_2026-10-19.md`（新增 S5 前置凭据清单、冷启动测量 U-E4；
  U-E2 已关闭）。
- 本轮代码侧新增面：`scripts/check-worker-bundle.py`（只读 dry-run，不上传）、`backend/contracts_frozen/`
  （冻结快照，非运行时）、`frontend/eslint.config.mjs`（构建期工具）。未新增网络暴露面。
