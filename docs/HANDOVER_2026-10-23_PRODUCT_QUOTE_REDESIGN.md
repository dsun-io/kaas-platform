# 交接文档 · 产品×报价重构（2026-10-24 收尾终版）

> **用途**：产品管理 × 报价重构（用户 2026-10-23 反馈 14 条）已全部落地（R-A / R-B / R-C1 / R-C2 / R-D），
> 本文件记录**最终事实**：改动范围、门禁实测、遗留项与恢复步骤。恢复时先读本文件 + `git log` + `git status`。
>
> 关联文档：
> - 方案（唯一真源）：[`OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md`](./OPTIMIZATION_PLAN_2026-10-23_PRODUCT_QUOTE_REDESIGN.md)
> - 批次状态账本：[`TODO.md`](./TODO.md) §R
> - 历史停止点：[`HANDOVER_2026-10-23_PAUSE.md`](./HANDOVER_2026-10-23_PAUSE.md)（已解除，仅留档）

## 0. 快照

| 项 | 值 |
|---|---|
| 分支/HEAD | `main` @ 本文件同批提交（见 `git log -1`） |
| 工作树 | **干净**（本文件所在提交已含全部改动） |
| 测试环境 | Windows + PowerShell 5.1（无 pwsh 7）；node v24.20.0；worker/orchestrator 用 uv + 各自 venv |

## 1. 四批全部完成

### ✅ R-A 产品页收口（反馈 1/2/3/5/6/7）
- 基本信息：表面处理 = `spec.variants` coating 组（chips 多选项，label/别名识别，未配置时首个选项即建组）；
  材质 = `product_profiles.info.material_options`（**仅资料，不算价**）；HS 编码唯一入口（`spec.hs_codes`）。
- 删「价格与利润」区（利润率/综合税费/成本口径在报价工作台配置；产品级字段留引擎兜底）。
- 删「可选档位」区（数据保留，入口收口到基本信息）；包装区去「包装 N」名称（改方式时 name 回填 method 兼容旧快照）。

### ✅ R-B 报价行重排（反馈 8/9/10）
- 行卡三段：`<section aria-label="产品信息|件数|金额">`，DOM 顺序固定；折叠摘要三行（产品信息/件数/金额）。
- 包装下拉 `{p.method || p.name}`；材质下拉（有 `material_options` 才渲染，选中进快照）；成本旁「按含税价」checkbox。
- `line-to-item` 快照增记 `packaging_method`、`material`。

### ✅ R-C1 成本含税开关（跨层契约）
- `ExportQuoteRequest.cost_basis`（`z.enum(['pretax','incl_tax'])`，可选）；
- Python：`QuoteRequest.cost_basis` 请求级覆盖产品定义（空 = 产品定义），引擎按 `含税价 × (1 − 进项税点)` 还原；
- `quote_api._CalculateIn.cost_basis: Optional[Literal["pretax","incl_tax"]]` → `pydantic-schemas.json` 同步 →
  `backend/ts-worker/src/generated/schemas.ts` 重生成（MCP 工具 schema 同步为 enum）。
- 旧请求（不带 cost_basis）结果逐字节不变（engine 测 `test_empty_basis_keeps_product_default` 钉住）。

### ✅ R-C2 税务档案（反馈 10/11）
- 工位 `tax-archives`：`admin` 组 → `account` 组（此前 internalOnly 导致外部账号侧边栏不可见）；
  「税务管理」→「税务档案」双端改名（契约 + Python 镜像 + 页面标题/文案 + 根 README）；R2=30 PASS。

### ✅ R-D 批量导入整单化（反馈 13）
- 后端：`GET /api/v1/export-quote/import/order/template-info`（并集列定义）+
  `POST /api/v1/export-quote/import/order/preview`（单表 + 产品列；每行先定位产品再用该产品列映射解析；
  行级容错；`packaging_id` 服务端按 method 解析；`cost_basis/profit_pct` 随行返回）。
  **实施裁决**：不新增 calculate 端点（算价/落库复用工作台链路，避免第二套算价口径）。
- 前端：`bulk-import-panel` 三步（下载整单模板 → 上传预览 → 填入工作台）；`bulk-import-dialog`/`workbench-toolbar`
  接线 `onFillRows` → `quote-workbench-view` 生成行草稿（含 costBasis/packagingId/profitPct）。
- 模板：`frontend/src/lib/export-quote/import-order-template-xlsx.ts`（exceljs 现生成，表头/说明页标注适用产品）。
- 路由清单：283 → 285（281 业务 = 193 直接 + 88 透传），`routes.json`/`route-inventory.md` 已重生成，
  `openapi.test.ts`/`route-surface.test.ts` 计数同步。

## 2. 门禁实测（2026-10-24，工作区静止）

