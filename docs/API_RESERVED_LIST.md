# 后端先行 API 保留清单（C36）

> **用途**：登记「Worker 有路由、前端没有任何调用」的接口，避免下一轮审计把它们误判成“欠账”。
> 本文件**只登记**，不授权删除；「可删候选」删前需 owner/Lead 确认（后端可能被第三方或自动化脚本使用）。
>
> 扫描基线：`main` @ `17e87744`（2026-10-21，工作区有并发改动时只读扫描）；
> 扫描脚本与原始数据（未入库，可复现）：`.tmp/c36-scan.ps1`、`.tmp/c36-dead.tsv`、`.tmp/c36-dead-docs.tsv`。

## 0. 结论

- Worker 路由：**247** 条（`backend/worker/src/*.py` 的 `@app.<method>`；单应用，无 include_router）。
- 前端调用：**212 条原始 / 183 条归一化唯一路径**（`apiClient.*` + 原生 `fetch`，排除测试）。
- 原始差异：**66 条**「BE 有、FE 无直接调用」；扣除 **6 条假阴性**（动态拼路径/变量 url/查询串/download link，见 §2）
  ⇒ **实际未接 60 条**，分类：**REST/内部/兼容保留 18 条**、**后端先行待接 UI 24 条**、
  **可删候选 18 条**（另 6 条非死）。
- 与 `docs/TODO.md` 的对应关系见 §3；**本文件不修改 TODO**（C36 是否销账由 Lead 决定）。

