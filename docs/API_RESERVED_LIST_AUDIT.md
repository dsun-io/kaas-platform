# 后端先行 API 取证审计（C36 · 只分析不删）

> **✅ 2026-10-21 删除执行（用户已批准）**：本审计结论「可删（证据）3」已**执行删除**：
> `PATCH /api/v1/spec/prices/{id}`、`POST /api/v1/spec/skus/{id}/prices`、
> `POST /api/v1/file-objects/upload`。下方 #11/#16/#17 行与 §2.1/§4A 已同步标 ✅；
> 本文件其余"不删/需 owner 确认"结论不变（仅 3 条获批）。
>
> **给用户一次拍板用的决策表**：24 条「后端先行 · UI 未接」逐条给价值/成本/建议；18 条「可删候选」逐条给使用证据与结论。
> **本文件不授权删除、也没有删除任何代码**；`docs/API_RESERVED_LIST.md` 的判定本次**未改动**，只在顶部加了指向本文件的入口行。
>
> **✅ 2026-10-21 C36 UI 批次（`e419d01d`）**：§1 建议「**本期接 5**」的五条**已全部接上**
> （税档软删 / 定价编辑 / 团队改名 / 手工汇率 / leadgen CSV 上传，入口见 §1 各行的 ✅ 标注）；
> 因此「待接 UI」由 20 条降为 **15 条**（下期 12 + 长期保留 3）。路由计数不变（接 UI 不加路由）。
>
> - 扫描基线：`docs/API_RESERVED_LIST.md` @ `17e87744`（2026-10-21）
> - 复核基线：当前工作区 HEAD `62d2d2cb`（2026-10-21；并发改动只读扫描）
> - 方法：重扫 Worker 路由（`backend/worker/src/**` 的 `@app.<method>`）+ 抽取前端全部 `apiClient.*`/`fetch` 调用 220 条，
>   再逐条 `grep` 前端源码/测试/e2e/scripts/现行 docs + 读后端 handler/docstring/迁移 + `git log` 最近变更。
> - **局限（先说清）**：仓库内**无法**证明生产库表行数、第三方调用方、运维脚本调用方；凡此类条目一律落到「需 owner 确认」，不硬判可删。

## 0. 结论摘要

| 类别 | 数量 | 分布 |
|---|---|---|
| **24 条「待接 UI」** | 24 | **已接 4**（C30 归档日志、A13 翻译、A4 渲染直链 ×2）＋**本期接 5 ✅ 已接（2026-10-21 C36）**；**剩余 15**（下期 12 + 长期保留 3） |
| **18 条「可删候选」** | 18 | **✅ 已删除（C36 执行）3**；**保留（理由）2**；**需 owner 确认 13** |
| **需用户拍板** | **13 + 3（已处置）** | 13 条「需 owner 确认」仍在；3 条「可删」2026-10-21 已获批准并删除（见顶部） |

两个**必须纠正的清单判定**（详见 §3）：

1. **`GET/PUT /product-options/overrides` 不是"旧体系可删"**：它是**用户裁决过的现行团队级档位能力**（改显示名/软停用），
   Worker 于 2026-10-11 专门补齐（`f61a41db`），只是**前端 UI 还没接** ⇒ 应归「后端先行待接 UI」，不是「可删」。
2. **24 条里有 4 条在基线之后已经接上**：`GET /admin/archive-logs`（C30）、`POST /trade-docs/{id}/translate`（A13）
   已由前端调用；两个 `render-content` 直链已被 **A4 渲染链路**使用（浏览器加载图片/公章，不经 `apiClient`）
   ⇒ 这 4 条应从"待接"移出。

## 1. 24 条「后端先行 · UI 未接」逐条评估

