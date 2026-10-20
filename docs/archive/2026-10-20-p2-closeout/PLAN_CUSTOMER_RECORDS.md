# 执行计划：业务客户的往来记录（报价 / 订单 / 单证 包含关系）

> ⚠️ **本计划的多项待办已完成**（dev 侧 `/records`、前端 A/B/D、`/documents` 收口等），
> 且其中「前端 vitest 1 个既有失败（niulanwang）」的真实原因是**产品组合数三方不一致**，
> 不是测试写法问题。当前状态以
> [PROBLEM_STATUS_2026-10-11.md](./PROBLEM_STATUS_2026-10-11.md) 为准。

> 2026-10-11 制定。设计依据：[CUSTOMER_DOCUMENTS_VIEW.md](CUSTOMER_DOCUMENTS_VIEW.md)
> 原则：**包含关系是业务逻辑的必然结果**，不是查询层的拼装。因此先固化数据模型与写入侧，再做读侧与前端。

## 目标（可验收）

> 系统支持在**业务客户粒度**下，按包含关系查询该客户的全部历史报价、订单、单证；
> 新数据从产生的那一刻起就天然带着这层包含关系。

```
业务客户
  └── 报价（唯一新建入口，必选客户）
        ├── 报价单（生成报价时自动产出，1:1）
        └── 订单（只能由报价转订单产生，客户/明细/条款继承）
              └── 单证（PI / CI / PL / BL）
```

## 阶段划分（每阶段独立可验收，有明确写入范围）

### P0 · 数据基线收口（阻塞项）
- **依赖**：`009`（子代理在做，三张单据表 `customer_id` → BIGINT + FK + 回填 + 清洗）
- **动作**：应用 `009` → 应用 `010` → 逐表核对
- **写入范围**：无代码改动（只跑迁移）
- **验收（硬数字）**：迁移前后行数**逐表相等**：`quote_orders` 3 / `orders` 0 / `trade_docs` 3；
  外键齐备（三表 → `customers`、`orders.quote_id` → `quote_orders`、`trade_docs.quote_id` → `quote_orders`）；
  `alembic current` = head
- **风险**：两个进程并发迁移 → **必须等子代理结束**再动

### P1 · 模型层：归属成为约束（**不**把导入挡在门外）
- **动作**：**单据必须归属业务客户**；单证归属二选一
- **做法**（Postgres 允许约束只对新数据生效）：
  ```sql
  -- 必须挂客户（手动新建 / 导入也必须选客户）
  ALTER TABLE orders     ADD CONSTRAINT ck_orders_has_customer CHECK (customer_id IS NOT NULL) NOT VALID;
  ALTER TABLE trade_docs ADD CONSTRAINT ck_docs_has_customer  CHECK (customer_id IS NOT NULL) NOT VALID;
  -- 归属二选一：同一张单证不能同时挂报价和订单
  ALTER TABLE trade_docs ADD CONSTRAINT ck_doc_single_parent
        CHECK (quote_id IS NULL OR order_id IS NULL) NOT VALID;
  ```
  `NOT VALID` = 历史行豁免、**新行必须满足**
- **刻意不强制**「订单必须有报价」「单证必须有报价或订单」：业务要支持**手动新建与导入已有数据**
  （历史订单可能没走过报价、历史单证可能只记了客户）。包含关系由正常业务流程产生，
  不靠约束把导入挡在门外
- **写入范围**：`alembic/versions/202610110010_*.py`
- **验收**：插入缺父对象的单证/订单被数据库拒绝；历史行不受影响

### P2 · 写入侧：业务动作产生关系
- **动作**
  1. **生成报价 → 同一事务自动产出报价单**（`trade_docs(doc_type='quotation', quote_id=报价)`）
  2. **报价 → 转订单**：`POST /quotes/{id}/orders`（或既有转单路径）写 `orders.quote_id`，并继承客户/条款/明细
  3. **订单 → 生成单证**：`trade_docs.order_id` 落库
  4. **手动新建与导入**（业务要求）：允许直接建订单/单证，**必须选业务客户**；
     报价/订单父对象**可选**（有则挂上、无则直接归客户）；提供批量导入入口 
  5. **报价必填客户**：`customer_id` 校验存在、未删、属本团队（跨团队 404 `CUSTOMER_NOT_FOUND`）
