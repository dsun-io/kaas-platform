# 剩余 passthrough 处置表（87 条）· P3 收尾规划（2026-10-24 20:50）

> 数据来源：`backend/ts-migration/routes.json`（280 业务路由 = 193 直接 + **87 透传**）× `src/index.ts` 的 12 个
> `createProxyApp` 前缀。本表把 87 条逐条归类，作为 P3 收尾的唯一待办清单。
> 状态：**进行中**（每迁移/放量一条，就把该行状态改掉；已完成项标 ✅）。

## 0. 口径（先对齐再干活）
- **已迁移 ≠ 已消失**：迁移后内核仍保留旧 handler（作为 `AUTH_DB_SPLIT=off` 的回退）。所以 routes.json 里仍会列出；
  本表按「门面是否已直连/已切片」判状态。
- **三类终点**：① 门面直连（纯 SQL）② 引擎切片（TS 供数 → 内核纯算）③ **保持 Python**（字节/PDF/AI 执行/cron）或
  **方案 A 例外**（跨表事务写）。

## 1. 总览

| 分类 | 条数 | 说明 |
|---|---|---|
| 已迁移并放量 | 24 | quotes 列表/详情、quotations、tax-archives、product-tax-rates、external-docs 列表、trade-docs files、render-data、fx-rates（本轮）、P0 五条、引擎 6 切片 |
| 已迁移未放量 | 5 | tax-archives 写 3 条 + product-tax-rates 写 2 条（等分支环境冒烟） |
| 可迁·引擎切片（只读需计算） | 剩约 6 | trade-docs 列表/详情/事实/一致性/内容版本、pricing-data、export-quote products/template-info、quotes 三个参考读、render-fingerprint |
| 可迁·纯 SQL（门面直连） | 剩约 4 | AI 四读、fx-rates/latest、_debug、clause-templates（含懒种子写，需显式保留） |
| **方案 A 例外**（跨表事务写） | 49 写 − 8 已迁 = 41 | 取号/状态机/多表同事务（见 P2 §7） |
| **保持 Python** | 4 | `/external-docs/{id}/download`（字节流）、`/trade-docs/{id}/receipts`、`/doc-set`（Python 计算）、cron 2 条 |

## 2. GET（38 条）逐条处置

| 端点 | 真源 | 处置 | 状态 |
|---|---|---|---|
| GET /quotations | main.py:2504 | 门面直连 | ✅ 已放量 |
| GET /pricing-data | main.py:2655 | 引擎切片 | ⏳ 待排期 |
| GET /events | main.py:3278 | 纯 SQL | ⏳ 待审计 |
| GET /trade-docs | main.py:5340 | 引擎切片 | ✅ 已放量（第五批） |
| GET /trade-docs/{id} | main.py:5718 | 引擎切片 | ✅ 已放量（第五批） |
| GET /trade-docs/{id}/render-data | main.py:6225 | 引擎切片 | ✅ 已放量 |
| GET /ai/providers · /ai/usage | chain.py | 纯 SQL | ✅ 已放量（ai-read） |
| GET /ai/tasks · /ai/task-bindings | chain.py | **留内核**（TASKS 目录=业务元数据，ADR-008） | — |
| GET /export-quote/products | quote_api.py:444 | 引擎切片 | ✅ 已放量（catalog 批） |
| GET /export-quote/products/{key}/formulas | quote_api.py:477 | 引擎切片 | ✅ 已放量 |
| GET /export-quote/terms/template | quote_api.py:510 | **留内核**（条款模板=业务知识，ADR-008） | — |
| GET /export-quote/products/{key}/import-template | quote_api.py:1070 | 引擎切片（JSON 分支） | ✅ 已放量；**产文件分支留内核** |
| GET /export-quote/import/order/template-info | quote_api.py:1118 | 引擎切片 | ✅ 已放量（catalog 批） |
| GET /quotes · /quotes/{id} | quote_api.py:1771/2202 | 引擎切片 | ✅ 已放量 |
| GET /quotes/product-name-preference | quote_api.py:1955 | 引擎切片（候选集+内核同序首命中） | ✅ 已放量（catalog 批） |
| GET /quotes/reference-price · /cost-reference | quote_api.py:2026/2121 | 纯 SQL（中位数 TS 函数） | ✅ 已放量（ai-read 批） |
| GET /export-quote/products/{key}/spec | quote_api.py:2409 | 引擎切片 | ✅ 已放量 |
| GET /fx-rates | ws_extras.py:163 | 门面直连 | ✅ 本轮放量（A 决策） |
| GET /fx-rates/latest | ws_extras.py:180 | 纯 SQL（含回填写） | ⏳ 待排期（写副作用需显式保留） |
| GET /fx-rates/_debug | ws_extras.py:197 | 纯 SQL（管理员） | ⏳ 待排期 |
| GET /external-docs | ws_extras.py:363 | 门面直连（已修隔离） | ✅ 已放量 |
| GET /external-docs/{id}/download | ws_extras.py:393 | **保持 Python**（字节流） | — |
| GET /trade-docs/{id}/facts | ws_docs_hardening.py:600 | 引擎切片 | ⏳ 待排期 |
| GET /trade-docs/{id}/consistency | ws_docs_hardening.py:770 | 引擎切片 | ⏳ 待排期 |
| GET /trade-docs/{id}/receipts | ws_docs_hardening.py:1048 | **保持 Python**（decimal/可见性计算） | — |
| GET /trade-docs/{id}/doc-set | ws_docs_hardening.py:1217 | **保持 Python**（extract_facts + 触发条件） | — |
| GET /trade-docs/{id}/render-fingerprint-check | ws_docs_ext.py:384 | 引擎切片 | ⏳ 待排期 |
| GET /trade-docs/render-fingerprint-checks/batch | ws_docs_ext.py:438 | 引擎切片 | ⏳ 待排期 |
| GET /trade-docs/{id}/content-versions · /{version_no} | ws_docs_ext.py:625/659 | 纯 SQL | ⏳ 待排期 |
| GET /clause-templates | ws_clause_templates.py:192 | 纯 SQL（**含懒种子写**，需显式保留） | ⏳ 待排期 |
| GET /trade-docs/{id}/files | ws_files.py:642 | 门面直连 | ✅ 已放量 |
| GET /tax-archives | tax_archives.py:202 | 门面直连 | ✅ 已放量 |
| GET /product-tax-rates | tax_archives.py:372 | 门面直连 | ✅ 已放量 |

