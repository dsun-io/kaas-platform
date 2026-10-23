# 交接文档 · 2026-10-23 09:00 暂停点（UI backlog 清理进行中）

> **用途**：用户要求「做到 09:00，暂停任务、开始写交接文档」。本文件记录**停止时刻**的全部事实：
> 已推送成果、工作树未提交改动（按任务归属）、已验证门禁、未完成事项与恢复步骤。
> 恢复时按 §4 顺序执行；**先读本文件 + `git status`，不要假设工作树干净**。

## 0. 停止点快照

| 项 | 值 |
|---|---|
| 时间 | 2026-10-23 09:00（Asia/Shanghai） |
| 分支/HEAD | `main` @ **`946e7cb0`**（已 push，与 origin 同步） |
| 工作树 | **50 项未提交改动**（含 9 个 POC 文件删除、多个新增组件/测试），见 §2 |
| 运行中的队友 | 已全部暂停（fe-inquiries 被 interrupt；其余 4 个任务已完成） |
| 任务板 | task-23/24/26/27 **completed**；task-25 **in_progress（未完成）** |
| 目标状态 | 新 goal（清空 TODO 可执行项）保持 active，未完成 |

## 1. 本会话已推送的成果（按时间）

| 提交 | 内容 |
|---|---|
| `26074659` | M1-f 门面收口（12 条透传 + 3 条 legacy inquiries 改透传）+ M3 漏斗后端（cohort 口径） |
| `2e971736` | M2-A `/inquiries` 询盘工位 + 导航契约双端登记（R2=29） |
| `5d7d3a12` | M2-B 订单来源链/行项编辑/变更审批 + M2-C 审批中心/通知铃铛/审批设置 + M3 dashboard 前端（R2=30） |
| `de9c0d76` | 按最新实现/设计重写 UI 执行方案（新增 `UI_EXECUTION_PLAN_2026-10-23.md`，审计加 §8 复跑基线） |
| `0898ad69` | UI 批 1：P0-A 后端（待批计数/affected_docs/应收聚合/通知 link/分币种）+ P0-C 原语/门禁 + P0-B1 危险操作止血 |
| `7ba2c34d` | UI 批 2：P0-A-FE / B2 失败反馈 / B3 失败≠空态（kb 假统计下线）/ B5 边界 |
| `0045fc06` | UI 批 3：B6 行内展开 X1–X8 迁移 + P1D/P1E 部分 |
| `8b1f9f21` | UI 批 4：B4 剩余 + 状态 tone 收敛 + P1E 续 + 小项（pricing 确认/QuoteWizard 步骤/orders O3-O5/barrel） |
| `946e7cb0` | **nightly 修复**：集成夹具补 `trade_docs.currency` + TODO 过时行清理 + mock `GET /shipments/{id}` |

**nightly 验证**：`gh run view 39879351518`（workflow_dispatch）三个 job 全 success，其中
`worker:integration（真 PG 写入路径）` **success** —— 2026-10-22 定时失败（NotNullViolation）已修复并实证。

## 2. 停止时未提交改动（按任务归属）

> 这 5 个任务由队友执行；**除 task-25 外均报告门禁绿（见 §3）**，但工作树从未提交过，
> 恢复后仍必须由 Lead 复核 diff + 静止状态跑全量门禁再提交。

### task-23 ✅（be-gaps，backend）
- `backend/kaas_common/workstation/state_machines.py`：ORDER_NEXT 的 producing → (`shipped`)
- `backend/worker/src/main.py`：删除本地第二份 ORDER_NEXT，改 import 共享表（单一真源；生产行为不变）
- `backend/worker/tests/test_parity_quote.py`：断言 `worker_main.ORDER_NEXT is SHARED_ORDER_NEXT`、producing→cancelled 409
- `backend/worker/tests/test_trade_doc_packing.py`：新增「不传 packing ⇒ 仍 TRIGGER_UNKNOWN_KEY」边界测试（A-7/A14 核对结论：HEAD 已实现）
- `backend/ts-worker/src/rules.ts` / `README.md`：镜像注释与语义差异登记销账（内容未变）
- 删除 `backend/worker/poc-sqlalchemy/`、`backend/worker/poc-baseline/`（9 个 tracked 文件；grep 0 引用）
- `backend/ts-migration/routes.json` + `route-inventory.md`：因 main.py 行号位移重新生成（路由集合不变 274+4=278）

