# 税务档案改造 · 交接执行计划（2026-10-18）

> **2026-10-18 口径修正（用户确认，覆盖 TAX-00 原四项设计）**：
> 销项增值税、杂税是**企业级**，继续放在 `tax_archives`；
> 进项增值税、出口退税率跟着**产品/HS**走，新增 `product_tax_rates` 表，
> 在税务管理页按产品逐条维护（同一团队同一产品一条，已配置的产品不能重复选）。
> 迁移 `202610180009` 建产品税率表；旧税档里的进项/退税字段与旧表删除
> 延后到发布后迁移 `202610180010`（见 `docs/DEPLOYMENT_PLAN_2026-10-18.md`）。
> 报价时企业税档只带销项/杂税，进项/退税从产品税率带出，快照写入
> `tax_snapshot.product_taxes`。

> **上游方案**：`docs/TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md`
> **当前状态（2026-10-18 晚）**：TAX-00 已拍板；**TAX-01 ~ TAX-06 已实现并提交**；
> TAX-07 全量门禁/文档收口进行中。
> **本文用途**：把这套改造交给下一个执行方（agent / 队友 / 新会话）时，
> 任务怎么拆、谁先谁后、各自写哪些文件、怎么验收、怎么提交、怎么回滚。

---

## 0.0 实施进度（2026-10-18 晚）

- ✅ TAX-01：`tax_archives` 模型 + 迁移 `202610180006`（建表、每团队种子、旧客户档案按税率组合去重迁移）+ 共享契约；
- ✅ TAX-02：orchestrator `GET/POST/PATCH/DELETE /api/v1/tax-archives`；
  团队级范围、团队管理员写、成员读、白名单、0–1 税率校验、软删；
- ✅ TAX-03：Worker `tax_archives.py` 对等 4 端点；`route-parity` PASS；
- ✅ TAX-04：前端 `/settings/tax-archives` 税务管理页 + 侧边栏入口；
- ✅ TAX-05：迁移 `202610180007` 给 `quote_orders` 加档案快照列；报价创建/修改写
  `tax_archive_id/code/name/tax_snapshot`；报价页改为单下拉，选中自动填四税率、默认最新、
  可自定义/恢复档案值；
- ✅ TAX-06：旧文件版税务档案链路已下线：
  `/rate-sets`、`/rate-sets/reload`、`/rebate-rate/lookup` 路由删除；
  `rates.py`、`rate_sets/`、`rate_sets_data.py` 删除；`sync-shared.ps1` 不再生成
  rate_sets 清单；前端批量页去掉档案下拉，旧单产品报价视图（死代码）删除；
  `customer_quote_profiles` 旧 API/模型已删除；表删除延后到发布后迁移
  `202610180010`（用户确认未投入真实业务使用）。
- ✅ TAX-07：本轮已完成：orchestrator unit、worker pytest、frontend
  typecheck/lint/test、`contracts:check`、`route-parity`、`sync-shared -Check`、
  `NEXT_EXPORT=1 NEXT_DIST_DIR=.next-verify pnpm build` 全部通过；
  真实 UI 已验证税务管理页与报价页档案自动带出。剩余：批量报价 plan 评审
  （见 `docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md` 的 3 个待确认项）。

> 本地 DB 已升级到 `202610180007`。

---

## 0. 一句话交接

把“税务档案”从**文件版 RateSet + 每单两层下拉**，改成
**DB 档案库 + 独立税务管理页 + 报价时选择后自动填表**；
后端算价仍只认请求里的显式税率（档案不参与算价），历史靠报价单 `tax_snapshot`。
执行顺序：**先加法（表/API/页面），再接线（报价页），最后减法（P4 删旧链路）**。

---

## 1. 交接基线

### 1.1 已完成

- 只读审计：当前“法定税务档案”在主工作台不影响价格；HS 查询无前端调用；版本化未使用；
  客户档案保存有 2 个实现缺陷（详见方案 §0）。
- 改造清单：`docs/TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md`。
- 共享任务板：`task-1` ~ `task-8`（见 §3）。**全部未开始，除 `TAX-00` 由 Lead 持有等待用户拍板。**

### 1.2 未完成

- 所有代码、迁移、API、页面、报价页接线、旧链路清理、测试与提交。
- 生产库迁移 / 部署：不在本计划内；按用户此前口径“部署延后”。

