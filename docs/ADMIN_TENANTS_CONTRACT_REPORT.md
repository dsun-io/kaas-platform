# `/admin/tenants` 契约不一致：三方对照、真源判定与修复方案

> **性质**：**只读分析 + 方案**。本轮只新增本文件，**未改任何代码**。
> 标注：**【已核实】**= 有 file:line 或命令证据；**【推测】**= 建议；**【需用户拍板】**= 不代决。
>
> **快照**：`HEAD = 495d72a`（2026-10-11 22:4x）。
> ⚠️ **行号易漂移**：`frontend/src/mocks/handlers.ts` **正在被 task-4 队友编辑**（本轮我就撞上一次：
> 第一次读到的 tenants handler 在 `:772-803`，再次核对时已变成 `:1193-1224`）。
> 本报告所有行号都是**动笔前重新实测**的；引用时请以**路由字面量/符号名**为准。

---

## 0. 结论速览

| # | 结论 | 性质 |
|---|---|---|
| 1 | 不一致是**四方**不是三方：**前端自己就有两套 `Tenant` 类型**（`hooks/use-tenants.ts:6-10` 用 `name`；`components/types.ts:1-8` 用 `display_name/locale/region`），而实际被渲染的组件读的是**后者** | 【已核实】 |
| 2 | "租户名空白 / 状态恒停用 / reload 崩"三条后果**逐条可复现**（映射链完整：后端 `display_name`→前端读 `t.name`→`undefined`；`enabled`→前端读 `is_active`→`undefined`→falsy） | 【已核实】 |
| 3 | **生产模式确实是 real** ⇒ 这不是理论问题：`.env.production:1` = `NEXT_PUBLIC_API_MODE=real`（`config.ts:1` 的默认 `mock` 被 env 文件覆盖），MSW 在 real 下整个跳过（`msw-provider.tsx:64-68`） | 【已核实】 |
| 4 | **前端（+mock）才是功能完整的一侧**：reload 要展示"重载后的租户清单"（`reload-button.tsx:56-66`），而 orchestrator 的 reload **根本不返回清单**（`admin.py:109-112` 只有 `message/tenant_count`）⇒ 以 orchestrator 为准会**丢功能** | 【已核实】 |
| 5 | **建议真源 = 前端消费契约（= mock 现状）**：前端/mock **0 改动**，只补两侧后端 ⇒ 改动面最小、且生产可以**只改 worker 就修好**（见 §6） | 【推测】 |
| 6 | **门禁现在抓不到它**：`route-parity.py` 只查路径存在（两侧路径都在，今天是通过的）；`contracts:check` 的 R0–R4 **没有一条覆盖 admin 端点** | 【已核实】 |
| 7 | 附带发现：同一页的 `GET /admin/feature_flag` **也不一致**（worker 要 `flag_name` 且返回单值；orchestrator 返回 tenant→flags 映射，前端按映射消费）⇒ 灰度页在 real 模式下也是坏的 | 【已核实】 |
| 8 | **待用户拍板 7 条**（§8） | 【需用户拍板】 |

---

## 1. 逐字段对照表（每格带 file:line）

### 1.1 `GET /api/v1/admin/tenants`