- **写入范围**：`app/api/quotes.py`、`quote_orders.py`、`orders.py`、`trade_docs.py`（dev）+
  `worker/src/quote_api.py`、`worker/src/ws_docs_ext.py`、`worker/src/main.py`（worker）
- **验收**：走完"建报价 → 转订单 → 出 PI/CI"后，对应行上的 `quote_id`/`order_id`/`customer_id` 全部正确且一致

### P3 · 读侧：树形聚合接口
- **动作**：`GET /api/v1/customers/{customer_id}/records`
- **形状**：`{customer, counts, quotes:[{..., documents:[], orders:[{..., documents:[]}]}]}`
  - 不按状态过滤（草稿/已发出/已接受/已确认/作废全返回）
  - 报价分页（默认 20），其下订单与单证整体返回（避免 N+1）
  - 客户可见性校验失败 → 404
  - **`direct` 分组（直接挂客户）**：手动新建/导入的订单与单证（无报价父对象），
    **固定返回**（只要存在就不省略）—— 这是正规导入路径，不是脏数据 
- **写入范围**：dev `app/api/customers.py`；worker `main.py`
- **验收**：构造"客户 → 2 报价（1 个已转 2 单证）"数据后，接口返回的树结构与计数正确

### P4 · 前端
- **动作**
  1. **报价**新建时从业务客户列表选择（唯一的客户选择点）
  2. **转订单**按钮（从报价发起），不再提供"凭空新建订单"入口
  3. **生成单证**从报价/订单发起；单证类型含 `quotation`
  4. 客户详情「往来记录」树：报价 → 报价单 chip + 订单 → 单证 chips（同一套 chip，不按模块分家）
- **写入范围**：`frontend/src/app/(app)/customers/**`、`quotes/**`、`orders/**`、`trade-docs/**`、
  `frontend/src/lib/schemas/**`
- **验收**：`npx tsc --noEmit` 通过；手工走一遍"建客户 → 建报价 → 转订单 → 出单证 → 客户页看到整棵树"

### P5 · 验证与文档
- **动作**：两端全量测试、路由对等、共享内核一致性、真实库行数与迁移核对、文档更新
- **验收（必须全部绿）**
  | 项 | 门槛 |
  |---|---|
  | worker 测试 | ≥ 111 passed（新增用例后更高） |
  | dev 单元测试 | ≥ 429 passed |
  | 路由对等 | PASS（0 未登记 / 0 过期） |
  | `sync-shared.ps1 -Check` | 一致 |
  | 前端 `tsc --noEmit` | exit 0 |
  | 数据完整性 | 迁移前后逐表行数相等；新数据无孤儿 |

## 并行与冲突控制

| 资源 | 归属 | 说明 |
|---|---|---|
| 迁移 `009` | 子代理（进行中） | **P0 必须等它结束** |
| 迁移 `010` + 后端写入/读侧 | Lead（我） | 与 `009` 不同文件，可先写、后应用 |
| 前端 | Lead 或另一个子代理 | 只碰 `frontend/**`，与后端无写冲突 |
| `docs/**` | Lead | 子代理禁止改 |

## 当前状态

- [x] 设计（含包含关系即业务约束）
- [x] 迁移：`010`（两列 + FK + 索引 + 报价单回填）+ `011`（纠正会挡手动新建/导入的过严约束）
- [x] **P0 数据基线收口**：`009`~`011` 已应用；行数 `3 / 0 / 3` **一条不丢**；类型与外键齐备
- [x] **P1 约束收紧**：`ck_orders_has_customer` / `ck_docs_has_customer` / `ck_doc_single_parent`，已端到端证明
- [ ] **P2 写入侧**：worker 执行中；dev 待子代理 A 让出 `quotes.py`/`orders.py`/`trade_docs.py`
- [~] **P3 读侧树接口**：worker ✅（116 passed）；dev 待收口（实现 `/records` + 删除 `/documents`）
- [~] **P4 前端**：选择器 / 往来记录树 / 导入骨架 / 单证 chip 已交付；A（工位可见性）·B（团队）·D（quotation）执行中
- [~] **P5 验证与文档**：对等 PASS、`tsc` exit 0、`lint` 0 error；文档随进度更新中