| 门禁 | 结果 |
|---|---|
| worker pytest（全量） | ✅ **1778 passed + 12 skipped** |
| orchestrator pytest | ✅ **266 passed** |
| ts-worker typecheck / vitest | ✅ 0 error / **305 passed（26 files）** |
| 前端 typecheck / lint | ✅ 0 error / 0 error（既有 warning 不计） |
| 前端全量 vitest | ✅ **1626 passed（219 files）** |
| contracts:check | ✅ R0–R6 全 PASS（R2=30） |
| ui:standards / ui:contrast | ✅ PASS（对比度 light/dark ≥4.5） |
| mocks:check | ✅ 通过（未覆盖 3 ≤ 20） |
| 静态断言 | ✅ schema-coverage / runtime-deps / deploy-domains PASS；schema-drift PASS（需 `PYTHONIOENCODING=utf-8`，否则 GBK 打印 emoji 崩） |
| sync-shared `-Check` | ✅ 一致（46 / 21 / 1） |
| e2e（playwright） | 见提交说明；本机 UI 改动后应跑 `cd frontend; pnpm e2e`（a11y 自动发现路由） |

## 3. 遗留与后续（非本批）

1. ~~**deer_net 产品定义遗留（既有，非 R-D 新增）**~~ **✅ 2026-10-24 已修（只改产品列定义）**：
   `products/deer_net.py` 的 `Column("derived.width_mm","宽度(mm)")` 改为
   `Column("spec.height_m","宽度(m)","Width (m)",2)`（derived `width_mm` 公式保留）⇒ `template_columns` 只出
   「宽度(m)」并按 m 解析，不再把 derived 列当可填参数、不再 factor=1 撞 `height_m` 上界 6；整单并集模板同步。
   **残余边界**：历史遗留的含「宽度(mm)」表头的文件仍会按「去单位基名」解析到 `height_m`（factor=1）——
   新模板/整单模板已不产出该表头；彻底按单位区分需改引擎，超出「只改产品列定义」裁决。
2. 单证（trade-docs）模板对「材质」的排版：**✅ 2026-10-24 已做**：行快照 `spec_snapshot.material` 由
   `trade_doc/payload_shared._spec_to_text` 并入 Specification 文本末尾（`Material: <值>`，英文单据口径），
   **不新增列/字段、不改 render.ts**；无材质时输出逐字不变。
3. ~~旧单产品导入端点保留兼容~~ **✅ 2026-10-24 已下线（用户裁决）**：删除
   `GET /import/template`、`POST /import/preview`、`POST /import/calculate`（含 TS scope 规则、前端死
   hook/mocks/测试）；保留 `GET /products/{key}/import-template`（download URL 已改指自身）；
   整单导入（`/import/order/template-info` + `/imports/orders`）不受影响。路由 **282 = 278 业务 + 4 内置**。
4. R-C1 含税开关默认显式 `pretax`：内置产品定义 basis 均为 pretax ⇒ 行为不变；若将来租户产品改 basis，
   可改为默认跟随产品定义（`formulas.data.cost.basis` 回显）。
5. `/api/v1/export-quote` 属 TS 门面透传前缀：新端点无需在 ts-edge 逐条注册；MCP 工具 schema 已随 zod 生成同步。

## 4. 恢复/继续步骤（新设备）

```powershell
git clone <repo> ; cd kaas-platform
powershell -ExecutionPolicy Bypass -File scripts/sync-shared.ps1     # 共享内核镜像（gitignored，必须）
cd frontend; pnpm install
# 门禁基线（工作区静止时跑）
pnpm typecheck ; pnpm lint ; pnpm test ; pnpm contracts:check ; pnpm mocks:check
pnpm ui:standards ; pnpm ui:contrast ; pnpm e2e
cd ../backend/worker; $env:UV_CACHE_DIR='D:\tools\uv-cache'; uv run --frozen --with pytest --with httpx2 python -m pytest tests -q
cd ../orchestrator; uv run --extra migrations pytest tests -q
cd ../ts-worker; pnpm typecheck ; pnpm test
```

- 提交纪律（AGENTS.md §4）：多会话并发时用私有 `GIT_INDEX_FILE` 提交，提交后新进程 `git add -- <路径>` 归位共享 index。
- commitlint：subject 用中文或全小写；**body 每行 ≤ 100 字符**。

## 5. 关键口径备忘（已定，勿回退）

1. **材质 = 仅资料选项**（不算价、不进规格空间、不增定价行数）；报价行选值进快照/单证。
2. **表面处理 = 算价真源 `spec.variants`**（coating 组），基本信息 chips 只是入口；定价数据页 AddOptionPanel 同一份数据。
3. **批量导入 = 单表+产品列；结果直接进工作台报价单**（原「只算不落库」废止；无 calculate 端点）。
4. **税务档案 = 团队级**（企业税档 + 产品税率），侧边栏「账号」组可见，管理员写/成员读。
5. **成本口径逐行可选**（`cost_basis` 请求级覆盖，缺省回落产品定义）。
6. 产品级 `profit_value/misc_fee_rate/cost_basis` 字段保留（引擎兜底），产品 UI 不再暴露。