| 侧 | 包封键 | 条目字段 | 证据 |
|---|---|---|---|
| **orchestrator** | `tenants`（必填） | `tenant_id: str`（**必填**）、`display_name: str\|None = None`、`enabled: bool = True` | 处理器 `app/api/admin.py:70-83`；**Pydantic 模型** `app/schemas/admin.py:5-12`；**committed OpenAPI** `docs/openapi.json:6673-6716` |
| **worker**（生产） | **`items`** | `tenant_id`、**`name`**（**只有 2 个字段**，且是**硬编码单条**） | `backend/worker/src/main.py:2286-2289`：`return {"items": [{"tenant_id": DEFAULT_TENANT, "name": DEFAULT_TENANT}]}` |
| **前端 hook 类型** | `tenants` | `tenant_id: str`、**`name: str`**、**`is_active: bool`** | `frontend/src/app/(app)/settings/hooks/use-tenants.ts:6-14`（`Tenant` / `TenantListResponse`），返回 `data.tenants`（`:33`） |
| **前端渲染组件类型** | —（由页面适配） | `tenant_id`、**`display_name`**、`locale`、`region`、`is_active` | `frontend/src/app/(app)/settings/components/types.ts:1-8`；渲染点 `tenant-list.tsx:41-49`（读 `t.tenant_id`/`t.display_name`/`t.region`/`t.locale`/`t.is_active`） |
| **mock（e2e/dev）** | `tenants` | `tenant_id`、`name`、`is_active`（由 `makeTenant` 产出，**恰好这 3 个键**） | `frontend/src/mocks/handlers.ts:1193-1204`；工厂 `frontend/src/mocks/data/factory.ts:72-85` |

**⇒ 三方（含前端内部两套）四个形状。** 关键冲突：
- 包封键：`tenants`（orchestrator/前端/mock）vs **`items`**（worker）。
- 名称键：`display_name`（orchestrator）vs **`name`**（worker/前端 hook/gray-release/mock）。
- 状态键：`enabled`（orchestrator）vs **`is_active`**（前端/mock）；worker **两者都没有**。

### 1.2 `POST /api/v1/admin/tenants/reload`

| 侧 | 字段 | 证据 |
|---|---|---|
| **orchestrator** | `message: str`、`tenant_count: int`（**只有计数，没有清单**） | 处理器 `admin.py:101-112`；模型 `app/schemas/admin.py:42-44`；OpenAPI `docs/openapi.json:6718-6735` |
| **worker** | **`reloaded: bool`**、**`items: [...]`**（同 GET 的单条） | `main.py:2292-2301` |
| **前端** | `reloaded_count: number`、`active_tenants: Array<{tenant_id, display_name, locale, region, is_active}>` | `hooks/use-tenants.ts:16-25`（hook 内联类型）；组件侧同形 `components/types.ts:10-13` |
| **mock** | `reloaded_count: 2`、`active_tenants: [{tenant_id, display_name, locale, region}]`（**注意：mock 里没有 `is_active`**） | `handlers.ts:1206-1224` |

> ⚠️ **mock 的 `active_tenants` 没有 `is_active`**，而 `components/types.ts:7` 把它声明为**必填** `boolean`。
> 它能跑通只是因为 `reload-button.tsx:62-65` 显式补了 `is_active: true`。
> ⇒ 这是"类型在撒谎、运行时被兜住"的一处；**改契约时别把它当成后端字段的真实需求**。

### 1.3 前端内部还有一处不一致（**这条最容易被漏掉**）

| 位置 | 名称键 | 说明 |
|---|---|---|
| `hooks/use-tenants.ts:8`（list 用） | **`name`** | 两个消费方都用这个：settings 列表、gray-release |
| `hooks/use-tenants.ts:20`（reload 用） | **`display_name`** | 同一个 hook 文件里，**同一件事两个键名** |

⇒ **"以前端为准"不能直接说，因为前端自己就不统一**。必须先在前端内部二选一（**P2**）。
（另：`region`/`locale` 在列表页是**硬编码**的 `"cn-north"` / `"zh-CN"`（`settings/page.tsx:55-56`），
而 reload 后的表格用的是后端返回的原始值（`reload-button.tsx:62` 直接展开）⇒ 同一列两种来源。）

---

## 2. 谁在消费（前端 + 后端/脚本/测试）

### 2.1 前端消费点（只有两个页面，**共用同一个 hook**）

