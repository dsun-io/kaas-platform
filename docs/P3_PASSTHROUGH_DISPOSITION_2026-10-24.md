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