### 1.3 不要碰

- 当前主工作区有**其他人未提交的改动**（`git status` 可见）。执行方不要在主工作区直接改；
  先从 `HEAD` 建独立 worktree（见 §2.2），只在自己的 worktree 里动。
- 不要在 P4 之前删除 `rate_set_code`、`/rate-sets`、`rates.py`、`rate_sets/`；
  旧前端/旧单证仍可能调用。
- `customer_quote_profiles` 已按用户确认删除（表 + API + 模型，迁移 008）；
  不再有旧客户税率档案链路。
- 不要改生产库、不要触发部署。

### 1.4 先读什么

1. `AGENTS.md`（项目规则：门禁、并发提交、contracts 顺序、PowerShell/Node 路径）。
2. `docs/TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md`（方案与 §8 待拍板项）。
3. 本文（执行顺序与门禁）。
4. 任务卡（`team_task_list` / `team_task_get`）：每个任务的交付、写入范围、验收。

> ⚠️ 两份文档目前是**未提交的 untracked 文件**。从 `HEAD` 建 worktree 后，
> 需要先把 `docs/TAX_ARCHIVE_REDESIGN_PLAN_2026-10-18.md` 和本文复制到 worktree，
> 或先获得用户批准单独提交这两份文档。

---

## 2. 启动条件（硬门禁）

### 2.1 用户拍板（TAX-00，2026-10-18 已完成）

方案 §8 的 6 项已由用户确认，**可以进入 TAX-01**：

1. 档案范围：**团队级**（`tenant_id + team_id`）；
2. 现有客户税率档案：**迁移到新档案**（按“团队 + 税率组合”去重，旧表停写保留）；
3. 档案字段：进项票税点 / 销项税率 / 出口退税率 / 杂税（综合税费系数，**印花税已含在杂税里**）；**不含利润率/让利**，不单列印花税；
4. 版本/生效日期：只展示和排序，默认最新，不做日期门禁；
5. HS 退税率查询：下线，HS 编码人工查询；
6. 批量报价：本轮不动现有页面；另出优化 plan（`docs/BATCH_QUOTE_REDESIGN_PLAN_2026-10-18.md`），未来做多客户多询盘批量报价。

> TAX-06（删旧链路）仍需用户单独确认，不在 TAX-00 授权内。

### 2.2 隔离工作区

- 从 `HEAD`（当前 `ee855aa`）建独立 worktree/branch，例如 `feat/tax-archives`；
  不要把主工作区的并发改动带进来。
- 把两份 tax archive 文档复制进 worktree（见 §1.4）。
- 记录起点：`git rev-parse HEAD`、`git status --short`（应为空）。

### 2.3 基线门禁

在改代码前先跑一遍基线（确认是“绿”的起点，避免把别人的红算到自己头上）：

- orchestrator：`pytest -m unit`
- worker：`pytest`
- frontend：`typecheck` / `lint` / `test`
- `contracts:check`
- `python scripts/route-parity.py`
- `powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check`
- `NEXT_EXPORT=1 pnpm build`

基线有红 → 先定位是不是 `HEAD` 自身的问题；不要带红开工。

### 2.4 不做什么

- 不跑生产迁移、不部署、不推送（除非用户放行）。
- 不在 P4 前删旧链路；P4 需要用户单独确认。

---

## 3. 任务板总览

> 以 `team_task_list` 的实时状态为准；下面是拆解与依赖。任务 id 是共享任务板 id。

| 任务板 id | 标签 | 依赖 | 建议 owner | 预计 | 写入范围（摘要） |
|---|---|---|---|---|---|
| `task-1` | TAX-00 用户确认 6 个拍板项 | — | Lead（已持有） | 用户决定 | 仅方案文档 §8 |
| `task-2` | TAX-01 数据层 + 种子 + 契约 | task-1 | 后端 | 0.5–1d | `app/db/tax_models.py`、alembic、contracts、openapi |
| `task-3` | TAX-02 orchestrator CRUD | task-2 | 后端 | 1d | `app/api/tax_archives.py`、`main.py`、测试 |
| `task-4` | TAX-03 Worker 对等路由 | task-3 | 后端 | 0.5–1d | `backend/worker/src/tax_archives.py`、`main.py`、route-parity |
| `task-5` | TAX-04 税务管理页 | task-3 | 前端 | 1–1.5d | `frontend/src/app/(app)/settings/tax-archives/`、sidebar |
| `task-6` | TAX-05 报价页接入 + 快照 | task-4 | 全栈 | 1–1.5d | `quotes/`、`quotations/v2-quote/`、quote_orders、迁移 |
| `task-7` | TAX-06 下线旧链路（P4） | task-6 | 全栈 | 1d | `rates.py`、`rate_sets/`、export_quote、sync-shared、docs |
| `task-8` | TAX-07 全量门禁 + 文档收口 | task-5, task-7 | Lead/QA | 0.5–1d | `docs/` |

