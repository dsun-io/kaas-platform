# 现存问题对账（2026-10-11）

> **本文是「问题状态」的当前口径。**
> 此前多份文档（`CURRENT_IMPLEMENTATION_MAP` / `MULTI_PRODUCT_QUOTE_PLAN` /
> `DUAL_BACKEND_CONVERGENCE` / `WORKER_ORCHESTRATOR_DRIFT` / `EXECUTION_SUMMARY_2026-10-10` /
> `FRONTEND_PRODUCTION_READINESS`）记的是**当时**的判断，其中相当一部分**已经修复**。
> 想知道"现在还剩什么问题"，看这一份；想了解当时的判断过程，去看原文。

***

## 交接摘要（滚动更新 · HEAD `043c72d`）

> **新开对话 / 上下文压缩后，先读这一节**，再往下看细目。
> 下面「方法」一节的数字是**写本文时**的，已过期；以本节为准。

### 已完成（全部已推送 `origin/main`）

| # | 事项 | 提交 / 动作 |
|---|---|---|
| A1 | worker 补「单证合计 = 行项合计」金额勾稽 | `c2ee256` |
| C1 | 删除 `kaas_common/db` 共享 Repository 死代码 | `e6b54e5` |
| C2 | worker 客户可见性判定与共享内核 `customer_rules` 对齐 | `7688b77` |
| B1 | 生产库 schema 对齐（当时落后 **14 个迁移**）+ 租户统一 | `2a46e63` + 生产库迁移 |
| B2 | 新团队试用工位 —— 用户裁决**维持现状**，无需改动 | — |
| A2 | 规格体系改自由数值 + 三产品（牛栏网/勾花网/鹿网）+ 前端退役枚举轴 | `f6b4b62`…`6d27b39` |
| — | 体积扣减由固定 m³ 改**比例**（修掉小单负体积） | `b337251`、`8eead90` |
| — | **用智能表格真实数据核算引擎**（公式级不一致 0） | `c7d096e` |
| #2b | 团队级档位**改显示名 / 软停用**（双侧 + 生产库迁移 `202610110015`） | `f3a8196`…`f61a41d` |
| — | 原料价**历史参考均价**（未新建历史表，见下） | `043c72d` |

### 当前门禁（全绿）

| 门禁 | 结果 |
|---|---|
| orchestrator `pytest -m unit` | **511 passed** / 1 skipped |
| worker `pytest` | **142 passed** |
| 前端 `test` | **280 passed / 0 failed** |
| 前端 `typecheck` / `lint` | exit 0 |
| `contracts:check` | R0–R4 PASS |
| `route-parity.py` | PASS（缺失 22 已登记 / 未登记 0 / **过期 0** / worker 独有 8） |
| `sync-shared.ps1 -Check` | exit 0（共享内核 21 / 报价引擎 19 / 枚举字典 1） |
| `NEXT_EXPORT=1 pnpm build` | exit 0 |
| `scripts/verify/verify_against_sheet.py` | exit 0（公式级不一致 0） |

### 关键环境事实（踩过的坑，别再踩）

- **租户 ≠ 团队**：`tenant_id` 恒为 `"default"`（**已不是隔离边界**）；
  **`team_id` 才是**。定价/成本那条路**完全不按 team 过滤**，
  但通过 `customers.team_id` 事实上已隔离。
- 无 `pnpm`/`npm`/`npx`：用
  `C:\Users\HJ\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`
  + `...\pnpm\bin\pnpm.mjs`。
- 跑 `.ps1` 前必须 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。
- `wecom-cli` 在 `C:\Users\HJ\wecom-cli-tool\node_modules\.bin`；
  前置检查 `--version` ≥ 1.2.1 + `auth show --status`。
- 生产库 = Neon `KaaS` / `production` 分支。DSN 取
  `neon connection-string production --database-name neondb`，
  **要 `-replace '^postgresql://','postgresql+asyncpg://'`** 才能喂 alembic。
- 智能表格：「客户询盘跟进表 → 明细表」21 行 / 55 字段。
  **没有鹿网的数据行**（所以鹿网只能用公式逐点比对，不能拿数据核）。
- 报价引擎与共享内核**都要镜像到 worker**：改完跑 `pwsh scripts/sync-shared.ps1`，
  否则 worker 端是旧的（本人踩过，差点漏）。

### 还没做的（建议顺序）

1. ~~**反向漂移 8 条**~~ ✅ **已结**：6 条修掉（webhook 收敛 4 + 爬取端点 2），
   余 2 条 `subscriptions` 有既有裁决「有意保留」。详见下「反向漂移：逐条取证与处置」。
2. ~~**前端认证契约残留**~~ ✅ **已收口**（`35a89a8`）：前端不再发 `X-Tenant-Id`，
   `Session` 不再带 `tenant` 字段。原因见下。
3. **接口级测试**（#2b 与均价都只有纯函数单测）、**前端档位管理界面**。
4. 规格库 11 条接口 / 依赖漏洞 98 个 + next 14→15 / e2e 26 条归真 /
   产品定义可视化编辑器 / 团队管理员转让 / 单证投产联调。

### 旧表 `customer_pricing_profiles` 活读取路径已收口（`51e26f9` 之后）

### 前端认证契约残留已收口（`35a89a8`）

**症状**：前端仍保留 `tenant.{tenant_id}`，并据此注入 `X-Tenant-Id`。

**为什么是隐患（两层）**：

1. `tenant_id` 已全量统一为 `default`（迁移 `202610110005` unify_tenant），
   **租户不再是隔离边界，团队（team_id）才是**；账号身上根本没有"租户"。
2. 更关键的是这个值**从哪来**：`updateSession` **从来不写** `tenant`，
   唯一来源是 `getCurrentSession` 里从 **localStorage 的过期 `kaas_user`** 反推。
   于是发出去的可能是**早已失效的旧值**，而后端还拿它做限流分桶与日志上下文 ——
   属于"**看着有用、实际误导**"。

**处置**：删掉注入与字段。后端本就不需要它
（`middleware/auth.py` 鉴权后自行设 `request.state.tenant_id = DEFAULT_TENANT`）。

**顺带更正一处与事实不符的注释**：`middleware/rate_limit.py` 写着
"每租户限流、不同租户独立限流"，而租户已统一 —— key 里的 tenant 部分
实际恒为同值，**真正起区分作用的是 IP**。读不到头时落 `"unknown"`，
与原先"所有人都发同一个 default"是**同一种分桶**，限流效果不变。
保留该前缀是因为限流要在**鉴权之前**判定，那时拿不到可靠的 team_id。

验证：前端 `typecheck` exit 0；`lint` 仅既有 `<img>` warning；
测试 **280 passed / 21 files**；后端仅改 docstring。

### 反向漂移：逐条取证与处置（2026-10-11）

`route-parity.py` 报「worker 独有 8 条」，它**不算 FAIL**，只提示
「建议在 orchestrator 侧补齐」。但逐条查过之后发现**性质完全不同**，
不能一概"补齐"，也不该一概放过。取证结果：

