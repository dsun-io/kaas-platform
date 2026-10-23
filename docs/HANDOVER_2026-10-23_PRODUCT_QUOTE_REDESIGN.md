# 交接文档 · 产品×报价重构（2026-10-23 收尾）

> **用途**：用户 2026-10-23 17:05 要求「交接并生成文档、全部推送远程、关电脑」。
> 本文件记录**停止时刻的全部事实**：已完成批次、门禁实测、未完成事项与**在新设备恢复任务的步骤**。
> 恢复时先读本文件 + `git log` + `git status`，**不要假设工作树干净**。
>
> 关联文档：
> - 方案（唯一真源）：[`OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md`](./OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md)
> - 批次状态账本：[`TODO.md`](./TODO.md) §R
> - 历史停止点（上一轮）：[`HANDOVER_2026-10-23_PAUSE.md`](./HANDOVER_2026-10-23_PAUSE.md)（已解除，仅留档）

## 0. 停止点快照

| 项 | 值 |
|---|---|
| 分支/HEAD | `main` @ 本文件同批提交（见 `git log -1`） |
| 工作树 | **干净**（本文件所在提交已含全部改动） |
| 用户要求 | 交接文档 ✅ / 全部推远程 ✅ / 关机 ✅ |
| 测试环境 | 本机 Windows + PowerShell 5.1（无 pwsh 7）；node v24.20.0 |

## 1. 本轮做完了什么（代码已落）

### ✅ R-C2 税务档案：侧边栏可见 + 改名（用户反馈 10/11）

**根因**：页面早已建成（企业税档：销项增值税/杂税；产品税率：进项增值税/出口退税率），
但工位挂在 `admin` 组（`internalOnly: true`），侧边栏对**外部团队账号整组隐藏** ⇒ 用户永远看不到。

**改动**（6 处 + 后端镜像 + 文案）：
| 文件 | 改动 |
|---|---|
| `shared/contracts/workstations.ts` | tax-archives：`group: 'admin' → 'account'`、`order: 22 → 2`、`name: 税务管理 → 税务档案`；`SUB_ROUTE_LABELS` 同步 |
| `backend/kaas_common/domain/workstations.py` | 逐字段镜像同步（R2 契约要求） |
| `frontend/.../settings/tax-archives/page.tsx` | 页面标题/描述「税务档案」+ 说明整单参数引用 |
| `quotes/views/workbench-params-card.tsx`、`batch-quote-view.tsx` | 提示文案「税务管理」→「税务档案」 |
| `tax-archives/components/fx-rate-card.tsx`、`fx-history-card.tsx` | 注释同步 |
| 根 `README.md` | 工位表行更新 |
| `tax-archives/__tests__/tax-archives-page.test.tsx` | 测试注释同步 |

**影响**：外部账号侧边栏「账号」组现在可见「税务档案」（与「企业信息」同组）；写权限不变
（团队管理员写、成员只读，页面自带只读降级）；报价整单参数的档案下拉**本来就已实现**（选档案自动填税率），未改。

### ✅ R-A 产品页收口（用户反馈 1/2/3/5/6/7）——代码完成

**A1 包装去名称**（反馈 6）：
- `products/components/business-spec-editor.tsx`：删除「包装名称」输入；`addPackaging` 不再生成 `name: "包装 N"`；
  改「包装方式」时**自动回填 name = method**（旧报价快照 `packaging_name` 兼容）；空态文案「还没有包装」。
- 包装区标题「包装费」→「包装」，说明改为「每行 = 一种包装方式（含是否默认与金额）」。

**A2 表面处理并入基本信息**（反馈 1/5）：
- 新增 `OptionChips` 组件（chips 多选项，可加/删，回车即加）。
- 表面处理 chips **绑定 `spec.variants` 的 coating 组**（算价真源不变；识别规则 label='表面处理' 优先、
  `surface/coating/surface_treatment` 别名兜底）；未配置时添加第一个选项即创建
  `{ name: 'coating', label: '表面处理', options } `。
- `business-spec-editor.tsx` 的「可选档位」整块删除（数据未删，只是入口收口）。

**A3 材质 chips**（反馈 1；口径 D-1：仅资料不算价）：
- 基本信息新增材质 chips，存 `product_profiles.info.material_options: string[]`
  （profile 是自由 dict，PUT 全量保存，**零后端改动**）。
- 报价行选材质写入快照 → 属 R-B（未做）。

**A4 HS 编码合一**（反馈 2）：
- 基本信息新增唯一「HS 编码」输入（`spec.hs_codes`，逗号分隔多值，报价/单证取第一个）。
- `business-spec-editor.tsx` 的 HS 块删除；`PROFILE_FIELDS` 删除 `hs_code` 展示副本。

**A5 删「价格与利润」区**（反馈 3）：
- `product-detail.tsx` 删除利润率/综合税费/成本口径三个控件与对应 state；
  section 改名「规格与包装」，标题说明「利润率/综合税费/成本口径在报价工作台配置」。
- 保存时 `cost_basis/profit_value/misc_fee_rate` **原样保留 spec 现值**（引擎兜底默认，不再由产品页改）。

**A4 附带**：`PROFILE_FIELDS` 只剩「用途 / 产地」；文件头注释与测试断言同步更新。

## 2. 门禁实测（2026-10-23 17:05，工作区静止）

