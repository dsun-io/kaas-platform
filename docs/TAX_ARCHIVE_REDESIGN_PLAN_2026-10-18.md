# 税务档案改造清单（2026-10-18）

> **决策人**：用户（2026-10-18 会话）
> **方向**：税务档案不再作为“法定/客户两层”的每单可选控件，而是像产品管理 / 企业抬头一样，
> 有一个**独立的税务管理页**；在税务管理里维护档案，报价时选择档案 →
> **自动把对应税率填入报价表单**；也允许自定义输入；没有档案时默认自定义；
> 有档案时默认用**最新一份**填入。
> **本文只出改造清单，不改代码、不提交。**
> **交接执行计划**：`docs/TAX_ARCHIVE_HANDOVER_EXECUTION_PLAN_2026-10-18.md`
> （共享任务板 `task-1` ~ `task-8`；先过 `TAX-00` 用户拍板）。

---

## 0. 为什么改：现状审计结论

先回答“是不是没啥用”——**当前这版“法定税务档案”作为每单可选的一层，确实基本没用**；
不是“税率数据”没用，而是它没有接到算价上。

| 事实 | 证据 |
|---|---|
| 生产档案只有 `CN-2026-09` 一份（13%/0%/9%、印花 5%、HS 退税率表里两条都是 `null`）；`CN-2027-01` 只是 examples 里的演示，不参与自动解析 | `backend/orchestrator/app/services/export_quote/rate_sets/CN-2026-09.json`、`rates.py` 的 `from_dir()` 只扫顶层 |
| 当前主工作台把进项、销项、出口退税率、杂税、利润率全部显式下发；利润走 `margin_on_price`，印花税在引擎里被置 0 | `frontend/src/app/(app)/quotes/lib/build-request.ts` 的 `policy`；`pricing.py` 的 `margin_mode` 分支 |
| 因此主路径下，档案里的 13%/9%/5% 都不进入价格；它实际只影响两件事：报价日期落在生效期外时 400、结果 `meta.rate_set_code` 显示一个编号 | `export_quote.py` 的 `_assemble_request()`；`engine.py` 的 `rate_set_code` |
| 档案的“自检警告”实际是假绿：HS 表里放了两个 `null` 键，`warnings()` 的 `not rebate_by_hs` 判断被绕过，返回空列表 | `rates.py` 的 `warnings()`；实测 `CN-2026-09` 的 `warnings == []` |
| HS 退税率查询接口与 Provider 链（HTTP → 本地 → 缓存）存在，但前端零调用；用户是在输入框里手填退税率 | `export_quote.py` 的 `/rebate-rate/lookup`；前端无调用 |
| 版本化没有第二个生产版本；报价单（`QuoteOrder`）也没有存 `rate_set_code`，只有客户档案存了。所以“历史报价逐分复现”目前没有落地路径 | `db/workstation_links.py`；`db/models.py` 的 `customer_quote_profiles.rate_set_code` |
| 维护成本是真实的：2026-10-17 线上 `/rate-sets` 500，根因是 Worker 打包不到 `.json`；现在靠 `_manifest.json` + `rate_sets_data.py` 内嵌兜底，改一次税率仍要 sync-shared + 重新部署 | `docs/PROBLEM_STATUS_2026-10-11.md`、`scripts/sync-shared.ps1` |
| **批量报价是例外**：它只下发 input/give/output，后端仍走 fixed 10% + 档案印花 5%。同一个档案在两个页签的效果不同 | `bulk-import-panel.tsx` 的 payload；`export_quote.py` 的 `_assemble_request()` 默认 `profit fixed 0.1` |

**结论**：按用户的新口径，把档案改成“税务管理页 + 报价时自动填表”，它才真正有用；
而且实现会更简单——**档案只负责填表，不参与后端算价**，因此不需要再把文件打进 Worker、
不需要 `RateSet` 注册表、也不需要 HS Provider 链。

### 0.1 顺带发现的两个实现缺陷（客户税率档案层）

这两个不是本次改造的核心，但在动手前应知道：

1. **保存客户税率档案会 422**：新工作台 `onSaveProfile` 会把 `misc_fee_rate` 放进
   `tax_overrides`（`quote-workbench-view.tsx`），但 orchestrator 与 worker 的
   `_ALLOWED_TAX_KEYS` 都没有这一项（`quote_profiles.py` / `worker/quote_api.py`），
   后端按白名单直接 422。计划文档 §3.10 写了“后端白名单加一项”，代码里还没加。