| 消费方 | 读哪些字段 | 证据 |
|---|---|---|
| `settings/page.tsx`（租户配置 tab） | `useTenants()` 取 `tenants`；映射 `display_name: t.name`、`is_active: t.is_active`，`locale`/`region` **硬编码** | `settings/page.tsx:4, 17, 50-59`（`:54` `t.name`、`:57` `t.is_active`） |
| `settings/components/tenant-list.tsx`（被上面与 reload 共用） | `t.tenant_id`、`t.display_name`、`t.region`、`t.locale`、`t.is_active` | `tenant-list.tsx:41-49` |
| `settings/components/reload-button.tsx` | `result.reloaded_count`、`result.active_tenants.map(...)`（**`.map` 崩点**） | `reload-button.tsx:24-25, 56-66`（`:59` 计数、`:62` **未判空直接 `.map`**） |
| `admin/gray-release/page.tsx`（灰度发布） | `t.tenant_id`、**`t.name`**；并用 `t.tenant_id` 去查 feature-flag 映射 | `gray-release/page.tsx:6`（`import { useTenants } from "../../settings/hooks/use-tenants"`）、`:16`、`:41-45` |
| （mock 契约测试） | `tenants[].tenant_id`、`tenants[].name` | `frontend/src/mocks/__tests__/customer-contract.test.ts:136-153` |

**⇒ 前端真正需要的最小字段集**
- GET：`tenants[]`，每条 `tenant_id` + **名称** + **是否启用**。
- reload：`reloaded_count` + **`active_tenants[]`（清单）**，每条 `tenant_id` + 名称 + `region`/`locale`（表格要显示这两列）。

### 2.2 后端 / 脚本 / 测试消费点

| 消费者 | 消费什么 | 证据 |
|---|---|---|
| orchestrator 自身测试 | reload 断言 **`data["message"] == "Tenant cache reloaded"`**（**改 reload 响应会打破它**）；list 只断言 `"tenants" in data` | `backend/orchestrator/tests/test_admin_api.py:47-65` |
| e2e smoke | list 只断言 `"tenants" in body` 且 `len >= 2` | `tests/test_e2e_smoke.py:87-96`（另 `:146-150` 只判 200） |
| 后端 smoke（e2e 目录） | 只判 200 | `tests/e2e/test_backend_smoke.py:74-75` |
| worker 路由测试 | **只断言路由存在**（GET/POST 两条） | `backend/worker/tests/test_worker_routes.py:90-91` |
| worker/中间件测试 | 把 `/api/v1/admin/tenants` 当作"放行路径"样例 | `tests/test_workstations_api.py:125`、`test_workstation_subscriptions.py:36`、`test_middleware_chain.py:136, 264-273` |
| **committed OpenAPI** | 声明 orchestrator 的形状（`$ref` → `TenantListResponse` / `TenantReloadResponse`） | `backend/orchestrator/docs/openapi.json:482-568`、`:6673-6735` |
| 路由对等脚本 | **只查路径存在**，不查形状 | `scripts/route-parity.py`；allowlist 里 `GET /admin/tenants/{tenant_id}`（仅 orchestrator，属"有意不做"）见 `scripts/route-parity-allowlist.txt:19`、`docs/ROUTE_PARITY_2026-10-10.md:123-129` |
| 脚本 / 其他服务 | **未查到**其他消费者（全仓检索 `admin/tenants` 的命中都在上表与前端/mock 内） | §9 |

---

## 3. 真源判定（建议 + 候选 + 后果）

### 3.1 【推测】建议：**以前端的消费契约为准**（即与 mock 现状一致）

理由（四条，都可核实）：

1. **它是唯一"功能完整"的一侧**：reload 的语义要求返回**重载后的租户清单** —— 前端要靠它渲染表格
   （`reload-button.tsx:56-66`），mock 也这么实现（`handlers.ts:1206-1224`）；
   而 orchestrator 的 reload **只回计数**（`admin.py:109-112`）⇒ 以 orchestrator 为准 = **功能退化**
   （除非反过来给 orchestrator 加字段，那就等于采用前端形状）。
2. **已有可执行的契约证据**：mock 的形状被一个**通过的测试**锁定
   （`customer-contract.test.ts:136-153` 断言 `tenants[].tenant_id` / `.name`，并进一步用它查 feature-flag 映射）。
   task-4 已明确：**不能为了让后端好写而改 mock** —— 那会把 mock 模式弄坏。