### task-24 ✅（fe-orders，frontend）
- `frontend/src/app/(app)/shipments/page.tsx`：编辑弹窗改为按 id 查详情（`GET /shipments/{id}`），详情失败窗内可重试或显式用列表快照继续
- 新增 `shipments/hooks/use-shipments.ts`（list/detail queryKey）、`shipments/types.ts`
- 新增/更新测试：`shipments-detail-query.test.tsx`（5）、`shipments-editor-dialog.test.tsx`、`shipments-mutations.test.tsx`

### task-25 ⚠️（fe-inquiries，**未完成，被 09:00 暂停**）
- 已落盘部分（**未验证，可能半成品**）：
  - `frontend/src/app/(app)/customers/page.tsx`（分页/计数/表单改动中）
  - `customers/__tests__/customers-page-ux.test.tsx`、新增 `customers-pagination.test.tsx`、`form-field-labels.test.tsx`
  - `research/page.tsx`、`research/components/research-edit-dialog.tsx`、`research/__tests__/research-edit-dialog.test.tsx`
  - `leadgen/components/leadgen-config-form.tsx` + `leadgen/__tests__/leadgen-config-form.test.tsx`（FormField 版，task-26 已确认保留）
  - `leadgen/page.tsx` 中 industryError 接线
- **未做/未报告**：FormField 收编是否覆盖全部目标表单、customers 分页是否完成、门禁未跑全量。
- 恢复：见 §4 第 1 步。

### task-26 ✅（ui-danger，frontend）
- `leadgen/page.tsx` 1000 → 350 行；新增 `leadgen/components/{leadgen-table,filters,run-actions,run-history,detail-drawer,config-form}.tsx`、
  `leadgen/lib/{types,status-labels,restore-focus}.ts`
- 与 task-25 同目录并发已双向确认：保留 task-25 的 FormField 版 config-form 与其测试、industryError 接线、run-actions 的 role=alert；
  ui-danger 已删调试文件 `zz-debug.test.tsx`

### task-27 ✅（ui-primitives，frontend）
- 新增 `components/shared/popover-panel.tsx`（+ index 导出、5 测试）：aria/ Esc 焦点归还/外点关闭
- `orders/page.tsx` 列配置改 PopoverPanel；`orders/__tests__/orders-columns-popover.test.tsx` 迁移断言
- `lib/status-tones.ts`：登记 `STATUS_TONE_MAPS.campaign`；`status-tones.test.ts` 锁 5 域
- `scripts/ui-patterns-check.cjs` + 自测：native-dialog 2→0（作用域修复+改名）、page-size 4→0（AST+白名单理由）；
  **ui:patterns shadow 111 → 105 违规**（bare-table 38 / plain-text 16 / mutation 51 未动）
- `quotes/components/quote-issue-button.tsx`、`trade-docs/components/doc-void-button.tsx`：局部 confirm 改名

## 3. 已验证门禁（各任务报告口径，静止子集）

| 任务 | 结果 |
|---|---|
| task-23 | worker **1711 passed + 12 skipped**、orchestrator **266**、ts-worker typecheck 0 / **278 passed**、sync-shared -Check / schema-coverage / schema-drift / runtime-deps / worker-bundle / export_routes 全 0 |
| task-24 | typecheck 0、shipments 4 files/12 tests、lint 该目录 0、mocks:check / ui:standards / ui:contrast PASS |
| task-26 | leadgen 6 files/17 tests、tsc 0、lint 0 error、ui:standards / ui:contrast PASS |
| task-27 | typecheck 0、lint 0 error、23 files/121 tests、ui:patterns shadow 105 violations、ui:patterns:test 9/9、ui 两门禁 PASS |
| **全量** | **未在停止前静止复跑**；task-24 报告曾有一次 209 files / 1525 tests 通过（随后出现队友删除 zz-debug 的 phantom suite 与并行负载导致的中断）。**恢复后必须重跑**。 |
| nightly | dispatch run 39879351518 全 job success（integration success） |