2. **保存档案要求先选法定档案**：`onSaveProfile` 检查的是 `rateSetCode` 状态，
   而不是默认解析出的当前档案；页面默认是“未指定”，所以新开页面直接点“存为档案”
   会提示“请先填写档案名称并选定法定税务档案”。

---

## 1. 目标形态

### 1.1 税务管理（新页面）

- **入口**：`/settings/tax-archives`（建议放“设置”下，和“企业抬头”并列；如果要放侧边栏
  一级入口，只是导航多一行）。
- **权限**：团队管理员可写；团队内成员可读、可在报价时选用；其他团队不可见。
- **列表**：名称、编码、生效日期、进项票税点、销项税率、出口退税率、杂税率、状态、更新时间、操作。
- **表单字段**：
  - 档案名称（必填，团队内唯一，≤ 60 字）
  - 编码（可选，团队内唯一；不填自动生成，如 `TAX-20261018-1`）
  - 生效日期（可选；只用于展示/排序，**不再作为报价日期的硬门禁**）
  - 进项票税点（%）
  - 销项税率（%，出口填 0）
  - 出口退税率（%，留空 = 未核实）
  - 杂税率（%，综合税费系数）
  - 备注 / 来源
- **动作**：新建、编辑、停用/启用（软删）；停用后不再出现在报价下拉，但历史引用仍在。
- **不做**：印花税率/计税基数（旧 fixed/ratio 单兼容字段，不进入新档案）、
  利润率/让利比例（商业决策，不是税率事实）、HS 退税率明细表（后续单独做）。

### 1.2 报价页

- **只保留一个“税务档案”下拉**，去掉“法定税务档案 / 客户税率档案”两层 optgroup，
  去掉常驻的“档案名 + 存为档案”那一行。
- 下拉选项：`自定义（不套用档案）` + 当前团队的有效档案（按生效日期/更新时间倒序）。
- **默认**：有档案 → 自动选中**最新一份**并填入字段；没有档案 → 选中“自定义”，
  字段保持当前默认（进项 10 / 销项 0 / 出口退税空 / 杂税 3）。
- **选择档案** → 自动填入四个税率字段；用户仍可改；改过后显示“本单已修改”，
  并提供“恢复档案值”。档案本身不被修改。
- **选“自定义”** → 清空来源，字段恢复默认值；用户自由输入。
- **请求**：仍然显式下发实际税率值（和现在一样）；额外带
  `tax_archive_code`（可选，仅用于记录来源），**后端不得用档案值覆盖用户值**。
- **结果/报价单**：显示“税额来源：档案名”或“自定义”；报价单落库时存
  `tax_archive_code + tax_snapshot`（当时实际用的四个值），历史可追溯。

### 1.3 批量报价

- 使用同一个税务档案下拉与自动填充（P1 接入）。
- **依赖**：批量报价目前仍走 fixed 利润 + 印花税；要让它和档案字段一致，
  需要先把批量报价对齐到 `margin_on_price + misc_fee_rate`（或至少把档案的
  `misc_fee_rate` 接入）。在未对齐前，建议**先隐藏批量报价里的税务档案选择**，
  避免“选了档案但杂税不生效”的新误导。

### 1.4 与旧设计的关键差异

| 维度 | 旧（现状） | 新（本清单） |
|---|---|---|
| 档案归属 | 文件 + 生效日期；平台维护 | DB 表；团队管理员维护 |
| 报价页交互 | 两层下拉 + 存为档案 | 单下拉；选择后自动填；可自定义 |
| 算价 | 后端 `RateSet` 解析默认值 | 前端填表；后端只收显式值 |
| 历史复现 | 靠“新增档案不改旧文件” | 靠报价单 `tax_snapshot` |
| HS 退税率 | Provider 链 + 空表 | 先不做；只留一个“出口退税率”字段 |
| Worker 打包 | 要带 `rate_sets/*.json` + manifest + 内嵌 `.py` | 不需要；档案在 DB |

---

## 2. 数据模型