## 1. 方法（可复现）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .tmp/c36-scan.ps1   # 生成 .tmp/c36-*.tsv
backend/worker/.venv/Scripts/python.exe .tmp/c36-docs.py                  # 补 handler 名/首行 docstring
```

归一化口径（与 2026-10-20 对齐审计同源，实测修过两类坑）：

1. 后端：`@app.<method>("路径")` → 把 `{param}` 换成 `*`；只扫 `backend/worker/src/*.py`（唯一运行时）。
2. 前端：`apiClient.get/post/put/patch/delete`（含跨行泛型、模板字符串）+ 原生 `fetch`；
   `${...}`/`{...}` → `*`、剥 query、补 `/api/v1` 前缀、解析 `EXPORT_QUOTE_BASE` 常量。
3. **已知假阴性**（本清单逐条人工核过）：① 首参是变量（`use-team-admin.ts` 的 `path`、`use-export-quote-calc.ts` 的 `url`）；
   ② 模板串带 query（`/market/ports${params}`）；③ 非 `apiClient` 的下载链接（`useDownloadTemplate` 用 blob 下载）。
4. 仍可能存在：**没有被任何前端代码引用、但被第三方/运维脚本使用**的接口 —— 这类只能靠“可删候选 + owner 确认”兜底。

## 2. 全量清单（66 行：60 未接 + 6 非死）

| 判定 | 方法 路径 | 模块:行 | 依据 / 对应 TODO |
|---|---|---|---|
| 非死路由（本次扫描假阴性，FE 确实在用） | `GET /api/v1/export-quote/import/template` | `quote_api.py:1002` | FE 走下载而非 apiClient 轻调用：`import-file.ts:32` + `use-export-quote-import.ts:139`（responseType blob） |
| 非死路由（本次扫描假阴性，FE 确实在用） | `GET /api/v1/market/ports` | `main.py:1740` | FE 模板串带 query：`market-view.tsx:116`（`/market/ports${params}`，归一化漏判） |
| 非死路由（本次扫描假阴性，FE 确实在用） | `GET /api/v1/teams/*/invites` | `ws_teams.py:359` | FE 动态拼路径：`use-team-admin.ts:198` |
| 非死路由（本次扫描假阴性，FE 确实在用） | `GET /api/v1/teams/*/members` | `ws_teams.py:272` | FE 动态拼路径：`team/hooks/use-team-admin.ts:186`（`/teams/${teamId}/members`） |
| 非死路由（本次扫描假阴性，FE 确实在用） | `GET /api/v1/teams/*/subscriptions` | `ws_workstations.py:154` | FE 动态拼路径：`use-team-admin.ts:210` |
| 非死路由（本次扫描假阴性，FE 确实在用） | `POST /api/v1/export-quote/calculate-internal` | `quote_api.py:899` | FE 变量 url：`use-export-quote-calc.ts:64-66`（内部视图分支） |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/file-objects` | `ws_files.py:571` | 通用列表 REST；前端走 `/products/{key}/media`、`/file-objects/{id}/content` |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/file-objects/_r2_debug` | `ws_files.py:1009` | 线上自检（C9）；`ws_files.py:1009` 有 admin 闸门，注释“排查完可删” |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/fx-rates/_debug` | `ws_extras.py:196` | 线上自检（C9）；`ws_extras.py:196` 有 admin 闸门 |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/health` | `main.py:1847` | CI smoke 调它（`deploy.yml:172/203`、`preview.yml:235`）；Worker 平台健康检查 |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/inquiries` | `ws_crm_ext.py:260` | REST 列表（按客户归类）；前端走 `/customers/{id}/inquiries` |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/leadgen/runs/*` | `chain.py:1029` | REST 运行详情；前端走 `GET /leadgen/runs` 列表 |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/orders/*` | `main.py:3685` | REST 详情；前端目前只有列表（详情页未建） |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/shipments/*` | `ws_shipments.py:314` | REST 详情；前端走列表 |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/subscriptions` | `main.py:1763` | 商业化留口（付费墙未启用）；前端 billing 页仍是占位 |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/subscriptions/bundles` | `main.py:1772` | 同上（套餐包） |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/trade-docs/*` | `main.py:4495` | 标准 REST 读；前端走 `/trade-docs/{id}/render-data` |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/trade-docs/render-fingerprint-checks/batch` | `ws_docs_ext.py:432` | A9 批量只读对账口；前端只调单张 `render-fingerprint-check` |
| 保留 · 内部/运维/CI 与 REST 契约 | `GET /api/v1/workstation-products` | `ws_products.py:426` | B6 兼容 union（前端用 `/tenant-product-status`；建议后续收敛后删） |
| 保留 · 内部/运维/CI 与 REST 契约 | `POST /api/v1/export-quote/verify` | `quote_api.py:909` | 管理员核验 API（三遍核验）；无 UI，保留为工具口 |
| 保留 · 内部/运维/CI 与 REST 契约 | `POST /api/v1/outreach/webhook` | `chain.py:1955` | inbound 预留桩（501）；C13/G-5 已授权“不做/保持” |
| 保留 · 内部/运维/CI 与 REST 契约 | `POST /api/v1/trade-docs/*/confirm` | `ws_docs_ext.py:234` | A2 明示两条签发入口；前端走 `PATCH /trade-docs/{id}` |
| 保留 · 内部/运维/CI 与 REST 契约 | `POST /api/v1/trade-docs/*/files` | `ws_files.py:617` | REST 附件引用；前端上传走 `/files/upload`（服务端归档走内部函数） |
| 保留 · 内部/运维/CI 与 REST 契约 | `POST /api/v1/workstation-products` | `ws_products.py:458` | B6 兼容写口（同上） |
| 后端先行 · UI 未接 | `DELETE /api/v1/tax-archives/*` | `tax_archives.py:295` | 税务档案删除 UI 未接（前端只建/改） |
| 后端先行 · UI 未接 | `DELETE /api/v1/users/*/subscriptions/*` | `ws_workstations.py:271` | 同上 |
| 后端先行 · UI 未接 | `GET /api/v1/admin/archive-logs` | `main.py:3032` | C30：后端已从占位改真查询（`main.py:3032` 查 `events_archive_log`），前端 0 调用 |
| 后端先行 · UI 未接 | `GET /api/v1/file-objects/*/render-content` | `ws_files.py:920` | A4/G-4：渲染器短期直链（令牌即授权）；前端仍转 data URI |
| 后端先行 · UI 未接 | `GET /api/v1/fx-rates` | `ws_extras.py:162` | 汇率维护 UI 未接；前端只用 `/fx-rates/latest` |
| 后端先行 · UI 未接 | `GET /api/v1/orders/*/payment-schedules` | `main.py:3943` | 订单收款计划 UI 未接（orders 页自述“收款计划与应收概览”） |
| 后端先行 · UI 未接 | `GET /api/v1/receivables` | `main.py:4102` | 应收台账 UI 未接（订单工位规划里有概览） |
| 后端先行 · UI 未接 | `GET /api/v1/tenant/company-seals/*/render-content` | `ws_seals.py:221` | A4/G-4：公章渲染直链（同上） |
| 后端先行 · UI 未接 | `GET /api/v1/users/*/subscriptions` | `ws_workstations.py:229` | 个人订开通 UI 未接（前端只接团队订阅） |
| 后端先行 · UI 未接 | `PATCH /api/v1/payment-schedules/*` | `main.py:4008` | 同上（改计划） |
| 后端先行 · UI 未接 | `PATCH /api/v1/pricing-data/*` | `main.py:2291` | 定价数据编辑 UI 未接（前端只 POST 新增/删除） |
| 后端先行 · UI 未接 | `PATCH /api/v1/teams/*` | `ws_teams.py:245` | 团队改名 UI 未接 |
| 后端先行 · UI 未接 | `POST /api/v1/ai/tasks/*/run` | `chain.py:733` | AI 任务手动运行 UI 未接（ai-providers 页只做 provider/binding 管理） |
| 后端先行 · UI 未接 | `POST /api/v1/fx-rates` | `ws_extras.py:217` | 同上（手工录汇率） |
| 后端先行 · UI 未接 | `POST /api/v1/intel/import/csv` | `main.py:928` | 情报 CSV 导入 UI 未接 |
| 后端先行 · UI 未接 | `POST /api/v1/intel/shipments` | `main.py:913` | 情报手工录入 UI 未接（前端只读列表） |
| 后端先行 · UI 未接 | `POST /api/v1/leadgen/runs/from-csv` | `chain.py:1003` | leadgen 页文案已预告“CSV 导入使用该端点”，但无上传 UI（`leadgen/page.tsx:416`） |
| 后端先行 · UI 未接 | `POST /api/v1/leads` | `chain.py:1349` | 手工新增线索 UI 未接（前端用 leadgen run/crawl 链路） |
| 后端先行 · UI 未接 | `POST /api/v1/market/name-mappings` | `main.py:1716` | 中外品名对照维护 UI 未接 |
| 后端先行 · UI 未接 | `POST /api/v1/orders/*/payment-schedules` | `main.py:3961` | 同上（建计划） |
| 后端先行 · UI 未接 | `POST /api/v1/orders/*/status` | `main.py:3851` | 订单状态流转 API；前端只做展示（`PATCH /orders` 只接收条款/客户，见 `main.py:3707+`） |
| 后端先行 · UI 未接 | `POST /api/v1/research/products` | `chain.py:2232` | 调研手工录入 UI 未接（前端只 from-leadgen/PATCH/DELETE；MSW 有 handler 但真实调用 0） |
| 后端先行 · UI 未接 | `POST /api/v1/trade-docs/*/translate` | `ws_docs_ext.py:549` | A13：中译英端点已实现（`ws_docs_ext.py:549`），前端只有“AI 翻译”来源标签 |
| 后端先行 · UI 未接 | `PUT /api/v1/users/*/subscriptions/*` | `ws_workstations.py:243` | 同上 |
| 可删候选（需 owner 确认） | `DELETE /api/v1/external-docs/*` | `ws_extras.py:420` | 同上 |
| 可删候选（需 owner 确认） | `GET /api/v1/actual-costs` | `ws_extras.py:262` | 旧实际成本域：前端 0 调用、无文档引用；报价成本走 `quotes/cost-reference` |
| 可删候选（需 owner 确认） | `GET /api/v1/capabilities` | `main.py:3131` | 旧“客户能力”体系：前端 0 页面/调用（仅 audit-log 过滤文案 + MSW 残留）；清单在 `subscriptions.py` ALWAYS_ALLOWED |
| 可删候选（需 owner 确认） | `GET /api/v1/capability-customers` | `main.py:3109` | 同上（客户清单） |
| 可删候选（需 owner 确认） | `GET /api/v1/customer/*/capabilities` | `main.py:3193` | 同上（按客户读） |
| 可删候选（需 owner 确认） | `GET /api/v1/external-docs` | `ws_extras.py:362` | 旧“外部单据”上传域：前端 0 调用；A7 的 doc-set 回执已覆盖 not_by_us 场景 |
| 可删候选（需 owner 确认） | `GET /api/v1/external-docs/*/download` | `ws_extras.py:392` | 同上 |
| 可删候选（需 owner 确认） | `GET /api/v1/product-options/overrides` | `ws_option_overrides.py:170` | 旧“档位覆盖”体系：前端 0；已被租户产品定义/启用开关（B3/B6）取代 |
| 可删候选（需 owner 确认） | `PATCH /api/v1/customer/*/capabilities` | `main.py:3211` | 同上（按客户改；handler 注释称 is_active 无存储列） |
| 可删候选（需 owner 确认） | `PATCH /api/v1/external-docs/*` | `ws_extras.py:405` | 同上 |
| 可删候选（需 owner 确认） | `PATCH /api/v1/spec/prices/*` | `main.py:2515` | 旧规格库价格体系（`archive/README.md`：规格库 11 条已退役）；前端 0；pricing-data 取代 |
| 可删候选（需 owner 确认） | `POST /api/v1/actual-costs` | `ws_extras.py:284` | 同上 |
| 可删候选（需 owner 确认） | `POST /api/v1/actual-costs/resolve` | `ws_extras.py:311` | 同上 |
| 可删候选（需 owner 确认） | `POST /api/v1/capabilities` | `main.py:3153` | 同上（登记/更新） |
| 可删候选（需 owner 确认） | `POST /api/v1/external-docs` | `ws_extras.py:335` | 同上 |
| 可删候选（需 owner 确认） | `POST /api/v1/file-objects/upload` | `ws_files.py:1054` | 文档用途=客户流失拒绝文件（C1）；G-5 已授权不做 + 前端 0 调用 ⇒ 可删候选 |
| 可删候选（需 owner 确认） | `POST /api/v1/spec/skus/*/prices` | `main.py:2462` | 同上 |
| 可删候选（需 owner 确认） | `PUT /api/v1/product-options/overrides` | `ws_option_overrides.py:220` | 同上 |

## 3. 与 `docs/TODO.md` 的对应关系

| TODO | 相关路由（本清单） | 状态/说明 |
|---|---|---|
| **C36** | 本文件全部条目 | 本清单即 C36 的交付物；是否销账由 Lead 决定 |
| **A2** | `POST /trade-docs/{id}/confirm` | A2 已完成（两入口）；confirm 保留为 REST/第三方入口 |
| **A4 / G-4** | `GET /file-objects/{id}/render-content`、`GET /tenant/company-seals/{id}/render-content` | G-4 已选①「渲染器白名单放开走 R2 直链」；这两个直链端点即该方案的服务端口，前端待接 |
| **A7** | — | A7 的 facts/consistency/lint/receipts/doc-set/verify-export 均已由 FE 调用（不在本清单） |
| **A9** | `GET /trade-docs/render-fingerprint-checks/batch` | A9 已完成（cron+列表标识）；批量口保留给运维/批处理 |
| **A12** | `trigger_expr`（非路由） | A12 ⏳；与路由无关 |
| **A13** | `POST /trade-docs/{id}/translate` | A13 ⏳：端点已实现、前端 0 调用 |
| **B6** | `GET/POST /workstation-products` | B6 已完成（兼容 union）；建议与 `/tenant-product-status` 收敛后再删 |
| **C1 / G-5** | `POST /file-objects/upload` | C1 已授权“不做”；该端点用途仅 C1（流失拒绝文件）⇒ 可删候选 |
| **C9** | `GET /file-objects/_r2_debug`、`GET /fx-rates/_debug` | C9 已完成（admin 闸门）；保留运维 |
| **C13 / G-5** | `POST /outreach/webhook` | C13 🧭 已授权“保持”；501 预留桩 |
| **C19 / C29** | — | 批量导入 UI 已接（v2 报价工作台）；`/import/template` 在用（§2 非死），C29 占位入口已隐藏 |
| **C30** | `GET /admin/archive-logs` | C30 后端已从占位改真查询；前端 0 调用（待接 UI） |
| **C36** | 本文件 | 本次产出；若 Lead 采纳请把 C36 改 ✅ 并在 §0 记录本文件 |

## 4. 维护规则

1. 新增「后端先行」端点：加到本表对应分类，并在 `TODO.md` 用 C 组/任务号登记（本文件不代替账本）。
2. 接上 UI 后：把该行从本表移走（或改判定为“已接”），并在 §0 更新计数。
3. 删除端点前：先 `grep -R "路径片段" frontend/src scripts backend` 确认真 0 调用 + owner 确认；删后更新本表。
4. 重新扫描时用 §1 命令；数字变化（路由/FE 调用）要同步 §0。