| 路由 | 取证 | 性质 |
|---|---|---|
| `POST /api/v1/leads/crawl-batch` | **前端在调它**（`leadgen/page.tsx:222` 的批量爬取按钮） | 🔴 **真 bug**：orchestrator 没有 ⇒ **dev 环境下该按钮 404** |
| `GET /api/v1/subscriptions`<br>`GET /api/v1/subscriptions/bundles` | 前端调的是 **`/teams/{id}/subscriptions`**（带 team id），**不是**这两条；全仓（前端/脚本/orchestrator）**零调用**；但有**既有裁决**：`docs/archive/2026-09-30-doc-cleanup/SYSTEM_AUDIT.md:90` 标为「需确认 → **留**」，理由"用量/订阅" | ✅ **有意保留**（平台/订阅目录，非残留） |
| `POST /api/v1/leads/{lead_id}/crawl` | 前端未直接调用 | 单条爬取，与上面的批量是同一功能的两个入口 |
| `GET/PUT/PATCH/DELETE /api/v1/outreach/webhook` | worker 是 `@app.api_route(methods=[GET,POST,PUT,PATCH,DELETE])`，函数体**只 raise 501**（`INBOUND_WEBHOOK_RESERVED`） | 预留桩，**任何方法都无副作用**；orchestrator 只有 `POST` |

两点结论：

1. **`crawl-batch` 不是"漂移"而是"dev 缺功能"** —— 前端按 worker 的接口写的，
   而 orchestrator 从未实现。worker 侧的实现是**自成体系**的
   （内联 SQL + `_crawl_one` + `_require_sub`），移植到 orchestrator
   （SQLAlchemy / 本地 asyncpg）不是小活，**不能顺手补**。
2. **`outreach/webhook` 那 4 条不该"补到 orchestrator"** ——
   把一个"只 raise 501 的预留桩"按 5 种方法暴露出去，是把线上攻击面
   无谓地放大（虽然目前无副作用）。更合理的方向是**把 worker 收敛到 POST**，
   与 orchestrator 一致、与语义一致（inbound 回写本来就是 POST）。

**用户 2026-10-11 裁决**：

- `outreach/webhook` → **worker 收敛到只留 POST** ✅ 已做（`chain.py`，
  `api_route(methods=[5 种])` → `@app.post`）。反向漂移 **8 → 4**。
- `leads/crawl-batch` / `leads/{lead_id}/crawl` → **补到 orchestrator**（待做）。
- 总策略追问「以 orchestrator 为准会影响部署架构吗」→ **不会**。已取证：
  `.github/workflows/deploy.yml` 只做「构建前端静态导出 + `pywrangler deploy`
  单个 Worker `kaas`」，**没有任何一步部署 orchestrator**。
  所以"以 orchestrator 为准"只是把它的路由清单当**规格**，
  不是让 orchestrator 上生产、也不是合并两套后端。

  **但有一条限制**（这也正是用户选"补到 orchestrator"的原因）：
  该原则只对 **worker 多余的东西**成立；对 **worker 有的真功能**，
  不能因为 orchestrator 缺就把它删掉 —— 那是**往 orchestrator 补**。

  | worker 有 / orchestrator 无 | 有人在用？ | 处置 |
  |---|---|---|
  | `webhook` 的 GET/PUT/PATCH/DELETE | ❌ 只 raise 501 | **从 worker 收掉** ✅ |
  | `leads/crawl-batch`、`leads/{id}/crawl` | ✅ 前端在调 | **补到 orchestrator** |
  | `subscriptions` ×2 | 待确认 | 先查清再定 |

### `leads/crawl-batch` 补到 orchestrator：施工方案（**未开工，原因见下**）

用户已定「补到 orchestrator」。取证后发现**这不是小活**，故作罢交下一轮，
避免半成品。

**落点**：`app/api/leadgen.py`（orchestrator 已有 `/leads` 列表、`/leads/{id}` 详情、
`/leads/scan-replied`、`/leads` 创建），缺失的是爬取两条：
`POST /leads/{lead_id}/crawl`、`POST /leads/crawl-batch`。

**为什么不能顺手补**：worker 侧的两条端点依赖 4 个助手，
经逐项核对，**orchestrator 侧 4 个全缺**：

| 助手 | 作用 | orchestrator |
|---|---|---|
| `_is_safe_crawl_url` | **SSRF 防护**（只允许公网 http(s)） | ❌ 缺 |
| `_http_get_text` | 抓取网页文本 | ❌ 缺 |
| `extract_product_from_html` | 从 HTML 抽产品名/图片/规格 | ❌ 缺 |
| `_enrich_product` | 把抽取结果富集并回写 | ❌ 缺 |

其中 **`_is_safe_crawl_url` 是安全敏感件**（对外发起网络请求的入口），
必须**逐行照搬 worker 的实现**，不能凭理解重写 —— 这类防护少一条判断就是 SSRF 洞。

**已有的可复用件**：

- 订阅门禁：orchestrator 侧是 `app.api.subs.require_leadgen`（对应 worker 的
  `_require_sub(conn, "leadgen")`）✅
- 查询风格：worker 用内联 SQL + Hyperdrive；orchestrator 的 `leadgen.py`
  用 SQLAlchemy（且 `lead_candidates` **没有 ORM 模型**，需用 `text()` 或裸 SQL）
- 两条端点的业务逻辑本身很短（worker 侧 `chain.py:1709-1810`），
  真正的分量在那 4 个助手上

**建议顺序**（下一轮照此做）：先逐行搬 `_is_safe_crawl_url` 并**为它补测试**
（拒绝内网/回环/非 http(s)/重定向到内网），再搬抓取与抽取，最后接两条端点。

#### 🔴 移植过程中发现的**安全问题**：重定向可绕过 SSRF 防护

worker 的抓取用的是 `redirect: "follow"`（`chain.py:211`），
而 SSRF 防护**只校验请求前的 URL**。于是：

```
http://evil.com  --302-->  http://169.254.169.254/latest/meta-data/
```

请求的确发往 `evil.com`（合法，通过校验），但客户端**自动跟随**到了
云元数据地址。**只校验第一跳等于没校验。**

**orchestrator 侧已按正确做法实现**（`app/services/lead_crawl.py`）：
关掉自动跟随，用 `next_redirect_url` 把每一跳的 Location 过同一把尺子，
并限制最多 5 跳。已补测试（12 条：相对/绝对跳转解析、
指向内网/回环/云元数据/file: 的跳转一律拒绝、空 Location 拒绝、
"任何网络动作之前先过尺子"）。

**worker（生产）侧已修**（本轮）：`redirect: "follow"` → `"manual"` +
逐跳校验，两条路径（`js.fetch` 与 `urllib` 回退）都改，
免得留下"换个运行环境就有洞"的缝。