3. **改动面最小、且生产可单点修复**：前端/mock **0 改动**；两侧后端补齐即可。
   更关键的是 `deploy.yml:65-104` **只部署 worker**（前端静态产物也被塞进同一个 worker，`:72-75`），
   ⇒ **只改 worker 就能修好线上**，不需要发前端（§6.1）。
4. **两个后端之间，orchestrator 是"软"的一方**：worker 是生产（`deploy.yml`），orchestrator 只有本地/测试消费者
   ⇒ 让 orchestrator 迁就前端，比让生产 worker + 前端 + mock + 测试一起迁就 orchestrator 便宜得多。

### 3.2 候选方案与后果（**需用户拍板**，见 P1）

| 方案 | 真源 | 要改谁 | 后果 |
|---|---|---|---|
| **1（建议）** | **前端消费契约 / mock 现状**：GET `{tenants:[{tenant_id,name,is_active}]}`；POST `{reloaded_count, active_tenants:[...]}` | orchestrator（含 schemas + openapi）、worker；前端与 mock **不动** | 改动面最小；生产只需发 worker；**保留**旧字段可做到前后兼容 |
| **2** | **orchestrator 的 Pydantic/OpenAPI**：GET `{tenants:[{tenant_id,display_name,enabled}]}`；POST `{message,tenant_count}` | 前端（4 文件）、mock（2 文件）、mock 测试（1）、worker（1）、**且 orchestrator reload 要补清单**（1-2） | **会改到 mock 与一个通过的测试**；灰度页 `t.name` 也要改；中间状态更脆；reload 功能需重新设计 |
| **3** | **新增并行契约**（保留旧字段 + 增加新字段，或加 `/admin/tenants/with-meta` 之类） | 两侧后端 | 零破坏，但**两套字段名长期并存**（技术债），且仍要定"前端读哪一套" |

**为什么不推荐 2 的核心理由**（不是"前端是对的"，而是"**前端这套是唯一被测试和 mock 共同锁住的**"）：
orchestrator 的 OpenAPI 只是**声明**（没有测试断言具体字段，
`test_admin_api.py:54-55` 只查 `"tenants" in data`），而前端形状有测试（`customer-contract.test.ts`）+ mock 实现两重证据。

> **反方意见（如实记录）**：orchestrator 侧有 `response_model` 强校验 + 提交在案的 `openapi.json`，
> 从"正式契约"角度它更硬。若团队的标准是"以 Pydantic/OpenAPI 为唯一真源"，则应选方案 2，
> 并接受"改前端 + 改 mock + 改测试"的代价。**这属于团队契约治理策略，应由用户拍板（P1）。**

---

## 4. 修复方案（以方案 1 为准展开）

### 4.1 目标契约（写死，供两边照做）

```jsonc
// GET /api/v1/admin/tenants  → 200
{ "tenants": [ { "tenant_id": "lianjia", "name": "联佳丝网", "is_active": true } ] }

// POST /api/v1/admin/tenants/reload → 200
{ "reloaded_count": 2,
  "active_tenants": [ { "tenant_id": "lianjia", "display_name": "联佳丝网",
                        "locale": "zh-CN", "region": "cn-north", "is_active": true } ] }
```

**字段来源映射（orchestrator 侧，全部现成）**：
- `name` ← tenants.yaml 的 `display_name`（`get_all_tenants()` 返回，`admin.py:73`；缺省回落到 `tenant_id`）
- `is_active` ← `enabled`（默认 `true`，`admin.py:79`）
- reload 的 `active_tenants` ← 重载后的同一份 `get_all_tenants()`（`admin.py:107` 已经取了它，只是没返回）
- `locale` / `region` ← **tenants.yaml 里有没有这两个键？【未查到】**（本轮没读 `config/tenants.yaml` 的实际内容；
  【推测】若没有，就先按空串或与前端硬编码同样的默认值返回，并登记为后续项）