### 3.1 依赖图

```
TAX-00 (task-1)
  └─ TAX-01 (task-2)
       └─ TAX-02 (task-3)
            ├─ TAX-03 (task-4) ── TAX-05 (task-6) ── TAX-06 (task-7)
            └─ TAX-04 (task-5) ─────────────────────────────┐
                                                           └─ TAX-07 (task-8)
```

- `TAX-03` 与 `TAX-04` 可在 `TAX-02` 之后**并行**（写文件不重叠）。
- `TAX-05` 只依赖 `TAX-03`（API 两端可用）；`TAX-04` 不阻塞它，但 `TAX-07` 等两者都完成。
- `TAX-06` 是破坏性阶段，必须 `TAX-05` 验收后 + 用户单独确认。

### 3.2 任务领取规则

1. `team_task_get` 看最新 revision；
2. `team_task_update` action=`claim`（带 revision）；
3. 按任务卡交付；只改任务卡写明的写入范围；
4. 完成时 `action=complete`（带最新 revision）；
5. 发现写入范围与他人重叠 → 先停下来协调，不要硬改；
6. Lead 负责最终 diff 审查。

---

## 4. 各任务执行要点

### TAX-01 数据层（task-2）

- 表 `tax_archives`：列与约束见方案 §2.1；`tax_values` JSONB 白名单
  `input_vat_rate / output_vat_rate / rebate_rate / misc_fee_rate`。
- 模型建议放 `app/db/tax_models.py`（新文件），避免改 `models.py` 大文件；
  在 `base.py` 注册，确保 alembic autogenerate/迁移可见。
- 迁移只加表/索引/唯一约束；种子 = 现有团队各一份
  “默认税率档案（2026-09）”（进项 10%、销项 0%、出口退税空、杂税 3%）。
- 契约 `TaxArchive` / `TaxArchiveList` / `TaxArchiveTax`；
  **税率用 0–1**，前端百分比在提交前 /100。
- 重生成 `docs/openapi.json`。按 AGENTS.md：**重生成 → 提交产物 → 再跑 contracts:check**。
- 验收：迁移 up/down；种子存在；contracts 测试；openapi diff 只含预期字段。

### TAX-02 orchestrator CRUD（task-3）

- `GET /api/v1/tax-archives`（active；管理员 `include_inactive=true`）、POST、PATCH、DELETE（软删）、
  可选 restore。
- 范围：`tenant_id` + `team_id` 从 `AuthContext` 取；写操作 `require_team_admin`；
  跨团队不可见/不可改。
- 校验：name 必填≤60 且团队内唯一；code 可空/唯一/字符白名单；税率 0–1；
  至少一项非空；白名单外键 422；唯一冲突 409。
- **不要**在 CRUD 里读/写 `export_quote` 算价；不要改 `customer_quote_profiles`。
- 单测：CRUD、跨团队、403、422、409、软删/恢复。

### TAX-03 Worker 对等（task-4）

- 按 worker 现有模式（DB 直连/Neon）实现同 5 个端点；状态码/字段/错误文案与 orchestrator 一致。
- 注册到 `backend/worker/src/main.py`；补 worker 测试；更新 `scripts/route-parity.py`。
- 验收：worker `pytest` 全绿；`route-parity` PASS；`sync-shared -Check` PASS。

### TAX-04 税务管理页（task-5）

- 路由 `/settings/tax-archives`；侧边栏/设置入口“税务管理”。
- 列表 + 表单 + 停用/启用；权限：团队管理员写、成员只读。
- 百分比展示 0–100，提交 /100；错误按后端 422 文案展示，不吞。
- **不碰报价页文件**（TAX-05 负责），避免并行冲突。
- 组件测试 + 页面测试；无 console error。