### 2.1 新表 `tax_archives`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `tenant_id` | TEXT NOT NULL | 沿用现有 `tenant_id` 约定 |
| `team_id` | BIGINT NULL | **团队隔离边界**；NULL 预留给“全租户共享”档案 |
| `code` | TEXT NULL | 团队内唯一；不填自动生成 |
| `name` | TEXT NOT NULL | 团队内唯一 |
| `effective_from` | DATE NULL | 展示/排序用，不做日期门禁 |
| `effective_to` | DATE NULL | 预留 |
| `tax_values` | JSONB NOT NULL DEFAULT '{}' | 白名单：`input_vat_rate`、`output_vat_rate`、`rebate_rate`、`misc_fee_rate` |
| `source` | TEXT NULL | 备注/来源 |
| `status` | TEXT NOT NULL DEFAULT 'active' | active / inactive（软删） |
| `created_by` | TEXT NULL | |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

索引：`(team_id, status, effective_from DESC, updated_at DESC)`；唯一约束
`(team_id, name)` 与 `(team_id, code)`（`code` 为空不参与唯一）。

**为什么用 JSONB**：和 `customer_quote_profiles.tax_overrides` 同一模式；
加税种不用每次迁移；键名由 API 白名单校验，避免 `input_vat_rates` 这类错键静默入库。

### 2.2 `quote_orders` 新增列（P3）

| 列 | 类型 | 说明 |
|---|---|---|
| `tax_archive_id` | BIGINT NULL | 选用的档案 |
| `tax_archive_code` | TEXT NULL | 冗余，便于展示/排查 |
| `tax_archive_name` | TEXT NULL | 开单时的档案名快照 |
| `tax_snapshot` | JSONB NULL | 当时实际使用的税率值（含“自定义”标记） |

> 记录在报价单头（整单共享一份税率），不写到行项；行项已有 `cost_breakdown`。

### 2.3 种子数据

- 把当前 `CN-2026-09` 迁移成**每个现有团队一份**默认档案：
  - 名称：`默认税率档案（2026-09）`
  - 进项 10%、销项 0%、出口退税空、杂税 3%
  - `effective_from = 2026-09-01`
- 新团队：建议在首次进入税务管理时自动建一份默认档案；或保持空（自定义）。
- 不迁移 `customer_quote_profiles`：它是“客户 + 产品”粒度，和团队级档案不是同一语义；
  保留数据，P4 再决定是否删除（见 §8）。

---

## 3. API 清单