Cloudflare 官方文档确认了这个改法可用且是官方推荐：
「If set to `manual`, the **`3xx` redirect response will be returned to the
caller as-is**」以及「If the response is a redirect and the redirect mode is
set to `follow`, then all headers will be forwarded to the redirect
destination... you should **set redirect mode to `manual` and implement your
own redirect policy**」。

#### 顺带把一个更大的隐患修掉了：安全件不再有两份

补 orchestrator 时，我一度把守卫在 orchestrator 复制了一份，并给 worker 那份
配了一条测试，结果**测试被 skip 了**，于是我把成因写成
「`chain.py` 依赖 Pyodide，在 CPython 测试里根本 import 不了」。

**这条结论是错的，在此更正**：`chain.py` 是**可以**在测试里导入的 ——
`tests/test_product_extract.py` 早就有现成办法：stub 一个 `main` 模块
（`app` / `_acquire` / `_get_current_user`）、把 `src` 加进 `sys.path`，
再 `import chain`。那条测试甚至**已经在覆盖** `_is_safe_crawl_url`、
`extract_product_from_html`、`_abs_url`。

我的测试之所以被 skip，纯粹是**没做这个 stub 与 sys.path 设置**，
不是"做不到"。**把"我没搭起来"写成"根本测不了"，是把自己环境的局限
当成了事实** —— 这类错误比代码 bug 更难发现，因为它看起来像一条结论。

（搬进共享内核这件事**仍然成立**，只是理由不同：不是为了"能测"，
而是为了**不留两份**、避免将来漂移。）

一条跳过的安全测试比没有更糟 —— 它看起来像有覆盖。

**处置**：抽出 `backend/kaas_common/net.py`（`is_safe_crawl_url` +
`next_redirect_url` + 常量），两端 import **同一份**：

- worker `chain.py` 的 `_is_safe_crawl_url` / `_next_redirect_url` 变成薄别名
  （保留旧调用点，语义指向唯一真源）
- orchestrator 的 `app/services/lead_crawl.py` 只留 httpx 那部分（平台原语不同）
- 测试跑在 orchestrator 套件里 —— **测的就是 worker 实际执行的那份代码**

`sync-shared.ps1` 已把 `net.py` 镜像过去（共享内核 21 → **22 个文件**）。

#### 移植进度

| 助手 | 状态 |
|---|---|
| `is_safe_crawl_url`（SSRF 防护） | ✅ 逐行照搬（`e578941`） |
| `http_get_text`（出站抓取） | ✅ 已移植，且**两处刻意不同**：用 httpx 而非 `urllib` 同步回退（后者会阻塞 FastAPI 事件循环，一次爬取 15 秒全站卡住）；逐跳校验重定向 |
| `extract_product_from_html`（抽产品信息） | ✅ 已入共享内核（`crawl_extract.py`） |
| `_enrich_product`（富集回写） | ✅ 按端各自实现（两端 `run_ai_task` 签名不同） |
| 两条端点（`POST /leads/{id}/crawl`、`POST /leads/crawl-batch`） | ✅ **已接**（`2a158cb`）—— dev 的「批量爬取」404 **已修好** |

**全部完成**：`route-parity` 的「worker 独有」由 **8 → 2**，
剩下 2 条即上表的 `subscriptions`（有既有裁决、有意保留）。

文档里挂着的那条**真缺陷**关掉了。它是一条**静默误读**链路：

```
services/quote_engine.create_quote
  → services/niulanwang_pricing.calculate_base_cost / calculate_tiers
    → repositories/pricing_profiles_repo.get_current_profile
      → customer_pricing_profiles（INT-R3 时代的三档加价倍率模型）
```

模型注释自己写着风险：**把新模型的行插进旧表，老路径会按「加价倍率」解读它们
—— 读到 null / 垃圾值继续算，不报错、不告警。**

**处置：整链删除**（三个文件），理由是它已是死代码 ——
`create_quote` 的唯一引用是 `services/__init__` 的再导出，
加一个测试里的 `assert is not None`；**没有任何 API 调用它**
（`app/api/quotes.py:254` 那个同名 `create_quote` 是路由处理器，不相干）。

连带改动：

- `services/__init__.py` / `repositories/__init__.py` 去掉对应 import 与 `__all__` 条目
- `tests/test_knowledge_provider.py` 里那条"报价链不依赖 FastGPT"的断言
  改断言**现役引擎** `app.services.export_quote.build`（原断言对象已删除）
- `models.CustomerQuoteProfile` 的注释更新（原文写"仍被旧线性流水线读取"，已不成立）

**表本身保留**（里面有历史数据；删表是破坏性动作，需单独决定）。
它现在是**退役状态**：没有任何代码读它，也没有新的写入路径 ——
隐患来自"被读"，读路径没了，隐患即消失。

验证：`app.main` 可导入；orchestrator **511 passed**（不变）；
     worker **142 passed**；`route-parity` PASS；`sync-shared -Check` exit 0。

***

## 方法

不转述文档，而是**实跑门禁与代码取证**（2026-10-11，HEAD 见下方提交）：

| 门禁 | 命令 | 当时结果 |
|---|---|---|
| 契约 | `pnpm -C frontend contracts:check` | ✅ exit 0（R0–R4 全 PASS）**改动前 R2、R4 FAIL** |
| 前端测试 | `pnpm -C frontend test` | 1 failed / 281 passed（失败＝既有 `niulanwang`） |
| 类型 | `pnpm -C frontend typecheck` | ✅ exit 0 |
| Lint | `pnpm -C frontend lint` | ✅ exit 0（仅 warning，无 error） |
| 路由对等 | `python scripts/route-parity.py` | ✅ PASS（缺失 22 已登记 / 未登记 0 / 过期 0 / worker 独有 8） |
| 三方漂移 | `python scripts/route-parity-audit.py` | 【线上坏】6（全部是"有意不做"的平台运维端点） |
| Worker 测试 | `pytest backend/worker/tests` | ✅ 138 passed |
| 后端单测 | `pytest -m unit`（orchestrator） | ✅ 451 passed / 1 skipped **改动前 1 failed → CI unit 任务红** |

---

## 一、本轮已修复（10 项，各一个提交）