### TAX-05 报价页接入（task-6）

- 新建 `TaxArchivePicker`（建议 `frontend/src/app/(app)/quotes/components/tax-archive-picker.tsx`）：
  选项“自定义 + active 档案（按 effective_from/updated_at 倒序）”；默认最新；
  选择后填四个税率；用户改 → “本单已修改”+“恢复档案值”；无档案 → 自定义。
- `QuoteWorkbenchView` / `WorkbenchParamsCard`：删两层 optgroup、profileName、
  存为档案/移除；删报价页对 `useQuoteProfiles` 的调用（hook 文件保留）。
- `build-request.ts` 加 `tax_archive_code`（仅来源）；policy 仍显式下发；
  **后端不得用档案值覆盖 policy**（加测试：档案值与请求值不同，价格按请求值）。
- 报价单快照：`quote_orders` 加 `tax_archive_id/code/name/tax_snapshot`（迁移加列）；
  orchestrator + worker 开单写入；`shared/contracts/quote-order.ts` 更新。
- 批量报价：接同一个 picker；若批量仍走 fixed/印花税，先隐藏档案选择。
- e2e：建档案 → 报价页默认最新 → 自动填 → 改值 → 保存报价单 → 快照可查。

### TAX-06 下线旧链路（task-7，破坏性）

- 前置：TAX-05 验收 + 用户单独确认。
- 先 grep 确认无调用，再删 `/rate-sets`、`/rate-sets/reload`、`/rebate-rate/lookup`。
- 删除 `customer_quote_profiles` API/模型；表删除放到发布后迁移 `202610180010`。
- 删 `rates.py`、`rate_sets/`、`rate_sets_data.py`、`_manifest.json`；
  `sync-shared.ps1` 去掉 rate_sets 清单/内嵌生成与 `-Check` 特殊分支。
- `rate_set_code` 保留一个发布周期（deprecated），不立即删字段；旧报价单快照可读。
- 客户档案：停写 `customer_quote_profiles`；表数据保留，**不 drop**。
- 更新设计/实现地图/PROBLEM_STATUS；全量门禁。

### TAX-07 门禁与收口（task-8）

- 跑全量门禁并打印**完整摘要**；核对 `passed + failed + skipped == 总数`；
  禁止过滤视图/关键字 grep 当证据。
- 真实 UI 验收（无 console error / 4xx / 5xx）。
- 更新两份 tax 文档、WORKSTATION_DESIGN、CURRENT_IMPLEMENTATION_MAP、PROBLEM_STATUS、HANDOVER。
- 提交/推送按用户放行；私有 index；推送失败重试。
- 收口写清“已完成 / 未完成 / 待决策 / 回滚”。

---

## 5. 写入范围与并行

| 任务 | 主要写入范围 |
|---|---|
| TAX-01 | `backend/orchestrator/app/db/tax_models.py`、`app/db/base.py`、`alembic/versions/`、`shared/contracts/export-quote.ts`、`docs/openapi.json` |
| TAX-02 | `backend/orchestrator/app/api/tax_archives.py`、`app/main.py`、`tests/test_tax_archives_api.py`、`docs/openapi.json` |
| TAX-03 | `backend/worker/src/tax_archives.py`、`backend/worker/src/main.py`、`backend/worker/tests/`、`scripts/route-parity.py` |
| TAX-04 | `frontend/src/app/(app)/settings/tax-archives/`、`components/layout/sidebar.tsx` |
| TAX-05 | `frontend/src/app/(app)/quotes/`、`quotations/v2-quote/`、`shared/contracts/quote-order.ts`、`db/workstation_links.py`、`api/quote_orders.py`、`api/export_quote.py`、`alembic/versions/`、`worker/src/quote_api.py` |
| TAX-06 | `services/export_quote/`、`api/export_quote.py`、`worker/src/quote_api.py`、`scripts/sync-shared.ps1`、`use-quote-profiles.ts`、`docs/` |
| TAX-07 | `docs/` |

**注意**：