- **价值**：高＝直接影响钱/合规/核心业务流；中＝效率/运维/数据质量；低＝边缘或可由现有入口替代。
- **成本**：低＝单点按钮/表单（≤1 天）；中＝一个面板或小页面（2–4 天）；高＝新页面/状态机/多接口联动（≥1 周，含测试与文档）。
- **建议**：`本期接` / `下期` / `长期保留` / `已接·移出`（后者不是待办）。

| # | 方法 · 路径 | 后端做什么（证据） | 前端现状/缺口（证据） | 价值 | 成本 | 建议 |
|---|---|---|---|---|---|---|
| 1 | `DELETE /api/v1/tax-archives/{id}` | 软删税务档案（`status='inactive'`，团队管理员校验；`tax_archives.py:295`） | 税务档案页只有 GET/POST/PATCH（`settings/tax-archives/page.tsx:121/164/170/187`），原**无删除入口** → **✅ 已接（2026-10-21 C36）**：`settings/tax-archives/components/tax-archive-deactivate-button.tsx:39`（确认后 DELETE，软删留档），页面 `page.tsx:434` 挂载 | 中（清理建错的税档；软删可审计） | 低（列表行加"停用"+确认，复用现有 dialog 模式） | **✅ 已接·移出** |
| 2 | `DELETE /api/v1/users/{id}/subscriptions/{code}` | 平台管理员撤销**用户级**工位订阅（`ws_workstations.py:271`） | 前端只有**团队级**订阅面板（`team/components/team-subscriptions-panel.tsx:70/88`）；无用户级订阅页 | 中（平台运维/客服撤权） | 中（管理员账号页加订阅子面板；先确认用户级订阅是否仍是有效模型） | 长期保留（团队级已覆盖主路径，用户级仅运维口） |
| 3 | `GET /api/v1/admin/archive-logs` | 事件归档记录真查询（C30；`main.py:3048`） | **已接**：`admin/hooks/use-archive-logs.ts:54` + `archive-logs-card.tsx`，灰发页已挂载（`admin/gray-release/page.tsx:80`） | — | — | **已接·移出** |
| 4 | `GET /api/v1/file-objects/{id}/render-content` | A4 渲染器短期签名直链（令牌即授权；`ws_files.py:920`，URL 在 `ws_files.py:900` 由装配层生成） | **已接（渲染链路）**：渲染数据里返回该直链，浏览器 `<img>` 直接加载（`ws_files.py:820/900`；`main.py:4801` 公章同理），不经 `apiClient` | — | — | **已接·移出** |
| 5 | `GET /api/v1/fx-rates` | 汇率历史列表（base/quote，最多 365 条；`ws_extras.py:162`） | 前端只用 `/fx-rates/latest`（`lib/fx/use-latest-fx.ts:26`），无历史页 | 中（汇率审计/回看；外部源异常时核对） | 中（小表格+筛选；可与 settings 合页） | 下期 |
| 6 | `GET /api/v1/orders/{id}/payment-schedules` | 读订单收款计划（`main.py:3959`） | 订单页只有列表/状态展示（`orders/page.tsx:64/293`；`orders/hooks/use-orders-list.ts`），无收款计划面板 | 高（收款节点/逾期判断） | 中（订单详情子面板 + 金额/状态展示） | 下期 |
| 7 | `GET /api/v1/receivables` | 应收台账（分页；`main.py:4118`） | 前端无应收页面/调用（220 条调用扫描 0 命中） | 高（现金流/催收） | 高（新页面：筛选/汇总/逾期） | 下期 |
| 8 | `GET /api/v1/tenant/company-seals/{id}/render-content` | A4 公章签名直链（令牌即授权；`ws_seals.py:221`） | **已接（渲染链路）**：装配层优先填该直链（`main.py:4801`），浏览器加载 | — | — | **已接·移出** |
| 9 | `GET /api/v1/users/{id}/subscriptions` | 平台管理员读用户级订阅（`ws_workstations.py:229`） | 前端无用户级订阅页（同 #2） | 中（运维排查） | 中（同 #2，同一面板三接口） | 长期保留（同 #2） |
| 10 | `PATCH /api/v1/payment-schedules/{id}` | 改收款计划（金额/日期；`main.py:4024`） | 无收款计划 UI（同 #6） | 高（同一业务流） | 中（并入 #6 面板） | 下期 |
| 11 | `PATCH /api/v1/pricing-data/{id}` | 改定价矩阵一项（金额/单位/生效/备注；`main.py:2307`） | 定价页只有 GET/POST/DELETE（`pricing-data/hooks/use-pricing-data.ts:22/36/50`），原**无编辑** → **✅ 已接（2026-10-21 C36）**：`use-pricing-data.ts:83`（PATCH）+ `PricingEditDialog.tsx`（`PricingDataTable.tsx:207` 编辑按钮），`pricing-data-manager.tsx:221` 挂载 | 高（改错价/缩短生效期，现只能删了重建） | 低（复用编辑弹窗，调 PATCH） | **✅ 已接·移出** |
| 12 | `PATCH /api/v1/teams/{id}` | 团队改名（`ws_teams.py:245`） | 团队页只有创建/加入（`team/components/team-setup.tsx`），原无改名入口（220 条扫描无 PATCH /teams） → **✅ 已接（2026-10-21 C36）**：`team/components/team-rename-dialog.tsx:57`（PATCH `{name}`），`team/page.tsx:179` 挂载（仅团队管理员） | 中（团队名是单据/报表展示名） | 低（团队设置一个输入+保存） | **✅ 已接·移出** |
| 13 | `POST /api/v1/ai/tasks/{key}/run` | 手动跑 AI 任务（`chain.py:733`） | AI provider 页只做 provider/binding 管理；无"运行任务"按钮 | 中（运维/调试/补跑） | 中（任务表单+结果展示，任务 payload 各不相同） | 下期 |
| 14 | `POST /api/v1/fx-rates` | 手工录汇率（`ws_extras.py:217`） | 前端原只用 latest，无录入入口 → **✅ 已接（2026-10-21 C36）**：`lib/fx/use-manual-fx.ts:40`（POST，同日同币对 UPSERT）+ `settings/tax-archives/components/fx-rate-card.tsx`，`tax-archives/page.tsx:613` 挂载 | 中（外部源故障时兜底；审计留痕） | 低（单表单：日期/币种/值） | **✅ 已接·移出** |
| 15 | `POST /api/v1/intel/import/csv` | 情报货运 CSV 导入（`main.py:944`） | 情报页只读列表（`use-intel.ts:77/90`），无导入 | 中（批量补数据，手工录太慢） | 中（上传+列映射+错误报告） | 下期 |
| 16 | `POST /api/v1/intel/shipments` | 手工新增情报货运（`main.py:929`） | 前端只读列表（同 #15） | 中（少量补录） | 中（表单+校验，字段多） | 下期 |
| 17 | `POST /api/v1/leadgen/runs/from-csv` | 从 CSV 创建 leadgen run（`chain.py:1003`） | 页面文案已**承诺**该能力（`leadgen/page.tsx:416`），原无上传控件/调用 → **✅ 已接（2026-10-21 C36）**：`lib/leadgen/csv-import.ts` + `leadgen/components/csv-import-panel.tsx:54`（multipart 字段 `csv_file`），`leadgen/page.tsx:426` 挂载 | 中（批量线索是 leadgen 主入口） | 低（multipart 上传 + 刷新 run 列表） | **✅ 已接·移出** |
| 18 | `POST /api/v1/leads` | 手工新增线索（`chain.py:1349`） | 线索页用 scan-replied/crawl/批量，**无"新建线索"**；220 条扫描无裸 POST /leads | 中（展会/老客户等手工来源） | 中（线索表单+去重提示） | 下期 |
| 19 | `POST /api/v1/market/name-mappings` | 新增中外品名对照（`main.py:1732`） | 市场页只读/查询，无维护入口 | 中（品名匹配准确率） | 中（对照表 CRUD 小页面） | 下期 |
| 20 | `POST /api/v1/orders/{id}/payment-schedules` | 建收款计划（`main.py:3977`） | 无收款计划 UI（同 #6） | 高 | 中（并入 #6） | 下期 |
| 21 | `POST /api/v1/orders/{id}/status` | 订单状态机流转（确认建应收、发货发跨工位事件；`main.py:3867`） | 订单页只显示状态/筛选（`orders/page.tsx:52/293`），无流转按钮；前端只有 `PATCH /orders/{id}`（字段编辑） | 高（订单全链路推进/事件联动） | 中（按钮+确认+刷新；状态机规则需照后端） | 下期 |
| 22 | `POST /api/v1/research/products` | 手工录入调研产品（`chain.py:2232`；含从线索挑选） | 调研页只 GET/PATCH/DELETE（`research` 页面调用扫描；无 POST） | 中（无线索时的补录） | 中（表单，字段多） | 下期 |
| 23 | `POST /api/v1/trade-docs/{id}/translate` | 单证字段中译英（A13；`ws_docs_ext.py:549`） | **已接**：`use-trade-docs.ts:241` + `doc-translate-panel.tsx:66`，经 `doc-hardening-section.tsx:79` 挂载；A13 已销账 | — | — | **已接·移出** |
| 24 | `PUT /api/v1/users/{id}/subscriptions/{code}` | 平台管理员开通用户级订阅（`ws_workstations.py:243`） | 同 #2/#9 | 中 | 中 | 长期保留（同 #2） |