## 4. 恢复步骤（严格按序）

1. `git status` 逐个核对 §2 文件；**task-25 视为未完成**——先让 fe-inquiries 完成（`team_task_get task-25`）或由 Lead 接管：
   先跑 `cd frontend; pnpm typecheck` 与 customers/research/leadgen 定向 vitest，确认是否半成品红。
2. 静止状态跑全量门禁（前端 typecheck/lint/test/contracts/mocks/ui:standards/ui:contrast/e2e；worker 全量 + orchestrator + ts-worker；静态断言）。
3. 通过后**分任务提交**（建议 3 个提交：backend task-23；frontend shipments/leadgen；frontend popover/status-tones/ui:patterns）；
   遵守 AGENTS：**不要 git add -A**；工作树里只有本会话改动时可用普通 index，但仍要 `git diff --cached` 自检。
4. push main → CI → 必要时 `gh workflow run backend-test.yml --ref main` 复核集成 job。
5. 之后继续 §5 剩余待办。

## 5. 剩余待办全景（恢复后按序清）

**本 goal 范围内未完成：**
- task-25：customers 列表分页 + FormField 收编（customers/research/leadgen）
- `/quotations` 目录迁移（无 page.tsx；组件仍被 quotes 引用；需整体迁入 quotes 树后删目录）
- 拆巨型文件剩余 6 个：customers 1674 / order-create-wizard 1366 / product-spec-editor 1142 / quote-workbench 924 / research 868 / payment-schedules-panel 698（leadgen 已完成 ✅）
- A-10 C27 QA 越权审计 7 条留证（真机黑盒，验收矩阵见 `docs/QA_AUTHZ_VERIFY_2026-10-21.md`；仅拒绝路径，需 QA 账号）
- TODO 状态销账：A-7/A14（已实现，仅补测试）、F2-1、N7、U-P1D2(leadgen)、U-P1E(部分) 需更新；docs 内 POC 历史引用加「源码目录已删」注记
- ui:patterns 剩余违规 105（bare-table 38 / plain-text 16 / mutation 51 + 白名单 2），目标 2026-10-30 转 strict 前清零；
  quote 记录列表分页（P1-E）已白名单登记，转 strict 前必须修

**明确排除（需用户拍板/已挂起）：**
- A2-B（模板迁服务端，需用户定方案）、N6+/G-8 安全批（破坏性操作需确认）、B-6 self-hosted runner（可选，需用户机器）
- A-11 冷启动基线（用户决定挂起）、C24 产品手册附件（暂缓）、N10 事件流（暂缓）

## 6. 环境与命令备忘（本机）

- pnpm 被 PowerShell 执行策略拦 ⇒ 用 bundled：`node.exe` + `...\\dependencies\\pnpm\\bin\\pnpm.mjs`（cwd 按项目）
- worker 测试：`$env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:TMP='D:\tmp'; $env:TEMP='D:\tmp'; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q --basetemp=D:\tmp\pytest-kaas`
- orchestrator：`cd backend/orchestrator; uv run --extra migrations pytest tests -q`
- 静态脚本用 `backend/orchestrator/.venv/Scripts/python.exe`（PATH 上 python 是占位符）；PowerShell 5.1 无 pwsh。
- e2e 与 `next typegen` **不能并发**（`.next` 冲突会让 e2e 数字作废）。

## 7. 风险与注意

1. **工作树 50 项未提交**：包含删除的 POC 目录与多个新增组件；恢复后先确认全量绿再提交，禁止 `git add -A` 混入半成品。
2. task-25 与 task-26 曾在 leadgen 同目录并发（已约定边界）；恢复时先看 `leadgen/page.tsx` 与 `components/leadgen-config-form.tsx` 是否一致。
3. task-27 遗留：orders 窄屏卡片 `<button>` 内嵌 `CopyButton`（nested button warning，既有问题，建议单独修）。
4. task-23 遗留：`quote_api._QUOTE_NEXT` 仍是本地表（报价状态机收敛可另开）；docs 内 POC 历史引用未加注记。
5. 本轮 UI 批 4 提交后，本机全量数字基线为前端 **1512 passed / 206 文件**、e2e **28 passed**；本轮新增改动后需重新取数。