| # | 问题 | 提交 |
|---|---|---|
| 1 | **R2 契约漂移**：`workstations.ts` 有工位 `tenant-products`，后端镜像从没有过 → 面包屑/标题退化 | `18f1c03` |
| 2 | **R4 检查器失效**：`DOC_NO_FIELDS` 下沉共享内核后旧解析器抓到无关代码 → 既误报"合同号印成发票号"又完全不设防 | `5b814c8` |
| 3 | **单证逐字节基准在 Windows 全红**：`core.autocrlf` 把 LF 基准检出成 CRLF，18 类单证假红 | `9971f30` |
| 4 | **`route-parity.py` 在 Windows 崩溃**：GBK 下打印 `ℹ️` 抛 `UnicodeEncodeError`，判定算完却看不到结论 | `c1626b4` |
| 5 | **审计脚本只读 `main.py`**：worker 已拆 18 个模块 → 62 条假警报 | `8538652` |
| 6 | **生产缺 `POST /auth/logout`**：前端点登出就是 404（allowlist 里唯一"前端已调用"的待补项） | `e319f26` |
| 7 | **`quote-profiles` 本地联调 404**：Worker 双路径、orchestrator 只有一条，前端用的是缺的那条 | `440e81d` |
| 8 | **CI unit 任务红**：`test_knowledge_provider` 被标 `unit` 却真连 PostgreSQL，CI unit 任务无 postgres service | `d04dd2d` |
| 9 | **单证金额勾稽生产端缺失**：内核 `validate_confirm` 只校验到**行级**，「单证合计 = 行项目合计」只有 dev 有 → 线上能确认"合计≠明细"的单据（信用证不符点） | `c2ee256` |
| 10 | **管理员判定有两份**：`customer_rules.can_see_all` 把 `account_type='internal'` 也算管理员 → `qa_user` 这类内部普通账号能看全部租户 | `7688b77` |
| 11 | **共享 Repository 死代码**：零引用，且 SQL 模板完全没有 `team_id`/归属过滤 —— 接线会**绕过团队隔离** | `e6b54e5` |
| 12 | **生产 schema 落后 14 个迁移**：线上库停在 `202609300001`，代码 head 是 `202610110014`；8 张表 2 个列在生产根本不存在，而对应端点早已上线 | 见下「生产库对齐」 |
| 13 | **规格体系只认枚举**（A2 第一步）：引擎此前要求轴必须匹配 `axis.options`、变体属性必须唯一命中选项 —— 客户实际会给的 `2.3mm` 根本填不进来，"丝径自由配置"无从谈起 | `f6b4b62`（能力层已落地，见下「A2 进展」） |

**另一批"文档写着未完成、实际早已完成"的**（本轮只做核对，未改代码）：

| 原记录 | 出处 | 实测 |
|---|---|---|
| `customers/{}/stage` POST/PATCH 契约分叉 | `WORKER_ORCHESTRATOR_DRIFT` §三、`DUAL_BACKEND_CONVERGENCE:156` | **两端都是 PATCH**（`customers.py:333`、`main.py:1016`） |
| 线上没有 `/api/v1/quotes` → 单证报价单下拉是空的 | `MULTI_PRODUCT_QUOTE_PLAN:86` | **有**，5 条（`quote_api.py:1771-1967`） |
| 线上 `export-quote` 批量导入面板是坏的 | `MULTI_PRODUCT_QUOTE_PLAN:380` | **有**（`quote_api.py:901-978` import/template·preview·calculate） |
| worker 客户读接口不做归属过滤 → "列表里有、点进去 404" | `ROUTE_PARITY_2026-10-10.md:157-171` | **已加**（`main.py:855-867`：`is_deleted` + `_can_see_all` + scope 条件） |
| `useQuoteV2()` 调 `POST /quote` → 智能报价页核心动作 404 | `CURRENT_IMPLEMENTATION_MAP:166` | 前端已无此调用；`useQuoteV2` 不存在 |
| `GET /product-specs` → 智能报价页选项加载失败 | `CURRENT_IMPLEMENTATION_MAP:167` | 前端只在 `mocks/handlers.ts` 引用，无真实调用点 |
| `dashboard/components/stat-card.tsx` 重复实现 | `CURRENT_IMPLEMENTATION_MAP:153` | 只剩 `components/shared/stat-card.tsx` 一份 |
| 出货工位被门禁挡着（缺 `/api/v1/shipments`×4） | `CURRENT_IMPLEMENTATION_MAP:55`、`MULTI_PRODUCT_QUOTE_PLAN:482` | **已实现**（`ws_shipments.py` 4 条路由） |
| 工位订阅校验未完成 | `EXECUTION_SUMMARY_2026-10-10.md:69` | **已完成**（与同批 `PRODUCT_CONFIG_TENANT_UNFINISHED.md` 自相矛盾） |
| 前端 A/B/D（工位可见性·团队生命周期·`quotation` 类型）"执行中" | `FRONTEND_PRODUCTION_READINESS.md:154`、`PLAN_CUSTOMER_RECORDS.md:110` | **已落地**：`layout.tsx:41` 挂 `WorkstationGate`；`team/page.tsx`、`register/page.tsx` 有工位/团队选择；sidebar 走 `filterNavGroups` |
| 页面名有 3 个来源、`/market` 面包屑与 `/research` 重名 | `PLATFORM_UPGRADE_PLAN.md:47-49` | **已收口**到 `shared/contracts/workstations.ts` + R2 门禁（现 PASS） |
| `POST /auth/register` 线上 404 | `TODO_REMAINING_2026-10-10.md:67` | 已补（`main.py:377`） |

---

## 二、仍然存在（已取证）

| # | 问题 | 证据 | 严重度 |
|---|---|---|---|
| 1 | **旧表仍有一条活读取路径**：`quote_engine.py:15 → niulanwang_pricing.py:12,113 → pricing_profiles_repo.get_current_profile` 读 `customer_pricing_profiles`；插入新模型行会被按加价倍率**静默误读**，不报错不告警 | `backend/orchestrator/app/services/niulanwang_pricing.py` | 中高（静默错误） |
| 2 | **反向漂移 8 条**：`outreach/webhook`×4 方法、`subscriptions`×2、`leads/crawl`×2 —— 只存在于 worker，用 orchestrator 重新生成 worker 会丢功能 | `route-parity.py` worker 独有清单 | 中 |
| 3 | **`outreach/webhook` 线上攻击面更宽**：worker 允许 GET/POST/PUT/PATCH/DELETE，orchestrator 只有 POST。**注意**：处理体是预留桩，任何方法都直接返回 501、无副作用 → 不是安全洞，只是两端不一致 | `worker/src/chain.py:1685` | 低（待复核） |
| 4 | **待补路由 22 条**：其中 11 条规格库（`/product-specs`、`/spec/attributes*`、`/spec/skus*`、`/spec/templates*`）前端未直接调用，allowlist 标"按需补" | `scripts/route-parity-allowlist.txt` | 低 |
| 5 | **产品组合数三方不一致**：前端按轴相乘得 **120**，常量是 **160**，测试断言 **48**；后端 4 处断言 `combo_count == 160` | `shared/contracts/niulanwang.ts:99,175`；`test_export_quote_api.py:96,276`、`test_export_quote_formulas.py:324`、`test_export_quote_import.py:82,283` | 中（A2 一并解决：轴改自由数值后该口径作废） |
| 6 | **前端认证契约残留**（不影响功能，`tsc` exit 0）：`lib/auth/session-cache.ts` 仍有 `tenant` 结构与 `user?.tenant_id` 读取；`lib/api/client.ts:43-46` 仍会注入 `X-Tenant-Id`（值恒为空，实际不发） | 只读扫描 | 低（死代码） |
| 7 | **依赖债**：next `^14.2.0 → 15.x` 专项未做。**实测 98 个漏洞**（3 严重 / 24 高危 / 56 中 / 15 低）—— 比 `CLEANUP_LOG.md:110` 记的 82 **更差** | `pnpm audit`（2026-10-11 实测） | 中 |
| 8 | **e2e 26 条失败未归真**：依赖本机后端 + 数据库，属"页面没数据"，本轮未复跑 | `CLEANUP_LOG.md:32-34`、`E2E_GUIDE.md:38` | 中 |