### 1.1 分布小结

- **已接/移出 4**：#3 归档日志（C30）、#23 翻译（A13）、#4/#8 渲染直链（A4 渲染链路）。
  ⇒ 「待接 UI」由 24 降到 **20 条**。
- **✅ 本期接 5 已全部落地（2026-10-21 C36 UI 批次 `e419d01d`）**：#1 税档停用、#11 定价编辑、#12 团队改名、
  #14 手工汇率、#17 leadgen CSV（入口逐条见 §1 的 ✅ 标注）。
  ⇒ 「待接 UI」再降到 **15 条**（下期 12 + 长期保留 3）；**接 UI 不改变路由数**（Worker 仍 244）。
- **下期 12**：#5 汇率历史、#6/#10/#20 收款计划三件套、#7 应收台账、#13 AI 任务运行、#15/#16 情报导入/补录、
  #18 手工线索、#19 品名对照、#21 订单状态流转、#22 调研补录。
- **长期保留 3**：#2/#9/#24 用户级订阅（平台运维口；团队级订阅已是主路径，是否值得做 UI 需产品确认）。
- **未计入上表的 2 条**：审计 §4C 建议把 `GET/PUT /product-options/overrides` 从「可删候选」更正为
  「现行团队级档位能力、待接 UI（下期）」；本表 15 条仍按原 24 条清单统计，**下次重扫时并入**。