## 3. 写（49 条）处置

| 端点组 | 条数 | 处置 |
|---|---|---|
| tax-archives POST/PATCH/DELETE | 3 | ✅ 已迁移（**未放量**，等分支冒烟） |
| product-tax-rates POST/PATCH | 2 | ✅ 已迁移（**未放量**） |
| quotes POST/POST-batch/PATCH/PUT-items | 4 | 方案 A（跨表事务：报价单+行项+单证） |
| trade-docs POST/PATCH/{id}/confirm/issue/void/facts PATCH/content-versions 回滚等 | ~15 | 方案 A |
| export-quote POST products/import/order/*（导入落库） | ~5 | 方案 A（导入事务） |
| pricing-data POST/PATCH/DELETE | 3 | 待审计（若单表可迁） |
| fx-rates POST | 1 | 纯 SQL 写（管理员配置）→ 可迁 |
| clause-templates POST/PATCH/DELETE | 3 | 含懒种子语义 → 待定 |
| external-docs POST（上传）/PATCH/DELETE | 3 | 上传=multipart 字节 → 保持 Python；PATCH/DELETE 已修隔离但未迁 |
| 其余（ai/* 写、doc-set 生成、receipts 生成） | 剩余 | 保持 Python / 方案 A |

> 结论：**49 条写里只有 8 条能在门面安全直连**（已完成 5），其余 41 条属方案 A 例外，会在内核长期保留 DB 事务。

## 4. 这张表怎么用
1. 每轮挑 1–2 组「可迁」项做完并放量，把状态改成 ✅；
2. 当「可迁」只剩 0 条时，P3 进入收尾：白名单默认 on → 删透传 mount → 删内核已迁 handler → 删 `platform/db.py`/`get_current_user`；
3. 方案 A 例外清单（41 条）与保持 Python 清单（4 条）要在 P3 收尾时**写进内核的 README/docs**，避免后人误删。
## 5. 进度快照（2026-10-24 21:10）
- **本轮再放量 8 条**：fx-rates（A 决策）、ai.providers、ai.usage、quotes.reference-price、quotes.cost-reference、
  trade-docs.list、trade-docs.detail、export-quote.{products,import-template,order-template-info}、quotes.product-name-preference（合计 10 条 route id）。
- **线上证据**：内核 tail 只收到 6 条 `/api/v1/internal/engine/*` 纯计算 RPC —— 无任何业务查询打到内核。
- **剩余可迁**：引擎切片约 6 条（pricing-data、facts、consistency、render-fingerprint ×2、content-versions ×2 视审计）、
  纯 SQL 约 4 条（events、content-versions、fx-rates/latest、_debug、clause-templates 含懒种子）。
- **保持 Python / 留内核**：external-docs 下载（字节）、receipts、doc-set、ai/tasks、ai/task-bindings、terms/template、
  import-template 产文件分支、cron 2 条。
- **方案 A 例外**：41 条写事务（内核长期保留 DB）。
## 6. 迁移进度终局评估（2026-10-24 21:35）

### 已完成（本任务内新增 40+ 条 route id 直连/切片）
P0 五条热读、认证域 parity、**引擎切片 12 条**（calculate / verify / formulas / spec / explain / render-data /
quotes.list / quotes.detail / trade-docs.list / trade-docs.detail / export-quote.products / import-template /
order-template-info / quotes.product-name-preference / pricing-data / trade-docs.facts / trade-docs.consistency）、
**纯 SQL 直连 10 条**（quotations / tax-archives / product-tax-rates / external-docs / trade-docs.files / fx-rates /
ai.providers / ai.usage / quotes.reference-price / quotes.cost-reference / events / trade-docs.content-versions×2）、
**写路径 6 条**（tax-archives / product-tax-rates 的 create/update/delete）。

### 剩余（全部属三种终点之一，无「待定」）
| 类别 | 条数 | 处置 |
|---|---|---|
| 方案 A 例外（跨表事务写） | 41 | **永久保留内核 DB**（取号/状态机/多表同事务），登记后不再迁 |
| 保持 Python（字节/PDF/AI 执行/cron/出站探针） | ~10 | external-docs 下载、receipts、doc-set、ai/tasks、ai/task-bindings、terms/template、fx-rates/latest（含回填）、fx-rates/_debug（出站探针）、clause-templates（懒种子）、cron ×2 |
| 低价值待定 | 1 | render-fingerprint-check 单张（依赖完整 render 装配 + 时间相关，价值/成本比最差）⇒ **按决策留内核** |
| batch 指纹 | 1 | render-fingerprint-checks/batch（50×7 dataset = 新批量契约）⇒ **留内核/另立项** |

> 结论：**「可迁」清单已清空**。P3 剩下的不是「再迁几条」，而是**收尾四步**（下文 §7）。

## 7. P3 收尾执行手册（下一步，需按顺序）

### 步骤 1：观察期（当前所处位置）
- 所有已迁路由已在生产运行；观察错误率（`scripts/check-kernel-error-rate.py` + GitHub 每 15 分钟 kernel-health）与用户反馈；
- 判据：连续 24h 无「迁移相关」回归（对照 tail / 5xx / 前端报错）。

### 步骤 2：例外清单落盘（可立即做，无风险）
- 把「方案 A 41 条 + 保持 Python ~10 条」写进 `backend/worker/src/README` 或 docs 的**内核 DB 使用白名单**，
  并在内核 CI 加一条静态断言：**除白名单外不允许新增 `_acquire`/`db.fetch` 调用**（防回潮）。

### 步骤 3：删双份（迁移后清理）
- 对**已放量且稳定**的 route id：删除内核对应 handler（否则永远有两份实现，漂移风险）；
- 每删一批必须：先确认白名单里该 id 是 on（否则 off 回退会 404）、跑 worker 全量、观察一轮线上；
- 删除顺序建议：只读直连 → 引擎切片（handler 改为只保留 RPC 入口）→ 写路径。

### 步骤 4：删依赖（最终目标）
- 当内核剩余 DB 调用**全部落在例外白名单内**时：
  1. 删 `platform/db.py` 之外的所有非白名单调用点；
  2. `get_current_user` 仍需保留（例外清单里的端点仍要鉴权）⇒ **P3 的终点不是「零 DB」，而是「DB 只服务例外清单」**；
  3. 因此真正的收益是：**90%+ 的请求路径不再触发 Pyodide 里的 DB/鉴权初始化**，冷启动面大幅缩小。

> ⚠️ 重要澄清（避免误判完成）：P3 原目标写「删除 platform/db.py、get_current_user、bcrypt/jwt 依赖」，
> 但按方案 A 的裁决，**41 条写事务 + 10 条保持 Python 的端点永远需要 DB 与鉴权** ⇒ 该目标要修订为
> 「DB/鉴权只在内核的例外清单内出现」。这个修订必须写进 ARCH 文档，否则交接时会以为目标没达成。
## 8. 步骤 3 精确清单：25 个可删的内核 GET handler（2026-10-24 21:50 生成）

> 生成口径：`routes.json`（280 业务路由）× `wrangler.jsonc` 白名单里**已放量的只读 route id**，取同名路径的 GET handler。
> 未在内核找到 0 条（口径自洽）。**同路径的写方法必须保留**（下表的「同路径其它方法」列为 `-` 才可整段删除）。

| # | route id | 端点 | 内核位置 | 同路径其它方法 |
|---|---|---|---|---|
| 1 | notifications.unread-count | GET /api/v1/notifications/unread-count | ws_approvals.py:618 | - |
| 2 | approvals.list | GET /api/v1/approvals | ws_approvals.py:478 | - |
| 3 | products.list | GET /api/v1/products | ws_files.py:385 | - |
| 4 | products.profile | GET /api/v1/products/{key}/profile | ws_files.py:438 | PUT（保留） |
| 5 | products.media | GET /api/v1/products/{key}/media | ws_files.py:503 | POST（保留） |
| 6 | inquiries.list | GET /api/v1/inquiries | ws_crm_ext.py:303 | - |
| 7 | inquiries.detail | GET /api/v1/inquiries/{id} | ws_crm_ext.py:402 | PATCH（保留） |
| 8 | inquiries.stage-log | GET /api/v1/inquiries/{id}/stage-log | ws_crm_ext.py:609 | - |
| 9 | quotations.list | GET /api/v1/quotations | main.py:2504 | - |
| 10 | tax-archives.list | GET /api/v1/tax-archives | tax_archives.py:202 | POST/PATCH/DELETE（**已迁移到门面但内核保留 off 回退**，见下 ⚠️） |
| 11 | product-tax-rates.list | GET /api/v1/product-tax-rates | tax_archives.py:372 | POST/PATCH/DELETE（同上） |
| 12 | external-docs.list | GET /api/v1/external-docs | ws_extras.py:363 | POST/PATCH/DELETE（保留） |
| 13 | fx-rates.list | GET /api/v1/fx-rates | ws_extras.py:163 | POST（保留） |
| 14 | ai.providers | GET /api/v1/ai/providers | chain.py:583 | - |
| 15 | ai.usage | GET /api/v1/ai/usage | chain.py:710 | - |
| 16 | quotes.reference-price | GET /api/v1/quotes/reference-price | quote_api.py | - |
| 17 | quotes.cost-reference | GET /api/v1/quotes/cost-reference | quote_api.py | - |
| 18 | events.list | GET /api/v1/events | main.py:3292 | - |
| 19 | quotes.list | GET /api/v1/quotes | quote_api.py:1771 | POST/POST-batch（保留） |
| 20 | quotes.detail | GET /api/v1/quotes/{id} | quote_api.py:2202 | PATCH/PUT-items（保留） |
| 21 | trade-docs.list | GET /api/v1/trade-docs | main.py:5340 | POST（保留） |
| 22 | trade-docs.detail | GET /api/v1/trade-docs/{id} | main.py:5718 | PATCH（保留） |
| 23 | trade-docs.files | GET /api/v1/trade-docs/{id}/files | ws_files.py:642 | - |
| 24 | trade-docs.content-versions.list | GET .../content-versions | ws_docs_ext.py:625 | - |
| 25 | trade-docs.content-versions.get | GET .../content-versions/{no} | ws_docs_ext.py:659 | - |

另有 **13 个引擎切片**（calculate/verify/formulas/spec/explain/products/import-template/order-template-info/
render-data/facts/consistency/pricing-data/product-name-preference）的**旧 GET/POST handler** 也可删，但注意：
它们的 kernel handler 现已改为「门面供数 → 纯算 RPC」共用同一份投影，删除时要保留 `engine_api.py` 的 RPC 入口与共享纯函数。

### ⚠️ 删除前必须接受的一个取舍（重要）
**删掉内核 handler 后，`AUTH_DB_SPLIT=off` 的回退对该路由不再成立**（off 会 404）。
也就是说：回退手段从「改一个 flag」变成「回滚内核代码 + 重新部署」。
⇒ 建议顺序：
1. 观察期通过（连续 24h 无迁移相关回归）→ 2. 先删**只读直连**（25 条里风险最低的一批，如 products/notifications/approvals）
→ 3. 每删一批：worker 全量 + 线上抽验 + 观察 1 天 → 4. 再删引擎切片的旧 handler → 5. 最后处理写路径。
若你不接受「off 不再可回退」，那就**永远不删 handler**，只保留这份清单作为「已知双份」记录 —— 这时 P3 的收益只剩「请求不再打内核」，
内核启动成本不会因删除代码而进一步下降（Pyodide 仍要加载这些模块）。