> ⚠️ **状态快照更正（2026-10-19）**：本文档 checklist 停在 2026-10-11 执行中口径；worker 读侧
> `/api/v1/customers/{id}/records` 已上线（`ws_customer_records.py`，装配在共享内核
> `kaas_common/workstation/customer_records.py`）⇒ 主体已收口，剩余细节以代码为准。

---

## 执行记录（实测，2026-10-11）

### P0 数据基线 —— ✅ 完成
- 迁移链：`008 → 009 → 010 → 011 (head)`，**全部已应用**
- **行数逐表核对**（迁移前基线 `3 / 0 / 3`）：`quote_orders` 3 / `orders` 0 / `trade_docs` 3 → **一条数据都没丢**
- `customer_id` 三表均已是 **bigint**；外键齐备（三表 → `customers`，`orders.quote_id` / `trade_docs.quote_id` → `quote_orders`）
- 历史脏数据 `'3'`（客户已删）/ `'lianjia-demo'`（演示串）已按确认**置 NULL**，行保留

### P1 约束 —— ✅ 完成（含一次纠错）
- ⚠️ **踩过的坑**：`010` 的**初版**约束（`orders.quote_id NOT NULL`、`trade_docs` 必须有父对象）
  在子代理执行 `upgrade head` 时已经落到库里 —— 它会**直接拒绝**「手动新建订单」「导入只有客户的单证」，
  与业务要求正面冲突。**已由迁移 `011` 纠正**（幂等：先 `DROP CONSTRAINT IF EXISTS` 再 ADD）
- 最终生效（全部 `NOT VALID`：历史行豁免、新行必须满足）：
  `ck_orders_has_customer`、`ck_docs_has_customer`、`ck_doc_single_parent`
- **端到端证明**（事务内执行后回滚）：
  - 无报价的订单 → ✅ 接受（旧约束会拒绝）
  - 只有客户的单证 → ✅ 接受（旧约束会拒绝）
  - 无客户的订单 → ✅ 拒绝（这条该拦）
  - 回滚后 `orders` 仍 **0 行**（无测试残留）

### P3 读侧 —— 🔄 生产端完成，dev 待收口
- ✅ **worker（生产）**：`GET /api/v1/customers/{id}/records`
  - `ws_customer_records.py`，装配逻辑抽成纯函数 `build_records`（5 条单测）
  - worker 测试 **116 passed**；新 SQL 真实库 `PREPARE` **3/3 通过**
  - `direct` 分组承载**手动新建 / 导入**的订单与单证；父对象已被删的脏单证也落 `direct`（**不消失**，用户要能查到历史）
  - 计数包含 `direct`，避免客户页标题栏少算
- ⏳ **dev**：`/records` 尚未实现 —— 等子代理 A 让出 `app/api/customers.py`；
  A 落地的 `/documents`（三个平行列表、旧形状）已登记为「**待收口·删除**」
- 路由对等：**PASS**（0 未登记 / 0 过期 —— 那条登记是有意的临时状态，收口时摘掉）

### P2 写入侧 / P4 前端 —— 🔄 并行执行中（写入范围互不重叠）
- worker P2：报价自动出报价单、报价转订单写 `quote_id`、生成单证写 `order_id`、手动新建与导入走同一套客户校验
- 前端 A（工位可见性，P0）+ B（团队生命周期）+ D（`quotation` 类型）
- ✅ 前端已交付部分：客户选择器（报价必选）、往来记录树（含 `direct` 固定渲染）、导入骨架、单证 chip 统一
  —— `tsc` exit 0、`next lint` 0 error、vitest 228 passed（1 个失败为**既有** `niulanwang` 用例）

### 契约补充 —— ✅ 完成
- `shared/contracts/quote-order.ts` 的 `QuoteOrderPatch` 补上 `customer_id`（"建单后改客户"原先做不到）
- 验证：dev `-m unit` **429 passed**、前端契约测试 `contracts-quote.test.ts` **32 passed**（无 spec 哈希问题）

### 待办（收口顺序）
1. A 交付后：dev 实现 `/records` 树 → 删除 `/documents` → 摘掉 allowlist 那条 → 对等必须 **0 未登记 / 0 过期**
2. worker P2 / 前端 A·B·D 交付后：两端全量测试 + `tsc` + `lint` + `PREPARE` + 数据完整性
3. 文档收尾（本文件 + `docs/CUSTOMER_DOCUMENTS_VIEW.md` + `docs/FRONTEND_PRODUCTION_READINESS.md`）