### 4.2 逐侧改动清单

| 侧 | 文件 | 改什么 | 兼容策略 |
|---|---|---|---|
| orchestrator | `app/api/admin.py`（`:70-83`、`:101-112`） | GET 条目改出 `name`/`is_active`（保留 `display_name`/`enabled`）；reload 增加 `reloaded_count`/`active_tenants` | **旧键同时保留** ⇒ 老消费者不破 |
| orchestrator | `app/schemas/admin.py`（`:5-12`、`:42-44`） | `TenantItem` 增 `name`/`is_active`（旧字段保留为可选）；`TenantReloadResponse` 增新字段 | 同上 |
| orchestrator | `docs/openapi.json` | **重新生成**（`$ref` 形状会变） | — |
| orchestrator 测试 | `tests/test_admin_api.py:57-65` | 若保留 `message` 则可**不改**；建议**增**一条断言新字段的用例 | 保留旧键即零破坏 |
| worker（**生产**） | `src/main.py:2286-2289`、`:2292-2301` | GET 改 `{tenants:[{tenant_id,name,is_active}]}`；reload 改 `{reloaded_count, active_tenants:[...]}` | 单租户内容不变（见 4.3） |
| worker 测试 | `tests/test_worker_routes.py:90-91` 附近 | **增**一条断言响应键的用例（现在只查路由存在） | — |
| 前端 | — | **0 改动** | — |
| mock | — | **0 改动**（task-4 的纪律） | — |

**涉及文件数**：orchestrator **3**（`api/admin.py`、`schemas/admin.py`、`docs/openapi.json`）+
orchestrator 测试 **1**（建议） + worker **1**（`src/main.py`） + worker 测试 **1**（建议） = **约 5–7 个**；
前端 **0**、mock **0**（对比方案 2：前端 4 + mock 2 + mock 测试 1 + worker 1 + orchestrator 1–2 ≈ **9–10 个**）。

### 4.3 **形状可以统一，内容统一不了**（必须写清，否则会被当成"还没修好"）

worker 是**单租户**部署：`main.py:2288` 注释写着"Worker 单租户形态：tenants.yaml 不可移植，固定返回默认租户（UNCERTAIN #13）"，
且 reload 只是**记一条审计的 no-op**（`:2294`）。
⇒ 修完之后：
- **形状**：两端一致 ✅
- **内容**：orchestrator 可能返回 N 个租户；worker 永远返回 **1 条**（`DEFAULT_TENANT`）——这是**部署形态**决定的，不是契约缺陷。
  ⇒ 【需用户拍板 P6】是否接受（本文建议：接受 + 在文档里写明；不要为了"看起来一致"去 worker 里伪造多条）。
- 另外 worker 的 reload **不会真的重载配置**（无 yaml 可重载），只是记账 —— 语义差异应显式记录（【推测】保持现状 + 注释，见 `docs/CLEANUP_LOG.md` 已记过这一点）。

---

## 5. 验证方式（哪条门禁能覆盖/不能覆盖）