新增 `app/api/tax_archives.py`（orchestrator）与 worker 同名路由，前缀 `/api/v1`：

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/tax-archives` | 登录 | 当前团队可用档案；管理员可 `?include_inactive=true` |
| POST | `/tax-archives` | 团队管理员 | 新建 |
| PATCH | `/tax-archives/{id}` | 团队管理员 | 编辑 |
| DELETE | `/tax-archives/{id}` | 团队管理员 | 停用（软删） |
| POST | `/tax-archives/{id}/restore` | 团队管理员 | 启用（可选） |

**校验**：

- `name` 必填、≤ 60、团队内唯一；
- `code` 可空；有值时团队内唯一；只允许字母/数字/`-`/`_`；
- 每个税率项 0–1（按百分数填 10 表示 10%，入库前 /100；接口可以直接收 0–1）；
- 至少一个税率项非空（空档案套用后什么都不变，和现有客户档案口径一致）；
- 白名单之外键名一律 422，不静默丢弃；
- `tenant_id/team_id` 永远从 `AuthContext` 取，不信任 body。

**报价请求**：

- 新增可选 `tax_archive_code`（仅记录来源）；后端可以校验它属于当前团队，
  但**不**用它的值覆盖 `policy`。
- 旧 `rate_set_code` 保留一个过渡期，P4 再移除。

**契约/同步**：

- `shared/contracts/export-quote.ts` 增加 `TaxArchive` / `TaxArchiveList` /
  `TaxArchiveTax` schema；
- 重生成 `backend/orchestrator/docs/openapi.json`（按 AGENTS.md：先提交产物，再跑 `contracts:check`）；
- `route-parity`、`sync-shared -Check` 同步更新。

---

## 4. 前端清单

### 4.1 新页面

- 路由：`frontend/src/app/(app)/settings/tax-archives/page.tsx`
- 组件：`tax-archive-list.tsx`、`tax-archive-form.tsx`、`tax-archive-picker.tsx`
- Hooks：`use-tax-archives.ts`（list/create/update/disable）
- 侧边栏/设置入口：`税务管理`
- 权限：非团队管理员隐藏写操作；只读用户可看列表。

### 4.2 报价工作台（`QuoteWorkbenchView`）

- 删除 `WorkbenchParamsCard` 里的两层下拉 + `profileName` 输入 + 存为档案/移除；
- 换成 `TaxArchivePicker`：
  - 默认选中最新档案；
  - `onSelect` 填 `inputVatRatePct / outputVatRatePct / rebateRatePct / miscTaxPct`；
  - 记录 `taxArchiveCode`；
  - 用户改字段 → `taxDirty = true`，显示“本单已修改”+“恢复档案值”；
  - 选“自定义” → 清来源、回默认值。
- 删除 `useQuoteProfiles` / `useSaveQuoteProfile` / `useDeleteQuoteProfile` 在报价页的调用
  （hook 文件先保留，P4 清理）。
- 请求：`buildLineRequest` 增加 `tax_archive_code`；policy 仍显式下发。
- 结果区/报价单：显示来源与快照。

### 4.3 批量报价

- P1 接入同一个 picker；如果批量报价还没对齐 margin/misc，先隐藏档案选择。

### 4.4 测试

- 组件测试：默认选最新、选择后填值、自定义、已修改标记、无档案时自定义；
- 页面测试：税务管理 CRUD、权限、停用后不出现在下拉；
- e2e：税务管理建档案 → 报价页自动带入 → 改值 → 保存报价单 → 快照可查。

---

## 5. 迁移与清理顺序

| 阶段 | 动作 | 是否破坏性 |
|---|---|---|
| P0 | 建 `tax_archives` 表 + 种子 + 契约 | 否 |
| P1 | CRUD API（orchestrator + worker）+ 权限 + 测试 | 否 |
| P2 | 税务管理页 + 侧边栏入口 | 否 |
| P3 | 报价页自动填 + 报价单快照（迁移加列） | 否（只加列） |
| P4 | 下线旧链路：`/rate-sets`、`rates.py`、`rate_sets*`、HS Provider、sync 的 manifest/内嵌生成；报价页移除客户档案 UI | 是（删代码/API；表数据暂不动） |
| P5 | 可选：HS 退税率明细、版本历史、多国/多税制 | 否 |

**P4 前置条件**：

- 所有报价入口（工作台、批量、单证/其他调用）都不再依赖 `rate_set_code` 的默认值；
- 批量报价已对齐到 margin/misc，或已明确停用档案选择；
- 旧客户端/旧前端不再调用 `/rate-sets`（保留一个发布周期的 deprecated 路由更稳）。

**不做**：

- 不自动把客户档案迁移成税务档案（粒度不同，会污染团队档案列表）；
- 不在 P4 直接 drop `customer_quote_profiles`（先停写、保留数据，单独审批）。

---

## 6. 分阶段可执行清单

### P0 — 设计确认 + 数据层（0.5–1 天）

- [ ] 确认 §8 的 6 个待拍板项（scope、客户档案去留、字段、版本、HS、批量）
- [ ] 新增迁移（按仓库下一个可用编号）：建 `tax_archives` 表 + 索引 + 唯一约束
- [ ] 种子：现有团队各一份默认档案
- [ ] `shared/contracts/export-quote.ts` 增加 schema
- [ ] 重生成 openapi 产物（提交后跑 `contracts:check`）

### P1 — 后端 CRUD（1 天）

- [ ] `app/api/tax_archives.py`：5 个端点
- [ ] 白名单/范围/唯一性/权限校验
- [ ] worker 同名路由（DB 直连，与现有 quote-profiles 同模式）
- [ ] 单测：CRUD、跨团队隔离、非管理员 403、白名单 422、停用
- [ ] `route-parity` 更新

### P2 — 税务管理页（1–1.5 天）

- [ ] `/settings/tax-archives` 页面与侧边栏入口
- [ ] 列表/表单/停用/启用/权限
- [ ] 组件测试 + 页面测试

### P3 — 报价页接入（1–1.5 天）

- [ ] `TaxArchivePicker` + 工作台状态/自动填/已修改
- [ ] 报价请求 `tax_archive_code`；结果来源展示
- [ ] 报价单加 `tax_archive_*` + `tax_snapshot`（新增迁移，按下一个可用编号）
- [ ] 批量报价接入（或先隐藏）
- [ ] 移除两层下拉/存为档案 UI
- [ ] e2e：建档案 → 自动填 → 保存 → 快照

### P4 — 下线旧链路（1 天，需单独确认）

- [ ] `/rate-sets`、`/rate-sets/reload`、`/rebate-rate/lookup` 标记 deprecated / 删除
- [ ] 删除 `rates.py`、`rate_sets/`、`rate_sets_data.py`、`_manifest.json`、sync 特殊逻辑
- [ ] 引擎/API 不再要求 `rate_set`；保留 `rate_set_code` 字段一个发布周期
- [ ] 停写 `customer_quote_profiles`；报价页移除客户档案
- [ ] 更新 `WORKSTATION_DESIGN.md`、`CURRENT_IMPLEMENTATION_MAP.md`、`PROBLEM_STATUS`
- [ ] 全量门禁

### P5 — 可选能力（按需）

- [ ] HS 退税率明细表 + 查询（有数据源/维护流程再上）
- [ ] 档案版本历史/对比（如果确实需要）
- [ ] 多国/多税制

---

## 7. 验收标准

1. **税务管理**：团队管理员可新建/编辑/停用；其他团队成员只读；跨团队看不到。
2. **报价页**：有档案时默认选中最新并自动填入四个税率；可改；改后显示“本单已修改”；
   无档案时默认“自定义”；选择档案后报价结果随税率变化。
3. **单一事实源**：后端算价只用请求里的显式税率；档案不得在后台二次覆盖。
4. **历史**：报价单保存 `tax_archive_code + tax_snapshot`；打开旧单能看到当时来源与数值。
5. **兼容**：旧报价单/旧请求（带 `rate_set_code`）不报错；旧数据不丢。
6. **门禁**：orchestrator `pytest -m unit`、worker `pytest`、前端 `typecheck/lint/test`、
   `contracts:check`、`route-parity`、`sync-shared -Check`、`NEXT_EXPORT=1 pnpm build` 全绿。
7. **无死链**：报价页不再出现“法定/客户两层”控件；未使用的 HS 查询/文件同步链路在 P4 清除。

---

## 8. TAX-00 已拍板（2026-10-18）

| # | 问题 | 用户决定 | 落地口径 |
|---|---|---|---|
| 1 | 档案范围 | **团队级** | `tenant_id + team_id`；团队管理员写、成员读；跨团队不可见。 |
| 2 | 旧客户税率档案 | **迁移到新档案** | 按“团队 + 税率组合”去重迁移；同税率组合合并，不同组合各成一份。旧表停写、保留数据，不删表。 |
| 3 | 档案字段 | **除利润率外的税项** | 进项票税点 / 销项税率 / 出口退税率 / 杂税（综合税费系数，**印花税已含在杂税里**）；不含利润率、让利比例，不单列印花税。 |
| 4 | 版本/生效日期 | **只展示和排序** | 默认选最新一份；不做报价日期门禁；历史靠报价单快照。 |
| 5 | HS 退税率查询 | **下线** | HS 编码改为人工查询；档案只保留“出口退税率”字段。 |
| 6 | 批量报价 | **本轮不动，另做优化 plan** | 现有批量页保持现状；未来重设计为“同时选多个客户的多个询盘一起报价”，见 `docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md`。 |

> 上述 1/2/3 已由用户拍板，TAX-01 可以开始。TAX-06（删旧链路）仍需单独确认。

---

## 9. 风险与边界

- **最大的反模式**：前端自动填了值、后端又按档案解析一次，形成两个事实源。
  本清单明确：后端只收显式 `policy`，档案不参与算价。
- **旧链路兼容**：P4 前保留 `rate_set_code` 与 `/rate-sets`，避免旧前端/旧单证调用断裂。
- **Worker 与 orchestrator 双端**：新 CRUD 两端都要有；`route-parity` 必须绿。
- **并发工作区**：当前仓库有其他人未提交的改动；本文只出清单，不动任何既有文件。
- **数据迁移**：P0/P3 只加表/加列；P4 的删除动作单独确认，不混在功能提交里。