### 生产库对齐（2026-10-11 已执行，先演练后上生产）

**这一步推翻了本文早先以及多份文档的说法。** 文档一直写「联佳丝网在生产对任何人不可见」，
但直连生产库（Neon 项目 `KaaS` / `production` 分支）实测是另一回事：

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| `alembic_version` | `202609300001`（落后仓库 head **14 个迁移**） | `202610110014`（= head） |
| 缺表 | `teams` / `team_invites` / `team_subscriptions` / `user_subscriptions` / `tenant_products` / `tenant_workstation_products` / `entity_links` | 全部建好 |
| 缺列 | `customers.team_id`、`customers.is_deleted` | 已有 |
| `customers` 数据 | 只有 1 行 QA 冒烟，`tenant_id='qa-smoke-0000-…'` —— **根本没有「联佳丝网」这一行** | 该行 `tenant_id` 已统一为 `default` |
| `teams` | （表不存在） | 1 行：「安平县联佳丝网制品有限公司」，`tenant_id='default'` |

**真实的生产事故是「线上跑的代码，schema 没跟上」** —— 这些端点早已上线，
而它们依赖的表/列在生产根本不存在。
文档里「联佳在生产不可见」描述的其实是 **dev 分支**（当时已在 head，
有 teams=1 / customers=2 / quote_orders=3）。

执行方式（**先演练再上生产**）：

1. 从 `production` 克隆 Neon 分支 `migrate-rehearsal`；
2. 在演练分支跑 `alembic upgrade head` —— 20 个迁移全部通过；
3. 核对演练分支 schema 无误后，才对 `production` 执行同一条命令（同样 20 个，exit 0）；
4. 删掉演练分支。

**验证**（不依赖 token，沿用本项目自己的 PREPARE 手法）：
在生产库上对 15 条**真实端点 SQL 形态**逐个 `PREPARE`（只编译不执行）——
14 条一次通过；第 15 条 `entity_links` 是探针自己把列名写成 `src_kind`
（实际是 `src_type`），改正后通过 → **15/15**。

### 关于组合数（§二 #5）的取证（**未擅自改**，已并入 A2）

### A2 进展（2026-10-11）

**已完成 —— 能力层**（`f6b4b62`）：`ProductSpec` 新增 `numeric_inputs`
（`NumericInput`：key/label/unit/ui_unit/ui_scale/default/min/max/decimals/note），
引擎两条路径都支持自由数值：

- `spec_from_partial` 接受任意值 → 转 Decimal + 上下界防误填（**不枚举**）
- `expand_specs` 把默认值注入每个组合；数值参数**不参与笛卡尔积**
  （连续量没有"组合数"）
- 新增 7 条测试钉死该能力；单元测试 453 → **460 passed**
- 向后兼容：`numeric_inputs` 默认空，`field_fence` 行为不变

**已打通到对外接口**（`8b11b20`）：`describe_product` 暴露 `numeric_inputs`；
定价键的自由数值维度显式声明 `kind="numeric"`（不整维跳过，否则"存了查不到"）；
`explain` 端点接受自由数值（非数值 → 400 `invalid_numeric`）；
引擎容忍同单位后缀（"1.2m"/"100mm"）但不跨单位换算。

**未完成 —— 产品与界面（2026-10-11 尝试过 `field_fence` 改造，验证后回退）**

改造本身是可行的：把 `de`/`height_m`/`mesh_mm` 与 `inner_wire` 变体包
（dm/dv/roll_len_m/roll_dia_m）改成 `numeric_inputs` 后，`combo_count` 从 160
降到 10（表面处理 5 × 工艺 2），§二 #5 的 120/160/48 之争随之作废；
`explain` 基线（65.4020kg / 0.1080m³ / 29.9000m³）逐项不变。

但**集成点比预想多**。实测清单（下次照单推进，别漏）：

| # | 集成点 | 状态 |
|---|---|---|
| 1 | `models.NumericInput` + `ProductSpec.numeric_inputs` | ✅ 已做 |
| 2 | `engine.expand_specs` / `spec_from_partial` | ✅ 已做 |
| 3 | `engine._numeric_value`（含单位后缀容忍） | ✅ 已做 |
| 4 | `app/api/export_quote.py` 的 `explain` 自建规格解析 | ✅ 已做 |
| 5 | `formulas.describe_product` / `describe_pricing_key`（含 `kind="numeric"`） | ✅ 已做 |
| 6 | `importers.py` 的表头映射 + 模板列生成 + `NumericInput.unit_factors` | ✅ 已做（`ccc9d16`） |
| 7 | 前端渲染自由数值 + 退役 `NIULANWANG_SKU_AXES` / `NIULANWANG_COMBO_COUNT` | ✅ 已做（`fa5ee26`、`8d0249d`） |

**牛栏网改造已完成并全绿**（`397aaca`）：`combo_count` 160 → **10**，
重量/体积公式一行未改（本就与企微表格逐项等价）。
验证：orchestrator **469 passed** · worker **142 passed** · 前端 **280 passed / 0 failed**
（那条「各轴相乘 = 48」的红测试随枚举轴一起退役，换成"这些导出不该存在"的反向守卫）·
`contracts:check` R0–R4 PASS · `route-parity` PASS · `sync-shared -Check` exit 0 ·
`NEXT_EXPORT=1 build` exit 0。

改造过程中挖出并修掉 **3 个真 bug**：

| # | 问题 | 后果 | 位置 |
|---|---|---|---|
| a | `实际占用 = 长方体总体积 − 2.5` 是**固定扣减** | **< 2314 米（23 卷）的单子体积为负数**，而这个数要给货代/报关 | `field_fence.py` `SpaceDeduction` |
| b | 尺寸类改自由数值后**绕过了别名表的单位因子** | 「竖丝间距(cm)」的 10 被当成 **10mm**，重量差十倍 | `importers._numeric_factor` |
| c | 空 spec 时变体没选 → 公式取不到 `raw_price`/`wave_factor` | **算出空值却仍返 200**（比报错更坏）。两端各补 `missing_variant` 400 | orchestrator `export_quote.py` / worker `ws_quote_ext.py` |

**另一个发现**：worker 的 `explain`（`ws_quote_ext.py`）**有自己的规格解析**
（`app/api/` 不在镜像范围），此前同样没读 `numeric_inputs` —— 生产端会算出空值。已修并对齐。

### 本轮新拍板的 4 项（用户 2026-10-11 决定，待实现）