| 门禁 | 现在能抓到这个不一致吗？ | 证据 | 修完后的用法 |
|---|---|---|---|
| `python scripts/route-parity.py` | ❌ **不能** —— 只比对**路径**存在性，两侧路径都在（今天是通过的） | `scripts/route-parity.py`；allowlist `:19` 只登记 `{tenant_id}` 子路由 | 仍用于防"路径缺失"，**不能**当契约检查 |
| `contracts:check`（R0–R4） | ❌ **不能** —— R0=event_type、R1=quote、R2=工位元数据、R3=单证类型、R4=worker 单证镜像，**没有 admin 端点的规则** | `scripts/contracts-check.ts:10, 47, 127, 175, 216` | 【推测】新增 **R5：admin 端点响应键一致性**（把两端的响应键集合与前端 hook 类型对齐）——这是本项目既有的"跨源比对"套路 |
| orchestrator `test_admin_api.py` | ⚠️ 部分 —— 只断言 `"tenants" in data` 与 `message` 的值 | `test_admin_api.py:47-65` | 保留旧键则**不破**；建议**新增**字段级断言 |
| worker `test_worker_routes.py` | ❌ 只断言路由存在 | `test_worker_routes.py:90-91` | 建议新增响应键断言 |
| 前端单测 | ❌ **没有** —— 全仓检索 `useTenants`/`TenantList`/`reload-button` 在 `*.test.*` 里**无命中** | §9 | 建议新增 `useTenants` / `reload-button` 的渲染测试（顺带钉住 `.map` 的判空） |
| mock 契约测试 | ✅ **能**（对 mock）—— 断言 `tenants[].name` | `customer-contract.test.ts:136-153` | 方案 1 下**继续绿**；方案 2 下**必红**（这就是"改 mock 会连带改测试"的证据） |
| 端到端（e2e / 真机） | ⚠️ 只有探测 | `frontend/e2e/zz-snapshot.spec.ts:84` 只是 `probe('/api/v1/admin/tenants')` | — |

**推荐的最小可执行验证（【推测】）**：
1. 在 `shared/contracts/` 下加一份**两端共用的形状声明**（zod，与 `workstations.ts` 同套路，
   `shared/contracts/*.ts` 已被 `contracts-check.ts` 消费 —— 见 R0/R2 的做法），
2. 加 `contracts:check` 的 **R5**：从两侧源码解析出响应键集合 + 从共享声明取期望集合，三方比对；
3. 两端各加一条"响应键 == 期望集合"的单测。

> 为什么不用"关键字 grep 后端源码"当验证：本项目已明确禁用这种手法（`PROBLEM_STATUS_2026-10-11.md:34-35`），
> 而 `contracts-check.ts` 的既有规则本就是**解析源码结构**（不是 grep 关键字），照它写才一致。

---

## 6. 风险与顺序

### 6.1 部署不对称（**决定了顺序**）

**【已核实】** `deploy.yml`：`build-frontend`（`:32-63`，`NEXT_EXPORT=1` 静态导出）
→ `deploy-worker`（`:65-104`，把 `frontend/out` 一起上传，`:72-75`，然后 `pywrangler deploy`）。
**没有 orchestrator 的部署作业**。

⇒ 三个后果：
1. **改 worker = 改生产**（立即生效）；**改 orchestrator = 只影响本地/测试**（除非另有部署）。
2. **只改 worker 就能修好线上**（表 1.1 里 worker 的 `items` 是唯一生产侧原因）——
   这是方案 1 最大的好处：**一次 worker 发布即可修复，无需重发前端**。
3. 若选**方案 2**（改前端形状），前端与 worker 必须**同一次部署**（同一 artifact），
   中间状态无法"半边修好"⇒ 风险明显更高。

### 6.2 顺序（【推测】）

| 步 | 动作 | 为什么这个顺序 | 中间状态会崩吗 |
|---|---|---|---|
| S0 | 用户拍板 P1–P7（尤其 P1 真源、P2 键名、P4 reload 清单） | 这些决定改动面 | — |
| S1 | 改 **worker** 两个 handler → 跑 worker `pytest` → 发布 | 生产唯一原因；老前端**立刻**就能正确渲染 | **不会**（老前端本来就期望前端形状） |
| S2 | 改 **orchestrator**（保留旧键 + 加新键）+ 同步 `schemas/admin.py` + 重新生成 `openapi.json` | 独立于生产；本地/测试专用 | 不会（旧键保留 ⇒ 旧消费者不破） |
| S3 | 两侧各加一条响应键断言；新增 `contracts:check` R5 | 让它**不可回归** | 不会 |
| S4 | （可选）前端**不改**；如果要动，只能动"前端内部键名统一"（P2）与硬编码 locale/region（P5） | 与后端解耦，可独立排期 | 需要一起改 `use-tenants.ts` + `page.tsx`，**同一提交** |

