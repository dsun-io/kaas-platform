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
| 6 | **`importers.py` 的表头映射 + 模板列生成** | ❌ **未做** |
| 7 | 前端 `niulanwang.ts` 枚举轴与 `NIULANWANG_COMBO_COUNT` 退役 | ❌ 未做 |

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