## 2. 18 条「可删候选」逐条证据与结论

**证据口径**：FE-src（`frontend/src/**` 的 `apiClient.*`/`fetch`）、FE-e2e、scripts、backend tests、现行 docs（`docs/**` 非本清单）、git 最近变更、迁移/表。
`test_worker_routes.py` / `test_parity_quote.py` 里的路由清单是**测试固定资产**（删路由必须同步改），不算业务使用。

| # | 方法 · 路径 | 后端/存储（证据） | 使用证据（引用） | 结论 |
|---|---|---|---|---|
| 1 | `DELETE /api/v1/external-docs/{id}` | 外部单证上传域，删 `external_doc_uploads` 行（`ws_extras.py:420`；表见迁移 `202610100005_external_doc_uploads.py:22`、`scripts/prod-schema-columns.json:366`） | FE/e2e/scripts/现行 docs **均 0**；仅历史 release 文档提及（`docs/archive/.../RELEASE_2026-10-10_quote_model.md`）。无测试引用。 | **需 owner 确认（单证/数据 owner）**：A7 doc-set 回执已覆盖 not_by_us；但表里可能有历史上传数据 ⇒ 建议只删路由、表留档，需数据 owner 确认 |
| 2 | `GET /api/v1/actual-costs` | 实际采购成本列表（`actual_procurement_costs`；`ws_extras.py:262`；迁移 `202610100002`、prod schema 有表） | FE/e2e/scripts/现行 docs 0；历史 release 文档提及；报价成本已走 `quotes/cost-reference`（无测试引用） | **需 owner 确认（报价/成本 owner）**：历史采购成本是否留档/是否还有对账价值 |
| 3 | `GET /api/v1/capabilities` | 旧客户能力（`customer_capabilities`；`main.py:3147`） | FE 无页面/调用；但有**契约与 mock 残留**：`shared/contracts/capabilities.ts`、`frontend/src/mocks/handlers.ts:70`、`frontend/src/lib/form/__tests__/contracts-capabilities.test.ts:2`；worker 路由测试 `test_worker_routes.py:95-96` | **需 owner 确认（客户/产品 owner）**：旧能力体系是否彻底废弃；若删需连契约+MSW+测试一起清 |
| 4 | `GET /api/v1/capability-customers` | 能力客户清单（同表聚合；`main.py:3125`） | FE 0；worker 路由测试 `test_worker_routes.py:94` | **需 owner 确认（客户/产品 owner）**（同 #3） |
| 5 | `GET /api/v1/customer/{id}/capabilities` | 按客户读能力（`main.py:3209`） | FE 0；worker 路由测试 `test_worker_routes.py:97` | **需 owner 确认（客户/产品 owner）**（同 #3） |
| 6 | `GET /api/v1/external-docs` | 外部单证列表（`ws_extras.py:362`） | 同 #1 | **需 owner 确认（单证/数据 owner）** |
| 7 | `GET /api/v1/external-docs/{id}/download` | 下载外部单证字节（`ws_extras.py:392`） | 同 #1 | **需 owner 确认（单证/数据 owner）** |
| 8 | `GET /api/v1/product-options/overrides` | **现行**团队级档位（改显示名/软停用；`ws_option_overrides.py:170`，存储 `team_option_overrides`，前端 UI 未接） | 证据表明**不是旧体系**：用户裁决"团队档位仍应是管理员"（`docs/archive/2026-10-17-doc-cleanup/PRODUCT_MODULE_P1_REPORT.md` §4.4，引 `PRODUCT_MODULE_DECISIONS.md:81,93`）；Worker 2026-10-11 专门补齐以免线上 404（`f61a41db`，`ws_option_overrides.py` 头注释）；FE 0 调用 = UI 未接 | **保留（理由：用户裁决过的现行团队档位能力，UI 待接）** ⇒ 应移入「待接 UI」清单（建议下期接） |
| 9 | `PATCH /api/v1/customer/{id}/capabilities` | 按客户写能力（`main.py:3227`；handler 注释 `is_active` 无存储列） | FE 0；worker 路由测试 `test_worker_routes.py:98` | **需 owner 确认（客户/产品 owner）**（同 #3） |
| 10 | `PATCH /api/v1/external-docs/{id}` | 改外部单证状态/备注（`ws_extras.py:405`） | 同 #1 | **需 owner 确认（单证/数据 owner）** |
| 11 | `PATCH /api/v1/spec/prices/{id}` | 旧规格库价格更新（`product_sku_prices`；`main.py:2531`） | **用户已裁决规格库退役**（"写死的设计没用了"，`docs/PROBLEM_STATUS_2026-10-11.md:1555`；更正说明 `:1618-1658`）；11 条接口 FE 0、对应 7 张表**生产实测全 0 行**（`:1658`）；已被定价数据取代（`:1685`）；仅 `test_worker_routes.py:80`/`test_parity_quote.py` 钉路由 | ✅ **已删除（2026-10-21 C36 执行）**：handler 已移除、路由测试改负向断言；表留待统一清 |
| 12 | `POST /api/v1/actual-costs` | 新增实际成本（`ws_extras.py:284`） | 同 #2 | **需 owner 确认（报价/成本 owner）** |
| 13 | `POST /api/v1/actual-costs/resolve` | 实际成本换算（纯计算，`ws_extras.py:311`） | 同 #2（FE 0） | **需 owner 确认（报价/成本 owner）**：若成本域整体废弃可直接删；否则保留 |
| 14 | `POST /api/v1/capabilities` | 登记/更新能力（`main.py:3169`） | 同 #3 | **需 owner 确认（客户/产品 owner）** |
| 15 | `POST /api/v1/external-docs` | 上传外部单证（写 `external_doc_uploads.content`；`ws_extras.py:335`） | 同 #1 | **需 owner 确认（单证/数据 owner）** |
| 16 | `POST /api/v1/file-objects/upload` | 通用 multipart 上传，docstring 明示"供客户流失拒绝文件等使用"（`ws_files.py:1054`） | **用户已授权 C1 不做**（`docs/TODO.md:119` "用户 2026-10-21 授权默认：不做"；G-5 `:225`）；FE 0 调用（产品图走 presign/register：`lib/products/use-products.ts`，`use-products.test.ts:193/194`）；仅 worker 集成测试引用 `backend/worker/tests/test_files_db_integration.py:284`（删时改测试） | ✅ **已删除（2026-10-21 C36 执行）**：handler 已移除；bytea 往返集成测试改用仍保留的 `POST /trade-docs/{id}/files/upload`（覆盖不降级）；已有文件对象保留 |
| 17 | `POST /api/v1/spec/skus/{id}/prices` | 旧 SKU 价格新增（`main.py:2478`） | 同 #11（用户裁决退役 + 生产 7 表 0 行 + FE 0；`test_worker_routes.py:79` 钉路由） | ✅ **已删除（2026-10-21 C36 执行）**：handler 已移除；`_upsert_price` 仅保留给 `/spec/wizard/submit` 带价路径 |
| 18 | `PUT /api/v1/product-options/overrides` | **现行**团队档位写口（`ws_option_overrides.py:220`；团队管理员） | 同 #8 | **保留（理由：现行团队档位能力，UI 待接）** |