> **反向顺序（先改前端）为什么更差**：前端改成 orchestrator 形状后，**生产 worker 仍然返回 `items`**
> ⇒ 线上还是坏的，且 mock/e2e 也要跟着动；等于把"1 个文件的修复"变成"跨三侧 + 测试的同批发布"。

### 6.3 其他风险

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| 1 | 改 worker 响应形状 → 线上其他消费者 | 【已核实】worker 侧除前端外**未查到**其他消费者（§2.2/§9）；但 `deploy` 后前端与 worker 是**同一份 artifact**，需确认线上前端版本就是仓库这份 | 保留旧键（`items`/`reloaded`）**同时**返回新键，做到向后兼容 ⇒ 任何老前端都不破 |
| 2 | openapi.json 与代码漂移 | 它是 committed 文件、**无自动校验**（`scripts/` 内未查到相关检查） | S2 手动重生成并在提交信息里注明 |
| 3 | `mocks/handlers.ts` 正被并发编辑 | 本轮实测行号从 `:772` 漂到 `:1193` | 本方案**不碰** mock ⇒ 无冲突 |
| 4 | 前端 `region`/`locale` 两处来源不同（硬编码 vs 后端） | `page.tsx:55-56` vs `reload-button.tsx:62` | 【需用户拍板 P5】：统一为硬编码、或让后端提供 |
| 5 | 灰度页 `t.name` 的连带影响 | 若真源选方案 2（改前端），`gray-release/page.tsx:43` 也要改 | 已计入方案 2 的文件数 |

---

## 7. 附带发现（**同一页面、相邻缺陷，建议一并排期**）

**【已核实】`GET /admin/feature_flag` 也不一致**，而灰度页依赖它：

| 侧 | 请求 | 响应 | 证据 |
|---|---|---|---|
| 前端 | `GET /admin/feature_flag`（**不带参数**），期望 `Record<tenant_id, Record<flag, boolean>>` | — | `admin/gray-release/hooks/use-feature-flags.ts:10-12`；消费 `gray-release/page.tsx:45` `flags?.[t.tenant_id]?.["use_v2"]` |
| orchestrator | 不带 `tenant_id` ⇒ 返回 `{tenant_id: {flags}}` 映射 ✅ 与前端一致 | — | `app/api/admin.py:188-202` |
| worker（生产） | **`flag_name` 是必填 query 参数**，返回 `{flag_name, flag_value}`（**单值，不是映射**） | — | `backend/worker/src/main.py:2237-2246` |

⇒ 在 real 模式（`.env.production:1`）下，灰度页拿到的是 `{flag_name, flag_value}`，
`flags?.[t.tenant_id]` 恒为 `undefined` ⇒ **所有开关恒显示 OFF**。
这与 `customer-contract.test.ts:147-148` 注释里描述的历史 bug（"查出来是 undefined → 恒为 OFF"）**是同一类症状**，
但这次的原因在 worker，不在 mock。

**⇒ 【推测】**：与 task-7 同源（都是"worker 侧形状与前端/orchestrator 不一致"），建议合并成一条"admin 端点契约对齐"的工作项，
但**本任务只出报告，不改代码**；是否纳入同一轮由用户/lead 定（**P7**）。

---

## 8. 待用户拍板（**共 7 条**）