| # | 决定 | 要做什么 |
|---|---|---|
| 1 | ✅ **已完成**（`b337251`）**体积扣减改为比例 3.7%**，与「装柜系数」合并 | 见下「体积扣减已修复」 |
| 2 | ✅ **结案：能力已存在，无需改代码**（用户 2026-10-11 确认）；但派生出 **2b** | 见下「档位自建：已存在的能力 + 一个新的缺口」 |
| 3 | **原料价历史 + 均价展示** | 每单填的原料价要留存，并在没有报价时给"参考均价" |
| 4 | ✅ **已完成**：勾花网（`48e591d`）+ 鹿网 | 见下两节 |

### 鹿网已实现（`products/deer_net.py`）

### 术语澄清：租户 ≠ 团队（**重要，避免再搞错粒度**）

用户追问「租户级是什么？团队粒度吗」时核查出的结论：

| | 是什么 | 现状 |
|---|---|---|
| **`tenant_id`** | 历史遗留的租户列 | **恒为 `"default"`**（`unify_tenant` 迁移把所有数据统一到它）→ **已经不是隔离边界** |
| **团队 `team_id`** | **真正的隔离边界** | 客户 / 订单 / 单证 / 工位订阅都按它隔离（B1 修的就是这一条） |

证据：`DEFAULT_TENANT = "default"` 遍布 orchestrator 与 worker；
**定价/成本这条路完全没有 `team_id` 过滤**（grep 零命中）；
而 `team_id` 密集出现在 `teams.py`(62) / `workstations.py`(23) / `auth.py`(22) /
`customers.py` / `orders.py` / `trade_docs.py`。

**所以「租户级一套」= 全实例共用（所有团队混在一起），不是团队粒度。**
此前一轮的选项用词误导了用户，已更正并重新确认。

另一个好消息：现有「自加档位」虽按 `(tenant_id, customer_id)` 存，
但 customer 属于 team（`customers.team_id`）→ **事实上已团队隔离**；
跨客户查看（`scope=all`）要求 `require_tenant_admin`（系统管理员）。
所以问题不在"有没有隔离"，而在"粒度选哪一层"。

### #2b 定稿：档位按**团队级**增删改查

用户 2026-10-11 最终裁决（更正后）：

| 对象 | 粒度 | 理由 |
|---|---|---|
| **档位目录**（有哪些档位、显示名、启用/停用） | **团队级** | 档位 = **公司能做什么**，不该因买家而异 |
| **成本价**（定价数据） | **买家客户级（不动）** | 成本 = **不同买家拿到不同价**，这是商务差异 |

实现要点（下轮照此做）：

- 新表 `team_option_overrides`，键 `(team_id, product_key)`，
  JSONB 载荷形如
  `{"coating_code": {"rename": {"zinc_40": "40克锌层"}, "disabled": ["pvc_black"]}}`。
  **不能塞进 `tenant_products`** —— 那张表存的是**完整 ProductSpec 快照**，
  写进去会让该租户的产品定义冻成快照，以后代码改产品定义它不跟着变。
- 应用顺序：产品定义（代码或租户快照）→ 并入买家自加档位（现有）→ **再套团队级覆盖**。
- **软停用**：停用的档位从下拉里消失，但 `spec_from_partial` 仍能解析它 ——
  否则已引用它的历史报价单重算会取不到档位。定价数据删除已是软删除，沿用同一惯例。
- **改的是显示名，不是 code**：code 是查价键的一半，一变历史定价数据与报价单就对不上。
- 一个待收口的一致性：现有「自加档位」是**从定价数据反推**的（per-customer），
  而档位目录改团队级后两者关系要明确。计划：**保留自动反推作为兜底**
  （不破坏"加档位只有一步：录成本"这个设计），显式目录负责**改 / 停用**。

**#2b 进度**：机制层已完成（存储 + 应用 + 读路径接线），**写接口待做**。

| 部分 | 状态 |
|---|---|
| 表 `team_option_overrides`（键 `(team_id, product_key)`，JSONB） | ✅ 模型 + 迁移 `202610110015` |
| `models.apply_option_overrides`（改名 + 标记停用） | ✅ |
| `models.visible_options`（界面清单过滤，引擎不用） | ✅ |
| `describe_space` / `describe_pricing_key` 滤掉停用项 | ✅ |
| `services/option_overrides.py`（读 / 整体写 / 增量合并 / 载荷归一） | ✅ |
| `_with_team_overrides` 接进有效产品定义 | ✅ |
| **写接口（增删改查 REST）** | ❌ 下轮 |
| **迁移应用到生产库** | ❌ 待做（表是空表，无数据风险） |

两条约束在**代码里**落实（不只是注释）：

1. **改名只动 `name`，`code` 一字不改** —— 查价键用 code，
   实测改名后 `describe_pricing_key` 仍输出 `zinc_40`、引擎仍能按 code 解析。
2. **停用是"标记"不是"移除"** —— 停用档位**留在 `options` 里**并打 `disabled: true`，
   于是引擎仍能解析它（已引用它的历史报价单可重算），
   而 `describe_space` / `describe_pricing_key` 把它滤掉（界面看不到）。
   专门有一条测试断言"引擎能解析停用档位"。

`_with_team_overrides` 在 `auth.team_id` 为空时**不做任何事**，
**不退化到全实例** —— 否则会把别的团队的档位混进来，正是本次要避免的粒度错误。

公式取自表格的公式字段：

```
单件重量 = 0.01234 × L × ( De² + Di²(N−2)/2 + (W×1000+80)×Dw²/(S×10)/2
                          + (N−2)×140×Dt²/(S×10)/2 )
```

整理成与牛栏网同写法（0.00617 = 0.01234 ÷ 2）后逐项等价。

**⚠️ 本产品没有真实数据可核对**：表格 21 行里**没有鹿网记录**
（只有牛栏网 / 勾花网 / 刺绳 / Y型立柱 / 骑马钉 / 围栏钳等）。
所以改成"把表格公式原样抄进测试再逐点比对"：4 组输入上两条公式相对误差 < 1e-20。
这一点已写进产品 `notes`，避免后人误以为它像牛栏网/勾花网那样被真实数据验过。

另外补了一条**防丢经验项**的测试：表格里的 `80` 与 `(N−2)×140` 是经验项，
去掉任一项后量纲照样对、数字照样出得来但**值错了**，所以专门断言
`带经验项 ≠ 只带80 ≠ 都不带`。

计价按**重量**（`cost_unit = "CNY/kg"`）：表格的成本公式是
`IF(产品="勾花网", L×W×元/㎡, 元/kg×单件重量)` —— **只有勾花网按面积**，
其余都按重量。这条由表格定的，不需要额外确认。

### 三个产品现状

| 产品 | 公式核对方式 | 计价口径 |
|---|---|---|
| 牛栏网 | 表格 4 行真实数据，**逐位相符** | 元/kg（按重量） |
| 勾花网 | 表格 3 行真实数据，**逐位相符** | 元/㎡（**按面积**） |
| 鹿网 | **无数据行**，与表格公式逐点等价（相对误差 < 1e-20） | 元/kg（按重量） |

### 勾花网已实现并用表格数据核算（`products/chain_link.py`）