### 2.1 18 条结论分布

- **✅ 已删除 3（2026-10-21 C36 执行，用户已批准）**：#11 `PATCH /spec/prices/{id}`、#16 `POST /file-objects/upload`、#17 `POST /spec/skus/{id}/prices`。
  路由已移除、worker 路由测试改**负向断言**（防止回补）、`/file-objects/upload` 的集成测试改用仍保留的单证回传上传。
- **保留（理由）2**：#8 `GET /product-options/overrides`、#18 `PUT /product-options/overrides`（用户裁决过的现行团队档位，**应移入待接 UI，不是删**）。
- **需 owner 确认 13**：#1/#6/#7/#10/#15（外部单证域 5 条，数据 owner）、#2/#12/#13（实际成本域 3 条，成本 owner）、
  #3/#4/#5/#9/#14（客户能力域 5 条，客户/产品 owner）。

## 3. 与 `docs/API_RESERVED_LIST.md` 的差异与更正

1. **C30/A13/A4 已落地，4 条"待接"过时**：
   - `GET /admin/archive-logs` → `admin/hooks/use-archive-logs.ts:54`；
   - `POST /trade-docs/{id}/translate` → `use-trade-docs.ts:241` + `doc-hardening-section`（`doc-hardening-section.tsx:79` 挂载 `DocTranslatePanel`）；
   - `GET /file-objects/{id}/render-content`、`GET /tenant/company-seals/{id}/render-content` → A4 装配层生成签名直链
     （`ws_files.py:900`、`main.py:4801`），浏览器直接加载，**不是前端 apiClient 未接**。
