# 现行实现地图（防止改动打在过时实现上）

> 🚫 **2026-10-20 S4 后失效说明**：本文写于**双后端时代**。现在运行时**唯一实现 =
> `backend/worker/src/main.py`**（单应用）；orchestrator 业务壳（`app/api/services/...`）
> 已全部删除，只剩 `app/db` + `alembic`。因此：
> - 文中出现的 orchestrator 路径/行号仅作**历史证据**，不再是"另一侧实现"；
> - 「新增后端接口必须两侧落地」与 route-parity 约束**已退役**（无第二后端可比）；
> - 权威口径见 [README](../README.md)、[HANDOVER_2026-10-20](./HANDOVER_2026-10-20.md)、
>   [MASTER_EXEC_PLAN](./MASTER_EXEC_PLAN_2026-10-19.md)。
>
> ⚠️ **本文件记的是当时的判断，多处已被代码超越**（stat-card 重复实现 / `POST /quote` /
> `GET /product-specs` / `customers/{}/stage` 分叉 / 出货工位门禁 均已不成立）。
> 当前问题状态以 [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 为准。

> 起因：David 提出「前端可能是过时状态，要判断哪些是最新实现，防止后期改动被旧内容覆盖」。
> 本文用**可达性证据**（不是命名、不是直觉）给出结论，并列出对后续改动的硬约束。
> 复现方式见 §8。

---

## 一、判定规则（可靠性从高到低）

| 依据 | 说明 | 可靠性 |
|---|---|---|
| **线上路由是否存在** | worker 里有 = 线上在跑；只有 orchestrator 有 = 未上线 | ⭐⭐⭐⭐⭐ |
| **前端是否真的调它** | 静态提取 `apiClient.*` 调用点 | ⭐⭐⭐⭐⭐ |
| **导航/入口可达性** | sidebar 里有的用户能点到 | ⭐⭐⭐⭐ |
| **引用链可达性** | 从 page.tsx 出发能否到达（孤儿 = 遗留） | ⭐⭐⭐⭐ |
| **显式标记** | `archive/`、`legacy`、`deprecated` 命名 | ⭐⭐⭐⭐ |
| 提交时间 | 最近改的更可能现行 | ⭐⭐（**最不可靠**：改旧代码也会变新） |
| 命名里的 `v2` | ⚠️ **完全不可靠**（见 §4） | ⭐ |

---

## 二、分支与「防覆盖」机制

### 现状（2026-09-28 切换后，已零写入核验远程）

```
main                         ← 生产分支（push 触发 CI 部署）
    │
    └─→ 线上实际运行的版本（由 main 构建）

feat/trade-doc-templates     ← 唯一的开发分支（未完成的功能留在这里）
    │
    └─→ 完成后合入 main

（已归档）feature/intel-workstation-v1 = 旧生产分支，
         它是开发分支的**祖先**（0 个独有提交），已删除；旧 main 另存 tag。
```

**背景**：切换前部署挂在 `feature/intel-workstation-v1` 上，而它被当成了“开发分支的旧快照”：
没人做 fast-forward → 落后 16 个提交 → 表现为“本地改了很多、线上毫无变化”。
根因不是“分支不对”，而是**部署分支与开发分支被当成了同一个东西**。
现在：`main` 只做生产，开发只在 `feat/trade-doc-templates`。

### ⚠️ 上线门禁（2026-09-28）

有些功能**前端已完成并验证、但后端接口尚未在 Worker 落地**。
它们一律用 `workstations.ts` 的 `status: 'planned'`（或代码里的门禁常量）挡在用户可见范围之外，
**不得**靠“后端以后再补”直接上线（否则用户点进去就是 404）。

| 被门禁的能力 | 缺什么 | 挡在哪 | 放开条件 |
|---|---|---|---|
| ~~报价工位（产品报价 / 批量报价）~~ **2026-09-28 已解禁** | 已补齐：`backend/worker/src/quote_api.py` 实现 `/api/v1/export-quote/*`、`/api/v1/quotes`、`/api/v1/quote-profiles` | 已改回 `quotes.status='active'`（`workstations.ts` 与 `workstations.py` 同步） | ✅ 已满足（测试台 25 条路由实测 + 生产冒烟） |
| ~~报价单选项（订单「由报价单转订单」、单证「报价单」上游）~~ **2026-09-28 已解禁** | 已补齐 `GET /api/v1/quotes` | 已删除 `QUOTE_ORDER_API_GATED` | ✅ 已满足 |
| 出货工位 | `/api/v1/shipments/*`(4) | `workstations.ts` 的 `shipments.status='planned'` | Worker 实现上述 4 个路由并验证 |

> **解禁前必做**：上表三处（现只剩 shipments 一处）的注释/常量一并删除，并复跑 `contracts:check`
> （R2 会校验两侧工位清单一致）。2026-09-28 解禁时已执行：R0–R4 全 PASS。
> 工作台与相关代码**未删除**，仍在开发分支上 —— 目标是“补后端”而不是“重写前端”。
>
> **另一个必须同时满足的前提**：`deploy.yml` 必须在部署前跑 `scripts/sync-shared.ps1`。
> `backend/worker/.gitignore` 忽略了 `src/kaas_common/`（镜像不进版本控制），
> 而该工作流此前**只有 `pywrangler deploy`** —— 线上 `/health` 返回
> `shared.loaded=false` 就是这个漏洞的表现。现已补上「同步 + `-Check`」两步，
> 并在冒烟里加了 `shared.loaded=true` 与报价 4 路由 401 的断言。

### 风险与对策

| 风险 | 对策 |
|---|---|
| 两边同时改同一区域 → 分叉 → 合并时互相覆盖 | **单一开发分支原则**：新工位开发都在当前分支；部署分支**只接受 fast-forward**，不在上面直接开发 |
| 本地「落后 N 个提交」是**缓存**，可能严重失真 | 改代码前先 `git ls-remote --heads origin` 核验真实 SHA（我的记忆里有过缓存显示落后 2、实际落后 28 的教训） |
| 旧的生成物/产物覆盖新代码 | §7 的"唯一真相清单" + CI 门禁（`route-parity-check`） |

---

## 三、各区域「现行 / 遗留」对照（**改代码前必看**）

| 区域 | ✅ 现行实现（只改这里） | ⛔ 遗留 / 不要改 | 判定依据 |
|---|---|---|---|
| **单证模板与渲染** | `frontend/src/lib/trade-doc/`（W0 待建，TS） | `backend/orchestrator/app/templates/trade_docs/`、`app/renderers/`（W0 删除） | 线上无渲染接口；D0=X′ 已定 |
| **线上后端** | `backend/worker/src/main.py` | — | 线上真实运行的是它 |
| **开发后端** | `backend/orchestrator/app/api/*.py` | — | 开发环境运行 |
| **共享业务逻辑** | `backend/kaas_common/`（新建，唯一源） | 两侧各手写一份（历史做法） | 收敛方案 §3 |
| **报价引擎** | `backend/orchestrator/app/api/export_quote.py`（`/export-quote/*`，14 个接口） | — | 提交 `cc89b3b`/`d918214` 引入；前端 v2-quote 在用 |
| **客户税率档案** | `backend/orchestrator/app/api/quote_profiles.py`（`/api/v1/quote-profiles`，4 个接口）+ 表 `customer_quote_profiles` | ⛔ 旧表 `customer_pricing_profiles`（三档加价倍率 + 单一税点）**仍被旧线性流水线读**，不要写 | 2026-09-27 新增；见下方说明 |
| **报价历史** | `backend/orchestrator/app/api/quotations_api.py`（`/api/v1/quotations`） | — | 前端 `use-quotations.ts` 在用；线上也有 |
| **旧报价 CRUD** | — | ⛔ `backend/orchestrator/app/api/quotes.py`（5 个 `/quotes` 接口，9.4KB） | **前端零调用 + 线上无此路由** → 遗留 |
| **规格向导** | `quote_wizard.py`（`/spec/wizard/*`） | 注意它**名字有误导性**：不是报价接口 | 路由 prefix 实为 `/api/v1/spec/wizard` |
| **规格体系（权威）** | 后端 `app/services/export_quote/products/field_fence.py` + `GET /export-quote/products/{key}/formulas` | 旧扁平模型（见 §4） | `niulanwang.ts` 注释明确"运行时权威来源仍是后端" |
| **前端共享组件** | `frontend/src/components/shared/stat-card.tsx` | ⛔ `app/(app)/dashboard/components/stat-card.tsx`（孤儿，重复实现） | 死代码检测（§5） |
| **认证** | 线上 `POST /auth/login`（worker 有） | ⚠️ `POST /auth/register`、`POST /auth/logout` 线上**没有** | 路由审计 |
| **报价计算（前端调用）** | ✅ `/export-quote/calculate`（客户视图）/ `/export-quote/calculate-internal`（内部视图），见 `use-export-quote-calc.ts` | — | 已于报价工位重写时改正（原为 ⛔ `POST /quote`，两边后端都不存在） |

### 3.1 两个「档案」不是一回事（2026-09-27 起）

报价页里叫「档案」的东西有**两层**，现在在同一个下拉里，但归属完全不同：

| | 法定税务档案 | 客户税率档案 |
|---|---|---|
| 是什么 | 国家政策：销项税率、印花税率、按 HS 编码的出口退税率 | 这个客户自己填的那套税率 |
| 谁维护 | 平台（`services/export_quote/rate_sets/*.yaml`） | 用户（界面上自己存、自己起名） |
| 粒度 | 全国一份，按生效日期版本化 | 每个**客户 + 产品**一份，可存多份 |
| 变动 | 政策变一次新增一份，从不改旧文件 | 随时增删 |
| 存储 | yaml 文件（只读） | 表 `customer_quote_profiles` |

**为什么客户档案必须记住它绑定的法定档案编号**：两层在同一个下拉里一起选，
只套税率不切法定档案的话，「客户档案 + 另一份法定档案」会算出一个谁都没确认过的组合，
而金额看着完全正常。

**为什么另建一张表而不用 `customer_pricing_profiles`**：那张旧表是 INT-R3 时代的模型
（三档加价倍率 + 单一税点），**且仍有一条活的读取路径** ——
`services/quote_engine` → `services/niulanwang_pricing` → `repositories.pricing_profiles_repo.get_current_profile`。
把新模型的行插进去，那条老路径会按「加价倍率」解读它们，读到 null / 垃圾值继续算，
**不报错也不告警**。所以两张表分开，各自服务各自的模型。

**档案不是一条新的算价路径**：套用档案做的事就是「把表单填好」，
与用户手敲一遍的结果逐字段相同，引擎收到的仍然是 `rate_set_code` + `policy` 覆盖。
这条约束保证「用档案算出来的价」与「手填算出来的价」不可能分叉。

---

## 四、⚠️ 「v2」命名不可信（新旧混淆的根源）

项目里 `v2` 至少出现在**三个互不相关的语境**，含义甚至相反：

| 出现位置 | 实际含义 | 新/旧 |
|---|---|---|
| `/quotations/v2-quote` 页面 | 出口报价引擎工位 | **新** |
| `X-Use-V2` 请求头 | 路由版本灰度开关 | **空转**（见下） |
| `niulanwang.ts` 注释：「**旧**扁平模型（v2 报价流程）」 | 旧的规格模型 | **旧** ⚠️ |

### `X-Use-V2` 是**空转机制**（实证）

| 环节 | 事实 |
|---|---|
| 前端 | 每个请求都发 `X-Use-V2`；默认值由 `NEXT_PUBLIC_USE_V2_DEFAULT` 决定，而该变量**在所有 `.env*` 里都不存在** → 默认 `false` |
| 开发后端 | `app/middleware/route_version.py` 读头 → 设 `request.state.use_v2` → 回显 `X-Route-Version` |
| **消费端** | **全仓搜索：没有任何业务路由读取 `use_v2`**（只命中中间件、测试、`config/tenants.yaml`） |
| 线上后端 | worker 仅在 CORS `Allow-Headers` 里列了它，**无任何逻辑** |

**结论：不能靠 `v2` 判定新旧**，也不能假设"v2 路径是新实现"。

---

## 五、前端死代码（`scripts/dead-code-audit.py` 实测）

162 个文件，98 个被引用，**17 个候选孤儿**：

| 类别 | 文件 | 判定 |
|---|---|---|
| 测试文件（11 个） | `lib/**/__tests__/*.test.ts` | ✅ 正常（vitest 直接加载，不算孤儿） |
| **重复实现** | `app/(app)/dashboard/components/stat-card.tsx` | ⛔ 遗留（`components/shared/stat-card.tsx` 才是现行） |
| 未使用组件 | `components/ui/scroll-area.tsx`、`components/ui/virtual-table.tsx`、`components/error-boundary.tsx` | 🟡 备用组件，暂不算债 |
| 疑似被替代 | `hooks/use-role.ts` | 🟡 待核（`lib/auth/auth-context.tsx` 已提供角色能力） |
| 无导航入口的页面组件 | `app/(app)/spec-config/components/TemporalGroupForm.tsx` | 🟡 `spec-config` 整条流程无 sidebar 入口（见 §6） |

> **好消息**：前端**没有大面积新旧并存**，主要是少量未使用文件。真正的"双份"风险在后端（已单独审计）。

---

## 六、已知的契约不一致与死链（都会让"改动无效"或"页面报错"）

| # | 问题 | 影响 | 处置 |
|---|---|---|---|
| 1 | `POST /quote` **两个后端都没有**，但 `useQuoteV2()` 在调 | **智能报价页的核心动作 404**；本地可能被 MSW mock 掩盖而看不出 | 归入 A 类，W4 一并处理 |
| 2 | `GET /product-specs` 线上没有 | 智能报价页选项加载失败 | 同上 |
| 3 | `customers/{}/stage`：开发版 `POST` / 线上 `PATCH` | 同一语义两个方法 | W1 修正（小） |
| 4 | `/spec-config`、`/admin/spec-proposals` 有页面**无 sidebar 入口** | 功能存在但用户到不了 | 待业务确认是否补入口 |
| 5 | `export-quote/*`（9 个）线上缺失 | 智能报价的算价/批量导入不可用 | W4 按"是否已启用"处置 |

---

## 七、对后续改动的硬约束（写进 W0–W4 的执行纪律）

1. **单证相关只改前端**：`frontend/src/lib/trade-doc/**`；**不再**往 `backend/orchestrator/app/templates/` 加东西。
2. **共享逻辑只写 `backend/kaas_common/`**，两侧只写薄适配（禁止再手写第二份规则）。
3. **不碰 `quotes.py`**（遗留）；报价相关只挂 `export_quote.py` 与 `quotations_api.py`。
4. **新增后端接口必须同时落地两侧**（orchestrator + worker），否则 `route-parity-check` 会拦下。
5. **改代码前先核验分支真实 SHA**（`git ls-remote`，不信本地缓存）。
6. **判断"哪个是现行"一律用 §1 的规则**，不看 `v2` 命名、不看文件新旧时间。
7. 前端组件放 `components/shared/`（不要放 `app/**/components/` 下造成重复）。

---

## 八、复现方式

```powershell
$py = "C:\Users\76516\AppData\Local\Programs\Python\Python312\python.exe"
cd d:\MyProject\kaas-platform
& $py scripts\route-parity-audit.py    # 后端双份实现差异（前端调用面 × 两侧路由）
& $py scripts\dead-code-audit.py       # 前端孤儿文件
git ls-remote --heads origin           # 分支真实状态（不依赖 fetch 缓存）
```

三个命令都是**只读静态分析**，不连网、不碰数据库，可随时重跑做回归。