**公式逐位对齐智能表格实测值**（表里勾花网 3 行，`单件重量` 是公式字段）：

| d(mm) | S(cm) | W(m) | L(m) | 引擎 | 表格 |
|---|---|---|---|---|---|
| 2.5 | 5 | 1.8 | 10 | 28.8000 | 28.8 |
| 3.0 | 6 | 1.8 | 10 | 34.5600 | 34.56 |
| 3.0 | 5 | 1.2 | 25 | 69.1200 | 69.12 |

按面积计价也对上了：`L×W = 30㎡ × 9.3 元/㎡ = 279` ✓（表格同为 279）。

**两处与牛栏网的实质差别**（都是表格口径，不是特例代码）：

1. **成本按面积**：`cost_unit = "CNY/㎡"`，件价 = 单位价 × **单件面积**。
   价链本身与单位无关（`price.breakdown(cost_pretax)` 只要求成本与 cost_unit 同单位，
   「单位价 → 件价」由产品自己乘），所以**没有为按面积计价改价链**。
2. **不预置表面处理档位**，由客户在定价数据里自建。

**「档位由客户自建」这条链路本轮才真正打通**，过程中发现两个必须修的点：

- `describe_pricing_key` 原本会**跳过没有取值的维度**。档位由客户自建时，
  产品定义里就是"声明了但没取值" —— 跳掉这一列，客户在定价页看不到、
  加不进来，就永远报不了价。已改为：**声明了就要画出来**（空选项也画），
  只有完全没声明的维度才跳过。
- 引擎本来就要求每个变体包都给值，于是"还没有档位"时报的是
  `缺少「表面处理」；可选: `（**空列表**，等于没说）。已改成可操作的提示：
  「该产品还没有可选档位 —— 请先在『定价数据』里添加档位」。

验证：模拟客户加档位后，`spec_from_partial` 正常解析、重量与表格相符；
新增 `tests/test_export_quote_chain_link.py` 10 条钉住上述行为。

### 体积扣减已修复（`b337251`，即上表 #1）

### 档位自建：已存在的能力 + 一个新的缺口（上表 #2 / #2b）

**#2 结案**（用户确认）：用户要的「表面处理档位由客户自行添加」**系统已经支持**，
不需要改代码。链路：

```
定价数据里加档位 → load_option_extensions(db, tenant, customer, product)
                 → models.extend_product 并入产品定义
                 → _with_customer_options 同时喂给「规格空间」与「算价」两个入口
```

关键性质（都是设计里写明的）：

- 新档位**只写 code + 显示名**，不写 `raw_price`
  —— 「成本由定价数据提供，这正是『定价数据就是成本来源』的落点」，
  即用户说的「只加名字、价每单填」；已有实现。
- 规格接口与算价接口**共用同一份有效定义**，注释原话：
  「两边看到的选项必须完全一致 —— 只要有一边用了原始定义，就会出现
  『下拉里能选、一算就报错』或者『算了但下拉里选不到』」。
- 产品定义是全局的，客户加档位是客户自己的事。

**#2b 新缺口**（用户追加口径：「保留全局默认，客户可以对其进行**增删改查**」）：

`extend_product` 目前**只会追加**（`options + added`），因此客户对**全局默认档位**
只能"用"，不能改名、停用或删除。要做到增删改查，需要一层**客户级覆盖**：

- 增：已有 ✅
- 删 / 停用：需要 per-customer 的 `disabled` 集合（且**不能删**历史报价引用到的
  档位，否则老报价单重算会取不到档位）
- 改：需要 per-customer 的显示名覆盖（`code` 必须保持稳定 —— 它是查价键的一半）
- 查：已有（定价数据矩阵会列出已定义取值 + 客户自加值）✅

设计要点：**改的是显示名，不是 code**。code 一变，历史定价数据与报价单就对不上了。

### 用户新指令（2026-10-11）

### 用智能表格真实数据核算报价引擎（`scripts/verify/verify_against_sheet.py`）

用户指令：「报价功能你可以用智能表格中的数据来核算是否正常」。
数据源：「客户询盘跟进表 → 明细表」（21 行 / 55 字段 / 19 个公式字段），
取**牛栏网且数据完整**的 4 行，两层核算。

**第一层 · 公式级：完全一致**（4/4 行相对误差 = 0，门槛 1e-20）

```
表  ：0.01234 × L × (De² + Di²(N−2)/2 + Dw²((W×1000+(N−1)×50)/2/(S×10)))
代码：0.00617 × L × (2·de² + (n−2)·dm² + dv²(w + (n−1)×50)/s)
```

数学上等价（0.01234 = 2×0.00617、w = W×1000、s = S×10）。
体积同理：表 `(卷径/100)²×W×数量` ↔ 代码 `卷径²×网高×件数`。
**这直接证明了 A2 改造没有动坏重量/体积链路。**

**第二层 · 引擎输出**：差异全部来自引擎**刻意**的 4 位小数落定
（代码注释：为了让表上「单卷重 × 卷数 = 总重」对得上）。

| 指标 | 最大相对偏差 |
|---|---|
| 单件重量 | 1.4e-6 |
| 单件体积 | 2.4e-4（0.0724 vs 0.0723823） |
| 长方体总体积 | 4.3e-4 |

建议（未改）：体积类 `decimals` 由 4 提到 6 —— 体积量级只 0.1 m³，
第 4 位小数已是 0.1% 分辨率，乘几百件后放大到 4e-4。

**顺带发现两处口径差异（未擅自改）**：

1. 表格里真实的装柜系数是 **0.96（扣减 4%）**，而上一轮按
   「满柜 2–3 m³ ÷ 40HQ 68 m³」推算的是 **3.7%**。满柜处两者都落在工厂经验区间
   （4% → 2.72 m³、3.7% → 2.52 m³），但**表格是业务自己配的数**。
   「以表格为准」与「按整柜容量上限推算」两条指令在此冲突，待用户确认。
2. 表格把装柜系数做成**每行可编辑的输入**（21 行都是 0.96）→
   它应当是**每单可改**的，而不是产品定义里的常量。

1. 「系统化全部开始吧，该做的都要做」—— 剩余项按依赖顺序逐项推进，不再逐条等确认。
2. **「报价功能你可以用智能表格中的数据来核算是否正常」**——
   企微智能表格「客户询盘跟进表 → 明细表」有 **21 条真实记录**（55 字段、19 个公式字段），
   可作为报价引擎的**黄金数据集**做交叉验证：用表里的输入参数跑我们的引擎，
   比对表里公式算出的单件重量 / 总体积 / 成本 / 售价 / FOB·CFR·CIF。
   这是对 A2 改造最直接的正确性证据。

原先 `实际占用 = 长方体总体积 − 2.5 m³`（每单扣一次、不随数量缩放）。
实测牛栏网：**< 2314 米（23 卷）的单子实际占用体积为负数** ——
而这个数是要给货代/报关的。

改为 `volume_effective_m3 = volume_box_m3 × (1 − space_deduction_ratio) − space_deduction`：