2. **`product-options/overrides` 两条被清单误判为"旧体系可删"**：见 §2 #8/#18 证据（用户裁决 + 后续专门补齐 + 现行存储表），
   应改归「后端先行待接 UI」。这是本次审计**最重要的清单修正**。
3. **`POST /file-objects/upload` 的"前端上传 UI 已存在"是过时叙述**：`docs/archive/.../HANDOVER_2026-10-17.md:52`
   曾记录加了 UI，但当前全仓 FE 0 调用；结合 C1「不做」授权 ⇒ 可删（路由）。
4. **规格库删除证据比清单写的更强**：清单只说"前端 0 + archive 说退役"，本审计补到「用户裁决 + 生产 7 表 0 行实测」，
   但**表行数需在删除前重新实测**（该测量发生在 2026-10-12，生产可能变化）。

## 4. 一次拍板建议（给用户）

**A. 建议直接批准的「可删（3）」—— ✅ 已批准并执行（2026-10-21 C36，路由 247→244）**
（只删路由；相应表/历史数据保留，删除时同步改 worker 路由测试与 allowlist）：

> ✅ **2026-10-21 已获用户批准并执行完毕**（C36）：三条 handler 已移除、worker 路由测试改负向断言；
> 本节保留供追溯；**当前状态以 §0 计数与 §1.1 分布为准**（可删候选 3 已删 / 保留 2 / owner 13）。

