# 现存问题对账（2026-10-11）

> **本文是「问题状态」的当前口径。**
> 此前多份文档（`CURRENT_IMPLEMENTATION_MAP` / `MULTI_PRODUCT_QUOTE_PLAN` /
> `DUAL_BACKEND_CONVERGENCE` / `WORKER_ORCHESTRATOR_DRIFT` / `EXECUTION_SUMMARY_2026-10-10` /
> `FRONTEND_PRODUCTION_READINESS`）记的是**当时**的判断，其中相当一部分**已经修复**。
> 想知道"现在还剩什么问题"，看这一份；想了解当时的判断过程，去看原文。

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
| 1 | **单租户硬编码**：Worker 所有查询固定 `tenant_id='default'`，而数据里存在 `lianjia` / `client_b` 租户 → `联佳丝网` 在生产**对任何人不可见**，联佳新建的数据落 `default` 被别家看到 | `worker/src/platform/db.py:28`；`chain.py` 数十处 | 高（数据隔离） |
| 2 | **共享 Repository 层是死代码**：4 个 Repository 类 + SQL 模板**零 importer**，API 仍走 `app/repositories/*`（SQLAlchemy）与裸 asyncpg → 双份维护没消除，还多一份没人用的 | `kaas_common/db/repositories.py`、`queries.py` | 中 |
| 3 | **旧表仍有一条活读取路径**：`quote_engine.py:15 → niulanwang_pricing.py:12,113 → pricing_profiles_repo.get_current_profile` 读 `customer_pricing_profiles`；插入新模型行会被按加价倍率**静默误读**，不报错不告警 | `backend/orchestrator/app/services/niulanwang_pricing.py` | 中高（静默错误） |
| 4 | **反向漂移 8 条**：`outreach/webhook`×4 方法、`subscriptions`×2、`leads/crawl`×2 —— 只存在于 worker，用 orchestrator 重新生成 worker 会丢功能 | `route-parity.py` worker 独有清单 | 中 |
| 5 | **`outreach/webhook` 线上攻击面更宽**：worker 允许 GET/POST/PUT/PATCH/DELETE，orchestrator 只有 POST | `worker/src/chain.py:1685` | 中（安全面待复核） |
| 6 | **待补路由 22 条**：其中 11 条规格库（`/product-specs`、`/spec/attributes*`、`/spec/skus*`、`/spec/templates*`）前端未直接调用，allowlist 标"按需补" | `scripts/route-parity-allowlist.txt` | 低 |
| 7 | **`_can_see_all` 口径窄**：worker 只认 `role == "system_admin"`，dev 的 `effective_role` 还会把历史 `'admin'` 映射过来；将来出现 legacy admin 账号会被当普通成员，改动需三处同改 | `worker/src/main.py` | 低（潜伏） |
| 8 | **产品组合数三方不一致**：前端按轴相乘得 **120**，常量是 **160**，测试断言 **48**；后端 4 处断言 `combo_count == 160` | `shared/contracts/niulanwang.ts:99,175`；`test_export_quote_api.py:96,276`、`test_export_quote_formulas.py:324`、`test_export_quote_import.py:82,283` | 中（影响"共 N 种规格"展示；且无法判断是前端轴缺项还是后端数过期） |
| 9 | **前端认证契约残留**（不影响功能，`tsc` exit 0）：`lib/auth/session-cache.ts` 仍有 `tenant` 结构与 `user?.tenant_id` 读取；`lib/api/client.ts:43-46` 仍会注入 `X-Tenant-Id`（值恒为空，实际不发） | 只读扫描 | 低（死代码） |
| 10 | **依赖债**：next `^14.2.0 → 15.x` 专项未做；升级后终态仍有 82 漏洞（3 严重 / 24 高危 / 42 中 / 13 低） | `CLEANUP_LOG.md:108-110` | 中 |
| 11 | **e2e 26 条失败未归真**：依赖本机后端 + 数据库，属"页面没数据"，本轮未复跑 | `CLEANUP_LOG.md:32-34`、`E2E_GUIDE.md:38` | 中 |

### 关于 #8 的取证（**未擅自改**，涉及报价规格空间）

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

1. **租户模型**（对应上面 #1）：`联佳丝网` 的 `tenant_id` 要不要统一到 `default`，
   即收敛为"单租户 + 团队隔离"？—— 改则它在生产可见；不改则它在生产不可见且两套隔离模型并存。
2. **新团队试用工位**：现在新建团队时**所有工位都是未开通**，必须管理员手动开。
   新用户建完团队会看到"什么都用不了"。
3. **Repository 取舍**（对应 #2）：投入接线（SQLAlchemy + asyncpg 两个适配器 + API 层改造），还是删掉这段死代码？
4. **`outreach/webhook` 是否收紧到 POST**（对应 #5）：可能有外部系统在用 `GET`，需确认后再动。

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