| 门禁 | 结果 |
|---|---|
| 前端 typecheck（`tsc --noEmit`） | ✅ 0 error |
| 前端 lint（改动目录） | ✅ 0 error（12 warning 均为 `use-workbench-state.ts` 既有） |
| 前端定向测试（products/quotes/settings） | ✅ **207 passed / 34 files** |
| 前端全量测试 | ✅ **1610 passed / 216 files**（全绿） |
| `contracts:check`（R0–R6） | ✅ **PASS R2: 30 workstations consistent** 等全 PASS |
| `sync-shared` | ✅ 46 + 21 + 1 文件已同步（worker 镜像） |
| UI 标准 `ui:standards` | ✅ 通过 |
| UI 对比度 `ui:contrast` | ✅ light/dark 全部 ≥ 4.5 |

## 3. 没做完的（按方案 §4 顺序，交给下一台设备继续）

> 方案文档 [`OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md`](./OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md)
> §3 有每项的**目标设计与数据落点**，§4 有批次依赖。以下按建议实施顺序：

### R-C1（下一个该做）：成本含税开关（跨层契约，唯一引擎改动）
- 契约：`ExportQuoteRequest` 增 `cost_basis?: "pretax" | "incl_tax"`（缺省回落 `product.cost_basis`）。
- 落点：`shared/contracts/export-quote.ts` + `backend/kaas_common/export_quote/models.py`（`QuoteRequest`）
  + `engine.py`（约 :800-805 处 request 级覆盖产品级）。
- **铁律**：同 PR 同步 TS zod（从 pydantic 生成，禁止手抄）+ `backend/ts-migration/golden/` 金标全绿 + worker pytest。
- 语义：勾「含税」⇒ 引擎按现行公式 `税前 = 含税价 × (1 − 进项税率)` 还原，**不引入新换算**。

### R-B：报价行卡重排（依赖 A3 的材质选项）
- `quotes/components/quote-line-card.tsx`：三段布局（产品信息上 / 件数中 / 金额下，类型各自换行；
  折叠摘要同样三行）；包装下拉 `{p.method || p.name}`（现在显示「包装 1」）；
  成本旁加「按含税价」开关（接 R-C1）；材质选择写入行快照 `spec_snapshot.material`。
- `quotes/lib/line-to-item.ts`：快照增记 `packaging_method`（`packaging_name` 保留兼容，值 = method）。

### R-D：批量导入整单化（依赖 C1 + B）
- 口径已拍板：**单表 + 产品列**（规格列并集）；**导入结果 = 直接生成工作台报价单**。
- 后端：`backend/worker/src/quote_api.py`（现 template/preview/calculate 三端点 `product_key` 必填，
  单产品链路 :1002-1130）+ `kaas_common/export_quote/importers.py`；新 `import/order/preview|calculate`。
- 前端：`quotes/components/bulk-import-panel.tsx` 去掉「先选产品」，下载整单模板 → 预览 → 「填入工作台」生成 N 行。

### 收尾未做
- 文档销账：TODO §R 的 R-A/R-C2 状态、PROBLEM_STATUS 交接摘要（本次提交已含，若后续改代码需再更新）。
- 产品基本信息新结构的专项测试（OptionChips 行为 / 表面处理写回 variants / HS 合一）——
  当前靠 typecheck + 既有测试兜底，**建议下一轮补**。

## 4. 下一台设备恢复步骤（照做即可）

```powershell
git clone <repo> ; cd kaas-platform
# 1) 共享内核镜像（gitignored，必须）
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1
# 2) 前端依赖
cd frontend; pnpm install    # 本机若 pnpm 被策略拦，用 bundled node + pnpm.cjs
# 3) 起活
pnpm dev                     # 或按 docs/E2E_GUIDE.md
# 4) 门禁基线（工作区静止时跑）
pnpm typecheck ; pnpm lint ; pnpm test ; pnpm contracts:check ; pnpm ui:standards ; pnpm ui:contrast
# 5) 从 R-C1 继续（见 §3）
```

- 本机工具链备忘（Windows）：PowerShell 5.1 无 pwsh 7；PATH 上 `python` 是 WindowsApps 占位符 ⇒
  静态脚本用 `backend/orchestrator/.venv/Scripts/python.exe`；uv 需 `$env:UV_CACHE_DIR='D:\tools\uv-cache'`。
- **提交纪律**（AGENTS.md §4）：多会话并发时用私有 `GIT_INDEX_FILE` 提交，提交后新进程里
  `git add -- <自家路径>` 归位共享 index，并 `git status --short` 自证。
- **commitlint**：subject 用中文或全小写；**body 每行 ≤ 100 字符**（本轮实测被拒过一次）。

## 5. 关键口径备忘（本批已定，勿回退）

1. **材质 = 仅资料选项**（不算价、不进规格空间、不增定价行数）；报价行选值进快照/单证。
2. **表面处理 = 算价真源 `spec.variants`**（coating 组），基本信息 chips 只是入口；
   「定价数据」页的 AddOptionPanel 与它是**同一份数据两处入口**（加档位+成本仍在那里）。
3. **批量导入 = 单表+产品列；结果直接进工作台报价单**（原「只算不落库」废止）。
4. **税务档案 = 团队级**（企业税档 + 产品税率），侧边栏「账号」组可见，管理员写/成员读。
5. **产品页不再有**：价格与利润区、可选档位区、第二个 HS 编码、包装名称。
6. 产品级 `profit_value/misc_fee_rate/cost_basis` **字段保留**（引擎兜底），只是 UI 收口。