- `PATCH /api/v1/spec/prices/{id}`、`POST /api/v1/spec/skus/{id}/prices`（规格库退役，用户已裁决，生产 7 表 0 行）
- `POST /api/v1/file-objects/upload`（C1 已授权不做，无前端调用）

**B. 需要业务 owner 拍板「13」**（删路由前确认：生产表是否留数据、是否有第三方/脚本调用、契约/mock 是否一起清）：

- 外部单证域 5 条：`GET/POST/PATCH/DELETE /external-docs*`、`GET /external-docs/{id}/download`
- 实际成本域 3 条：`GET/POST /actual-costs`、`POST /actual-costs/resolve`
- 客户能力域 5 条：`GET /capabilities`、`GET /capability-customers`、`GET/PATCH /customer/{id}/capabilities`、`POST /capabilities`

**C. 建议保留并补进「待接 UI」的 2 条**：`GET/PUT /product-options/overrides`（团队档位；建议下期接管理 UI）。

**D. 待接 UI 的优先级建议**：先做 **5 条本期（✅ 已于 2026-10-21 C36 全部接上，见 §1）**，
再做订单/收款/应收与订单状态流转（#6/#7/#10/#20/#21，业务价值最高但成本也高），其余下期。

## 5. 复现与口径

```powershell
# 1) 路由 vs 前端调用（本次抽取到 220 条 apiClient/fetch 调用）
#    路由：@app.<method> 于 backend/worker/src/**；前端：frontend/src/** 的 apiClient.* / fetch
# 2) 单条证据（示例）
Get-ChildItem frontend/src -Recurse -File -Include *.ts,*.tsx | Select-String -Pattern 'tax-archives'
Get-ChildItem backend/worker/src -Recurse -File -Include *.py | Select-String -Pattern '@app\.delete\("/api/v1/tax-archives'
git log -3 --date=short -- backend/worker/src/ws_option_overrides.py
```

- 本审计**没有**任何代码/测试/TODO 改动；`docs/TODO.md` 未改；未 commit。
- 工作区当时有并发改动（HEAD `62d2d2cb`），路由/前端调用数字以该时刻为准；**删除动作已执行**
  （2026-10-21 C36，3 条），后续复核请以 `git grep` 的 0 引用 + worker 路由测试的负向断言为准。