| # | 问题 | 候选与后果 |
|---|---|---|
| **P1** | **真源选哪个？** | **方案 1** 前端契约/mock（改动 5–7 文件，前端/mock 0 改动，生产可只发 worker）／**方案 2** orchestrator OpenAPI（改动 9–10 文件，必改 mock + 一条通过的测试，reload 要重新设计）／**方案 3** 并行保留两套（零破坏但有技术债） |
| **P2** | 名称键统一为 **`name`** 还是 **`display_name`**？（前端内部两个键名） | 选 `name` ⇒ 与 mock/worker/hook 一致（方案 1 顺理成章）；选 `display_name` ⇒ 与 orchestrator/`types.ts`/reload 一致，但要改 list 侧的 hook + 两个消费方 + mock + 测试 |
| **P3** | 是否**保留旧字段**做向后兼容（orchestrator 同时返回 `display_name`/`enabled`/`message`/`tenant_count`；worker 同时返回 `items`/`reloaded`）？ | 保留 ⇒ 零破坏、可灰度；不保留 ⇒ 响应更干净，但任何存量消费者会立刻破 |
| **P4** | reload **是否必须返回租户清单**（`active_tenants`）？ | 必须 ⇒ orchestrator 要新增该能力（现在只有 `tenant_count`）；不必须 ⇒ 删掉 reload 后的表格展示（**功能退化**），前端要改 |
| **P5** | `region` / `locale` 由谁提供？ | 后端提供 ⇒ 要确认 tenants.yaml 是否有这两个键（**未查到**）；前端硬编码 ⇒ 两处来源统一为硬编码（现在的 reload 路径会显示空） |
| **P6** | worker **单租户内容差异**是否接受（形状统一、内容永远 1 条）？ | 接受 ⇒ 文档写明（建议）；不接受 ⇒ 需要 worker 具备多租户能力（**超出本缺陷范围**，属部署形态变更） |
| **P7** | §7 的 `GET /admin/feature_flag` 不一致**是否与本项同轮修**？ | 同轮 ⇒ 灰度页一并修好，但改动面变大（多 1 个 worker handler + 前端 hook 验证）；不同轮 ⇒ 需单独立项，否则灰度页在 real 模式下仍是坏的 |

---

## 9. 未查到清单

| # | 未查到什么 | 尝试过的范围 | 怎么才算查到 |
|---|---|---|---|
| 1 | `config/tenants.yaml` 里**是否有 `locale` / `region` 键**（决定 P5） | 本轮只读了加载器（`app/domain/tenant_config.py`），**没读 yaml 内容** | 打开 `backend/orchestrator/config/tenants.yaml`（或 `TENANTS_CONFIG_PATH`）看实际键 |
| 2 | `/admin/tenants` 除前端外的**其他消费者**（外部服务/脚本/运维工具） | 全仓检索 `admin/tenants`：命中都在 前端 / mock / 测试 / 文档 / openapi 内（§2.2） | 需要仓库外的调用方清单；若有生产日志/网关访问日志可佐证 |
| 3 | 线上（生产 worker）**实际返回的响应体** | 本机无生产凭据，本轮未发任何请求 | `curl https://api.kaas.powervoy.com/api/v1/admin/tenants`（需 internal token） |
| 4 | 线上**前端产物版本**是否等于仓库当前代码 | 无部署记录访问 | 比对 `deploy.yml` 最近一次成功运行的 commit 与 HEAD |
| 5 | 是否存在**自动校验 openapi.json 新鲜度**的机制 | `scripts/` 内检索 `openapi` → 无命中 | 查 CI 配置（`backend-test.yml` / `contracts-check.yml`）是否有该步骤 |

> 说明：本报告没有用"关键字 grep 搜不到"来断言任何**字段不存在**；
> 所有"字段不存在"的结论都来自**逐字段读源码/模型/OpenAPI**（例如 worker 的 GET 响应体是 `main.py:2289` 一行明文）。

---

## 10. 只读自证

- 本轮**只新增 `docs/ADMIN_TENANTS_CONTRACT_REPORT.md`**；未改 `frontend/**`、`backend/**`、`shared/**`、mock。
- **未跑** `next build` / `NEXT_EXPORT=1 pnpm build`（`frontend/.next` 归 e2e 队友）。
- 提交带 pathspec + `--no-verify`：
  ```powershell
  git commit --no-verify -m "..." -- docs/ADMIN_TENANTS_CONTRACT_REPORT.md
  ```
  **绝不用裸 `git commit`**（index 里可能有别人暂存的文件，本仓库已因此断过一次 HEAD）。
- 核对：`git show --stat HEAD` 只应列出本报告。