- 范围是**建议性**的，不是锁；并行前先看任务板是否有重叠。
- `TAX-02` 与 `TAX-05` 都会碰 `docs/openapi.json` / `export_quote.py`？按设计：
  TAX-02 只加 CRUD 与 openapi；TAX-05 才加请求字段；顺序依赖已保证。
- `TAX-05` 与 `TAX-06` 都会碰 `export_quote.py` / `worker/quote_api.py`；
  TAX-06 在 TAX-05 之后串行，不得并行。
- 前端 `settings/` 与 `quotes/` 分属两个任务，文件不重叠；
  共享的 `TaxArchivePicker` 由 TAX-05 建，TAX-04 不建。

---

## 6. 门禁与命令

### 6.1 全量门禁

```bash
# orchestrator
cd backend/orchestrator
PYTHONPATH=. pytest -m unit

# worker
cd backend/worker
pytest

# frontend
cd frontend
pnpm typecheck
pnpm lint
pnpm test

# 仓库根
pnpm contracts:check
python scripts/route-parity.py
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1 -Check
cd frontend && NEXT_EXPORT=1 pnpm build
```

> 本机没有 `pwsh` 7；`.ps1` 用 `powershell -ExecutionPolicy Bypass -File`。
> Node/pnpm 的绝对路径见 `AGENTS.md`；跑 `.ps1` 前先
> `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。

### 6.2 contracts / openapi 顺序（容易假绿）

1. 改 Pydantic / 路由；
2. 重生成 `backend/orchestrator/docs/openapi.json`：
   `cd backend/orchestrator && PYTHONPATH=. .venv/Scripts/python scripts/export_openapi.py`；
3. **先提交** openapi 产物；
4. **再跑** `pnpm contracts:check`。

否则会出现“提交前绿、提交后红”——R6 比的是已提交产物，不是工作树。

### 6.3 测量纪律

- 宣布“通过/失败/归零”前打印完整摘要，核对
  `passed + failed + skipped == playwright/pytest 总数`；数字对不上就是证据不足。
- 不要用 grep 0 命中当“没有调用”的唯一证据；用阳性对照/真实报错。
- 并发环境下的瞬态红：先复查，再认领；不能拿它当借口。

### 6.4 e2e / 构建冲突

- `frontend/.next` 是硬冲突资源：`NEXT_EXPORT=1 pnpm build` 与 e2e 的 `next dev`
  **不能同时跑**；跑 e2e 前确认 `/_next/static/chunks/main-app.js` 返回 200。
- 构建门的数字只在工作区静止时作数。

---

## 7. 提交与推送纪律

- 使用独立 worktree/branch；不直接在主工作区提交。
- **禁止** `git add -A` / `git add .` / 裸 `git commit`。
- 用私有 `GIT_INDEX_FILE`（指向 `%TEMP%`）只装自己的 hunk；
  提交前 `git diff --cached --stat` / `-- <file>` 只应含自己的改动。
- 部分 hunk 提交先转 LF（工作树 CRLF、index blob LF）。
- 提交后、**清掉 `GIT_INDEX_FILE` 变量之后**，再用 `git add -- <自家路径>` 归位共享 index；
  判据：`git diff HEAD -- <自家路径>` 为空、`git status --short -- <自家路径>` 无输出。
- `commitlint` 的 subject 用中文或全小写，避免 `subject-case` 红。
- 提交按任务拆分（data/contracts、API、worker、UI、quote、cleanup、docs），
  每笔都能独立回滚。
- 推送偶发 `Connection was reset` / `Failed to connect` → 重试；有未推提交先补推。
- 不提交别人的改动；不拿别人的文件做自证。

---

## 8. Definition of Done

- [ ] `TAX-00` 用户拍板并回写方案 §8（谁定的、依据）。
- [ ] 税务管理页可 CRUD；团队管理员写、成员读；跨团队不可见。
- [ ] 报价页：有档案默认最新并自动填四税率；可改；改后“本单已修改”；
      无档案默认“自定义”；选择档案后价格随税率变化。
- [ ] 单一事实源：后端只按请求显式税率算价；档案不二次覆盖（有测试）。
- [ ] 报价单存 `tax_archive_code + tax_snapshot`；旧单可读。
- [ ] 旧 `rate_set_code` 请求兼容；旧报价单不丢。
- [ ] P4 后报价页无两层下拉/存为档案；无 `/rate-sets`/HS 死链；sync 不再生成 rate_sets 清单。
- [ ] 全量门禁绿；完整摘要可核对。
- [ ] 文档更新：方案状态、WORKSTATION_DESIGN、CURRENT_IMPLEMENTATION_MAP、PROBLEM_STATUS、HANDOVER。
- [ ] 任务板 `task-2..task-8` 全部 completed；无遗留 owner。
- [ ] 交接文档写清“已完成 / 未完成 / 待决策 / 回滚”。

---

## 9. 风险与回滚

| 风险 | 处理 |
|---|---|
| 前端自动填 + 后端又按档案算 = 两个事实源 | 本计划硬性规定：后端只收显式 `policy`；加“档案值与请求值不同，价格按请求值”的单测 |
| Worker / orchestrator 不一致 | 同一套白名单/状态码；`route-parity` + 双端测试 |
| 旧客户端/旧前端仍调 `/rate-sets` | P4 前保留路由；先标 deprecated，等一个发布周期 |
| 批量报价 fixed/印花税与档案字段不一致 | 先隐藏批量页档案选择；对齐 margin/misc 后再接 |
| 并发工作区冲突 | 独立 worktree；私有 index；不碰他人未提交改动 |
| P4 删代码破坏旧单 | 旧单存的是结果/快照，不依赖 `rates.py`；`rate_set_code` 保留一个发布周期；P4 单独提交、可 revert |
| 数据迁移 | P0/P3 只加表/加列；不 drop；生产迁移需用户放行 |
| 用户未拍板 | TAX-00 未完成 → 停止，不猜；不进入 TAX-01 |

**回滚**：

- 新表/新列是加法的，回滚代码即可，数据保留；
- 报价页接入是独立提交，可 revert 回旧 UI（旧后端仍在，直到 P4）；
- P4 是独立提交，可 revert；不 drop 表，旧数据仍在。

---

## 10. 交接清单（给下一个执行方）

- [ ] 读 `AGENTS.md`、方案、本文；确认 `HEAD` 与当前工作区状态。
- [ ] 确认 `TAX-00` 已由用户拍板；未拍板就停。
- [ ] 建 worktree/branch；复制两份 tax 文档；跑基线门禁。
- [ ] 按依赖图领取 `task-2` → `task-3` →（`task-4` / `task-5` 并行）→ `task-6` → `task-7` → `task-8`。
- [ ] 每完成一个任务：更新任务板；跑该任务相关测试；记录到交接日志。
- [ ] P4 前再次向用户确认“删除旧链路”；不要顺手删表。
- [ ] 收口：全量门禁 + 文档 + 提交/推送（按用户放行）+ 关闭任务。
- [ ] 给下一个会话留一段“当前状态/下一步/坑”的交接摘要（可直接追加到 `HANDOVER_2026-10-18.md`）。

---

## 11. 决策记录（谁定的、依据）

| 决策 | 结论 | 谁定 | 依据 |
|---|---|---|---|
| 税务档案从“每单可选法定层”改为“独立税务管理 + 报价自动填” | 已定 | 用户（2026-10-18） | 用户原话：像产品管理/企业管理一样单独税务管理；选择后自动填入；可自定义；无档案默认自定义；有档案默认最新 |
| 档案只负责填表、不参与后端算价 | 建议（待实现） | 本计划 | 避免两个事实源；当前主路径本来就全显式下发 |
| 团队级 vs 租户级 | 建议团队级 | 待用户确认（TAX-00） | 项目规则：团队是隔离边界 |
| 客户税率档案去留 | 建议停用 UI、保留数据 | 待用户确认（TAX-00） | 两层下拉是当前困惑来源；数据不删 |
| 档案字段 | 建议四税率 | 待用户确认（TAX-00） | 与当前报价表单字段对齐；利润/让利是商业决策 |
| 版本/生效日期 | 建议只展示/排序，不做日期门禁 | 待用户确认（TAX-00） | 当前只有一个版本；历史靠快照 |
| HS 查询 | 建议下线/暂缓 | 待用户确认（TAX-00） | 无数据、无 UI、无公开 API |
| 批量报价 | 先隐藏档案选择，后对齐 margin/misc | 待用户确认（TAX-00） | 当前批量仍走 fixed/印花税 |