| 订单米数 | 卷数 | 长方体体积 | 实际占用 | 扣减 |
|---|---|---|---|---|
| 100 | 1 | 0.1080 | **0.1040** | 0.0040（原为 −2.3920） |
| 30000 | 300 | 32.4000 | 31.2012 | 1.1988 |
| **63000** | **630** | **68.0400** | **65.5225** | **2.5175** ← 满柜，落回工厂经验「2~3 m³」 |

比例 `0.037` 的来源：工厂原话「满柜减 2–3 m³」取中位 2.5
÷ 40HQ 可用容积约 68 m³。**该推算被满柜数据反向验证**（2.52 m³ ∈ [2,3]）。

模型上 `SpaceDeduction` 新增 `mode="ratio"`；固定额与比例是两个不同性质的量
（m³ vs 无量纲），分开给、公式里合成，两者可叠加。
`explain` 两端也补了该系数（它们各自设作用域，漏了会算出空值）。

**第 6 项是回退的原因**：导表（CSV/Excel 导入导出）的表头映射在
`importers._build_header_map` / `_resolve_column` / `template_columns` 里，
它按 `product.axes` / `variants` 建表，不认识 `numeric_inputs` ——
不补这一环，`field_fence` 的报价表**整个导入不出来**。
而这里映射错了会**静默导错报价数据**（不是报错），风险高于收益，
所以没有在同一轮里硬塞。正确顺序是：先补 importers + 模板生成，
再改产品定义，最后动前端。

**表格公式（已逐项核对）**：牛栏网的代码实现与表格**完全等价** ——
代码 `0.00617×L×[2·d边²+(n−2)·d横²+d竖²(w+(n−1)×50)/s]`
↔ 表格 `0.01234×L×(De²+Di²(N−2)/2+Dw²((W·1000+(N−1)·50)/2/(S·10)))`。
待补的是另两个产品的分支（鹿网含 `(N−2)×140×拧花丝径²/(S·10)/2` 一项；
勾花网是 `d²×1.28/S×W×L`，且**成本按面积** `L×W×元/㎡`，不是按重量）。

**一个待你确认的设计点**：表格把「原材料进货成本 元(kg/㎡)」做成**每单填写的输入**，
而代码把它做成产品变体属性 + 定价数据查表（`raw_price`）。
按"以表格为准"，新产品的原料成本应声明为 `numeric_inputs`（每单填）；
但那样会与现有「定价数据」机制并存。这一条下一轮开工前需要你点头。

| 值 | 来源 | 推导 |
|---|---|---|
| **120** | 前端轴相乘 | 3（丝径方案）× 2（网高）× 2（竖丝间距）× **5**（镀锌量）× 2（工艺） |
| **160** | `NIULANWANG_COMBO_COUNT` + 后端 4 处断言 | `RELEASE_2026-10-10_quote_model.md:61` 记「组合数 64 → 160」；`1efeabc` 同一提交把镀锌量扩到 5 项并写下 160 |
| **48** | 测试断言（`niulanwang.test.ts:22`） | 3×2×2×**2**×2 —— 镀锌量还是 2 项时的旧值 |

关键：`64 = 4×2×2×2×2` ⇒ 那个口径假定**丝径方案有 4 个取值**，
而前端 `NIULANWANG_SKU_AXES.wire_option` 只有 **3** 个（`all_wire_20` / `all_wire_25` / `edge25_inner20`）⇒ 才落到 120。

**所以是二者之一，都需要业务判断，本轮没有擅自改**：
1. 前端 `wire_option` 漏了一个取值（补上则 4×2×2×5×2 = 160，与后端一致）；或
2. 后端的 160 已过期（则前端 120 与常量都该跟着改）。

---

## 三、需要产品决策（不擅自改）

1. **A2 的柜级体积扣减层级**：2–3 m³ 是「圆柱体按长方体算、对**整柜**多占的量」（工厂经验总结）。
   现在引擎 `resolve_space_deduction` 把它解析成**一个数、只扣一次**（等价"每单一次"）。
   一单多柜时应改为 `扣除额 × 柜数` —— 需你确认按「每单一次」还是「每柜一次」。
2. **`outreach/webhook` 是否收紧到 POST**（对应 §二 #3）：处理体是 501 预留桩、
   任何方法都无副作用，所以不急；但将来若实现 inbound 回写，`GET` 必须去掉
   —— 邮件客户端预取链接会误触发（标记已回复之类）。

**已定的（记录口径，勿再当作待决）**：

- **租户模型** → 统一到 `default`（收敛为「单租户 + 团队隔离」）。**已于生产执行**（见上「生产库对齐」）。
- **新团队试用工位** → **维持现状**（不给试用，由管理员开通）。
- **共享 Repository 层** → **删除**，不接线（`e6b54e5`）；理由见 `DB_LAYER_OPTIMIZATION.md`。

---

## 四、需要排期 / 环境（非本轮）

- 规格库 11 条接口补齐（前端未调用，按需）
- 依赖升级专项（next 15 + 漏洞收敛）
- e2e 26 条归真
- 产品定义**可视化**编辑器（现仅 JSONB 文本编辑）
- 团队管理员转让（现固定为创建者）
- 单证渲染**投产联调验收**：18 种模板就绪，生产联调（字段打通 / PDF·打印 / 盖章 / 双语 + 样张对照）未做

---

## 五、文档状态（照旧文档施工会踩空）

| 文档 | 状态 |
|---|---|
| `CURRENT_IMPLEMENTATION_MAP.md` | 多处过期（stat-card / POST quote / product-specs / stage 分叉 / shipments 门禁） |
| `MULTI_PRODUCT_QUOTE_PLAN.md` | `:86`、`:380`、`:482` 三项已不成立 |
| `WORKER_ORCHESTRATOR_DRIFT.md` | 数字口径过期（当时工具只读 `worker/src/main.py`），已被 `route-parity.py` ＋ 修好的 `route-parity-audit.py` 取代 |
| `DUAL_BACKEND_CONVERGENCE.md` | 方案仍"待批准"；A 类 33 → 现 6、B 类 10 → 现 8 |
| `EXECUTION_SUMMARY_2026-10-10.md` | `:69` 与 `PRODUCT_CONFIG_TENANT_UNFINISHED.md` 自相矛盾 |
| `FRONTEND_PRODUCTION_READINESS.md` | A/B/D 标"执行中"，实际已落地 |
| `PLATFORM_UPGRADE_PLAN.md` | `:47-49` 命名冲突已由契约 + R2 收口 |
| `ROUTE_PARITY_2026-10-10.md` | 结论以本文 §一、§二 为准（缺口 24 → 22，待补 13 → 11，worker 独有 12 → 8） |

---

## 复现方式

```bash
pnpm -C frontend contracts:check
pnpm -C frontend test
pnpm -C frontend typecheck
python scripts/route-parity.py
python scripts/route-parity-audit.py
cd backend/worker && pytest tests -q
cd backend/orchestrator && pytest -m unit -q
```
