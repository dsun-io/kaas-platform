# P2 · 引擎端点「TS 供数 → Python 纯算 → TS 落库」耦合清单与拆分方案

> 日期：2026-10-24 · 阶段：P2（依赖 P1 已完成） · 状态：**清单与方案定稿；首个端到端切片已落地（见 §8）**
> 依据：AGENTS.md 铁纪律（业务规则只在 Python 内核一处实现）、
> docs/ARCH_AUTH_DB_SPLIT_2026-10-24.md §3.4 / §7 / §10、ADR-008
> 范围：backend/worker/src 中 quotes / trade-docs / export-quote / tax-archives 四族引擎端点的 DB 访问点。
> **本文不是重写计划**：用户 2026-10-24 明确要求「先输出耦合点清单与拆分方案，不要强行重写」，
> 因此这里先给出逐端点事实与取舍，再只落地 1 个最简只读切片。

## 0. 结论速览

审计口径：backend/ts-migration/routes.json 的 **quotes 38 条 + trade-docs 39 条 = 77 条**业务路由
（与 route-classification.md §1 的「quotes 37 / trade-docs 38」差 1+1，原因是 2026-10-24 新增的
GET /quotes/product-name-preference 与 POST /trade-docs/preview-render-data 已入库；以 routes.json 为准）。
逐条判定结果（数字由 §3/§4 表自动统计，不是估算）：

| 处置 | 条数 | 占比 |
|---|---|---|
| Py-RPC（只读）可拆 | **25** | 32% |
| Py-RPC（TS 落库）可拆 | **1** | 1% |
| TS-DB（无 Python 计算，不套 RPC） | **33** | 43% |
| 不宜拆（§7） | **15** | 19% |
| 保持 Python（字节/PDF/AI） | **3** | 4% |
| **合计** | **77** | 100% |

三条硬结论：

1. **能拆的先拆只读纯算端点**（/export-quote/*、facts/consistency/lint/render-data/render-fingerprint 等）：
   输入是「若干张表的行」，输出只由这些行与请求体决定，把 SQL 搬到门面后 Python 侧不需要再碰库。
2. **写路径整体不拆**：不是「难」，而是它们**读后写**（乐观锁/状态机/取号/幂等键）或**多表同事务**，
   拆出去要么把「当前库内状态」也整包供数（等于把事务语义搬进 payload），要么把一次事务拆成两次网络调用
   （中间失败 = 半落库）。这类端点的拆分收益远小于风险。
3. **纯 CRUD 不套 Py-RPC**：tax-archives / product-tax-rates / pricing-data / fx-rates / external-docs /
   clause-templates 这些没有 Python 计算，按 §5.2 走 TS-DB（门面直连 SQL）即可，套 RPC 只会多一跳与一份契约。

## 1. 审计方法与口径

### 1.1 方法（可复现）

- 对 backend/worker/src 的 main / quote_api / ws_quote_ext / ws_docs_ext / ws_docs_hardening /
  tax_archives / ws_shipments / ws_clause_templates / ws_option_overrides / ws_seals / ws_extras /
  chain / doc_payload / ws_files / imports_api / ws_products / ws_enums 做 **AST 静态扫描**：
  (1) 收集 @app.<method> 路由处理函数；(2) 解析同模块函数调用与 import x as y 模块别名调用，求**传递闭包**
  （端点 → 它实际会走到的 helper，例如 _effective_product_raw / _pricing_key_items / _render_bundle_of_doc /
  _apply_default_seal）；(3) 对闭包内每条 db.fetch/fetchrow/fetchval/execute 解析 SQL 参数
  （模块常量、函数内局部变量、+ 拼接、f-string 占位），提取 FROM/JOIN/INTO/UPDATE/DELETE FROM 后的表名。
- 因此表中「DB 调用数」是**传递口径**（含 helper 里的查询），不是 handler 函数体里肉眼可见的那几条 ——
  这正是「计算依赖 DB 中间结果」的量化近似：数字越大、跨的表越多，越说明计算与取数交织。
- 两处 SQL 由 %/分段拼接静态解不出，按源码人工核对补表名（/quotes/reference-price、/quotes/cost-reference
  读 quote_order_items JOIN quote_orders；/trade-docs/{id}/files GET 读 file_objects+trade_docs）。
  除此之外表名均来自静态解析，未手抄。
- 表名提取已滤掉 SQL 关键字伪影（SET 被 upsert 语句误识别为表名），未手改任何真实表名。
- kaas_common/** 不计入（纯函数、零 DB；本次只读确认过 export_quote/、trade_doc/ 内无 _acquire/SQL）。

### 1.2 「哪些计算依赖 DB 中间结果」的三类判定

| 类 | 语义 | 典型端点 | 可拆性 |
|---|---|---|---|
| **A 纯算** | 输入 = 请求体 + 若干行数据；输出只由输入决定，计算中不再查库 | /export-quote/calculate、/verify、/formulas、/explain、/facts、/consistency、/lint、/verify-export、/render-data | **可拆**：把行数据整包供数，Python 侧纯算 |
| **B 读后写（RMW）** | 计算依赖「库内当前状态」（行锁、状态机、取号、版本号、幂等键），算完立刻写回且必须与读同一事务 | PATCH /quotes/{id}、PUT /quotes/{id}/items、PATCH /trade-docs/{id}、PUT /trade-docs/{id}/doc-set、POST .../facts/confirm、PATCH .../facts/{key}、POST .../content-versions/{n}/restore | **本期不拆**：供数要含「当前状态」，写回要原子；拆了就是把事务搬到 HTTP 两侧 |
| **C 边算边查（N+1 / 分步依赖）** | 同一请求内 6–24 次查询，且**后一步查什么由前一步结果决定** | POST /trade-docs/{id}/confirm（24 次）、POST .../refresh-sources（10 次）、PATCH /trade-docs/{id}（15 次）、POST /trade-docs（16 次）、POST /preview-render-data（17 次） | **不宜整段拆**：可拆成多段 RPC，但每次都要重新定义中间 payload，契约成本 > 收益 |

> 注：GET /trade-docs/{id}/render-data 属 A 但**跨 7 张表**（单证/企业主体/客户/联系人/产品档案/公章/文件），
> 且照片与默认章是「按单据内容决定去查哪些 file_id」——是 A/C 的边界样本：可拆，但应作为**第 2、3 个切片**，
> 不宜当首个切片。

### 1.3 读端点里的隐藏写（必须知晓，否则「只读」是假象）

静态扫描抓到 2 处「GET 也写库」（另 1 处列表读仅作对照）：

| 端点 | 隐藏写 | 说明 |
|---|---|---|
| GET /api/v1/clause-templates | INSERT tenant_clause_templates | 首次访问**懒种子** 6 类默认条款（ws_clause_templates.py） |
| GET /api/v1/fx-rates/latest | SET fx_rates（回填） | 无当期汇率时回填/计算并落库 |
| GET /api/v1/trade-docs | 无写（trade_doc_render_checks 只读） | 对照：确认不是所有列表都写 |

⇒ 这两条**不能**按「只读端点随便拆」处理：懒种子与回填语义必须显式保留（TS-DB 时由门面执行同样的写，
或改到写入时种子 —— 后者是行为变更，需单独拍板）。

## 2. 总体拆分原则（契约先行）

1. **谁取数**：SQL 谓词、ORDER BY、JSONB 解码、BIGINT 归一 —— 全部由门面做（「供数」）；
   门面**不得**改写业务判据（团队优先级、可见性、默认值、口径）。
2. **谁算**：kaas_common/export_quote/**、kaas_common/trade_doc/** 与既有 Python helper 里的判定，
   一行不改（本次切片已验证：算法文件零 diff）。
3. **谁落库**：写入类由门面在拿到内核结果后落库；**本期不启用写入类拆分**（见 §7）。
4. **一处实现**：内核新端点只做「payload → 既有纯函数/既有 helper」的**接线**，禁止复制判定；
   若某端点拆分需要第二份判定，则**不拆**（本清单已按此剔除 15 条）。
## 3. quotes 域逐端点耦合清单（38 条）

> 列含义：「读表/写表」= 传递闭包内 SQL 解析结果；「DB 调用数」= 传递口径调用点数；
> 「拆分建议」= 本期（2026-10-24）结论，不是永远结论。
> 建议图例：Py-RPC（只读）= 可拆、内核只算不写；Py-RPC（TS 落库）= 可拆、门面落库；
> TS-DB（无 Python 计算）= 不该套 RPC；不宜拆 = 见 §7；保持 Python = 字节/PDF/AI。

| # | 端点 | 实现（文件:行） | 读表 | 写表 | DB 调用数 | 拆分建议 |
|---|---|---|---|---|---|---|
| 1 | GET /api/v1/quotations | main.py:2504 | quotations | — | 2 | TS-DB（无 Python 计算） |
| 2 | POST /api/v1/quotations | main.py:2546 | — | quotations | 1 | Py-RPC（TS 落库） |
| 3 | GET /api/v1/pricing-data | main.py:2655 | customer_cost_items | — | 1 | TS-DB（无 Python 计算） |
| 4 | POST /api/v1/pricing-data | main.py:2760 | customer_cost_items | — | 1 | TS-DB（无 Python 计算） |
| 5 | PATCH /api/v1/pricing-data/{item_id} | main.py:2868 | — | customer_cost_items | 1 | TS-DB（无 Python 计算） |
| 6 | DELETE /api/v1/pricing-data/{item_id} | main.py:2936 | — | customer_cost_items | 1 | TS-DB（无 Python 计算） |
| 7 | GET /api/v1/export-quote/products | quote_api.py:444 | product_profiles, tenant_products, tenant_workstation_products | — | 3 | Py-RPC（只读） |
| 8 | GET /api/v1/export-quote/products/{product_key}/formulas | quote_api.py:477 | customer_cost_items, tenant_products | — | 2 | Py-RPC（只读） |
| 9 | GET /api/v1/export-quote/terms/template | quote_api.py:510 | — | — | 0 | Py-RPC（只读） |
| 10 | POST /api/v1/export-quote/calculate | quote_api.py:953 | customer_cost_items, tenant_products | — | 2 | Py-RPC（只读） |
| 11 | POST /api/v1/export-quote/calculate-internal | quote_api.py:966 | customer_cost_items, tenant_products | — | 2 | Py-RPC（只读） |
| 12 | POST /api/v1/export-quote/verify | quote_api.py:976 | customer_cost_items, tenant_products | — | 2 | Py-RPC（只读） |
| 13 | GET /api/v1/export-quote/products/{product_key}/import-template | quote_api.py:1070 | tenant_products | — | 1 | Py-RPC（只读） |
| 14 | GET /api/v1/export-quote/import/order/template-info | quote_api.py:1118 | product_profiles, tenant_products, tenant_workstation_products | — | 3 | Py-RPC（只读） |
| 15 | POST /api/v1/export-quote/import/order/preview | quote_api.py:1165 | product_profiles, tenant_products, tenant_workstation_products | — | 3 | Py-RPC（只读） |
| 16 | GET /api/v1/quotes | quote_api.py:1771 | orders, quote_order_items, quote_orders, trade_docs | — | 5 | Py-RPC（只读） |
| 17 | POST /api/v1/quotes | quote_api.py:1836 | cust_inquiries, trade_docs | cust_inquiries, quote_order_items, quote_orders, trade_doc_items, trade_docs | 10 | **不宜拆**（§7） |
| 18 | POST /api/v1/quotes/batch | quote_api.py:1914 | cust_inquiries, trade_docs | cust_inquiries, quote_order_items, quote_orders, trade_doc_items, trade_docs | 10 | **不宜拆**（§7） |
| 19 | GET /api/v1/quotes/product-name-preference | quote_api.py:1955 | product_profiles, tenant_products, tenant_workstation_products | — | 4 | Py-RPC（只读） |
| 20 | GET /api/v1/quotes/reference-price | quote_api.py:2026 | quote_order_items, quote_orders | — | 1 | Py-RPC（只读） |
| 21 | GET /api/v1/quotes/cost-reference | quote_api.py:2121 | quote_order_items, quote_orders | — | 2 | Py-RPC（只读） |
| 22 | GET /api/v1/quotes/{quote_id} | quote_api.py:2202 | orders, quote_order_items, trade_docs | — | 4 | Py-RPC（只读） |
| 23 | PATCH /api/v1/quotes/{quote_id} | quote_api.py:2228 | orders, quotations, quote_order_items, quote_orders, trade_docs | quotations, trade_doc_items, trade_docs | 13 | **不宜拆**（§7） |
| 24 | PUT /api/v1/quotes/{quote_id}/items | quote_api.py:2361 | quote_order_items, trade_docs | quote_order_items, quote_orders, trade_doc_items, trade_docs | 9 | **不宜拆**（§7） |
| 25 | GET /api/v1/export-quote/products/{product_key}/spec | quote_api.py:2409 | customer_cost_items, tenant_products | — | 2 | Py-RPC（只读） |
| 26 | GET /api/v1/fx-rates | ws_extras.py:163 | fx_rates | — | 1 | TS-DB（无 Python 计算） |
| 27 | GET /api/v1/fx-rates/latest | ws_extras.py:180 | fx_rates | fx_rates | 3 | TS-DB（无 Python 计算） |
| 28 | GET /api/v1/fx-rates/_debug | ws_extras.py:197 | — | — | 0 | TS-DB（无 Python 计算） |
| 29 | POST /api/v1/fx-rates | ws_extras.py:218 | — | fx_rates | 1 | TS-DB（无 Python 计算） |
| 30 | POST /api/v1/export-quote/products/{product_key}/explain | ws_quote_ext.py:128 | tenant_products | — | 1 | Py-RPC（只读） |
| 31 | GET /api/v1/tax-archives | tax_archives.py:202 | tax_archives | — | 1 | TS-DB（无 Python 计算） |
| 32 | POST /api/v1/tax-archives | tax_archives.py:218 | tax_archives | tax_archives | 3 | TS-DB（无 Python 计算） |
| 33 | PATCH /api/v1/tax-archives/{archive_id} | tax_archives.py:248 | tax_archives | tax_archives | 3 | TS-DB（无 Python 计算） |
| 34 | DELETE /api/v1/tax-archives/{archive_id} | tax_archives.py:295 | tax_archives | tax_archives | 2 | TS-DB（无 Python 计算） |
| 35 | GET /api/v1/product-tax-rates | tax_archives.py:372 | product_tax_rates | — | 1 | TS-DB（无 Python 计算） |
| 36 | POST /api/v1/product-tax-rates | tax_archives.py:386 | product_tax_rates | product_tax_rates | 3 | TS-DB（无 Python 计算） |
| 37 | PATCH /api/v1/product-tax-rates/{rate_id} | tax_archives.py:440 | product_tax_rates | product_tax_rates | 2 | TS-DB（无 Python 计算） |
| 38 | DELETE /api/v1/product-tax-rates/{rate_id} | tax_archives.py:468 | product_tax_rates | product_tax_rates | 2 | TS-DB（无 Python 计算） |

### 3.1 quotes 域小节

- **最干净的 A 类**：/export-quote/* 共 11 条（products / formulas / terms / calculate / calculate-internal /
  verify / import-template / order-template-info / order-preview / spec / explain）。除 terms 外都读
  tenant_products（部分再读 product_profiles / tenant_workstation_products / customer_cost_items），
  计算全在 kaas_common.export_quote。**首个切片选 /calculate**（见 §8）。
- **只读查询类**：GET /quotes、GET /quotes/{id}、product-name-preference、reference-price、cost-reference
  —— 读 1–4 张表后做投影/聚合，可拆，但聚合口径（median / scope 过滤）必须在 Python 保留。
- **写路径 4 条不拆**：POST /quotes、POST /quotes/batch、PATCH /quotes/{id}、PUT /quotes/{id}/items。
  理由：取号（build_number / _next_doc_no，D2 规则留 Python）+ 多表同事务（quote_orders/items/quotation 单证/
  询盘/台账）+ 状态机；PATCH 还要同步 trade_doc_items（传递 13 次调用）。
- **纯 CRUD 走 TS-DB**：quotations 的 GET、pricing-data 4、fx-rates 4、tax-archives 4（quotations 的 POST
  含号码规则 → 实为 Py-RPC（TS 落库），见 §7.3「号码规则」）。

## 4. trade-docs 域逐端点耦合清单（39 条）

| # | 端点 | 实现（文件:行） | 读表 | 写表 | DB 调用数 | 拆分建议 |
|---|---|---|---|---|---|---|
| 1 | GET /api/v1/trade-docs | main.py:5340 | trade_doc_render_checks, trade_docs | — | 5 | Py-RPC（只读） |
| 2 | POST /api/v1/trade-docs | main.py:5627 | cust_inquiries, customers, order_items, orders, quote_order_items, quote_orders, trade_docs | business_events, quote_orders, trade_docs | 16 | **不宜拆**（§7） |
| 3 | GET /api/v1/trade-docs/{doc_id} | main.py:5718 | entity_links, trade_docs | — | 4 | Py-RPC（只读） |
| 4 | PATCH /api/v1/trade-docs/{doc_id} | main.py:5743 | entity_links, file_objects, teams, trade_docs | file_objects, trade_doc_files, trade_docs | 15 | **不宜拆**（§7） |
| 5 | GET /api/v1/trade-docs/{doc_id}/render-data | main.py:6225 | cust_contacts, customers, product_profiles, tenant_company_profile, tenant_company_seals, trade_docs | — | 7 | Py-RPC（只读） |
| 6 | POST /api/v1/trade-docs/preview-render-data | main.py:6244 | cust_contacts, cust_inquiries, customers, order_items, orders, product_profiles, quote_order_items, quote_orders, tenant_company_profile, tenant_company_seals, trade_docs | — | 17 | Py-RPC（只读） |
| 7 | POST /api/v1/external-docs | ws_extras.py:336 | — | external_doc_uploads | 1 | TS-DB（无 Python 计算） |
| 8 | GET /api/v1/external-docs | ws_extras.py:363 | external_doc_uploads | — | 1 | TS-DB（无 Python 计算） |
| 9 | GET /api/v1/external-docs/{doc_id}/download | ws_extras.py:393 | external_doc_uploads | — | 1 | TS-DB（无 Python 计算） |
| 10 | PATCH /api/v1/external-docs/{doc_id} | ws_extras.py:418 | — | external_doc_uploads | 1 | TS-DB（无 Python 计算） |
| 11 | DELETE /api/v1/external-docs/{doc_id} | ws_extras.py:433 | — | external_doc_uploads | 1 | TS-DB（无 Python 计算） |
| 12 | GET /api/v1/trade-docs/{doc_id}/facts | ws_docs_hardening.py:600 | trade_doc_facts, trade_docs | — | 2 | Py-RPC（只读） |
| 13 | POST /api/v1/trade-docs/{doc_id}/facts/confirm | ws_docs_hardening.py:625 | teams, trade_doc_facts, trade_docs | business_events, trade_doc_facts | 6 | **不宜拆**（§7） |
| 14 | PATCH /api/v1/trade-docs/{doc_id}/facts/{fact_key} | ws_docs_hardening.py:683 | trade_doc_facts, trade_docs | trade_doc_facts | 3 | **不宜拆**（§7） |
| 15 | GET /api/v1/trade-docs/{doc_id}/consistency | ws_docs_hardening.py:770 | trade_docs | — | 4 | Py-RPC（只读） |
| 16 | POST /api/v1/trade-docs/{doc_id}/lint | ws_docs_hardening.py:983 | entity_links, trade_doc_doc_set_items, trade_doc_facts, trade_doc_items, trade_docs | — | 7 | Py-RPC（只读） |
| 17 | GET /api/v1/trade-docs/{doc_id}/receipts | ws_docs_hardening.py:1048 | trade_doc_receipts, trade_docs | — | 2 | TS-DB（无 Python 计算） |
| 18 | POST /api/v1/trade-docs/{doc_id}/receipts | ws_docs_hardening.py:1069 | teams, trade_docs | trade_doc_receipts | 3 | **不宜拆**（§7） |
| 19 | GET /api/v1/trade-docs/{doc_id}/doc-set | ws_docs_hardening.py:1217 | trade_doc_doc_set_items, trade_doc_facts, trade_docs | — | 3 | TS-DB（无 Python 计算） |
| 20 | PUT /api/v1/trade-docs/{doc_id}/doc-set | ws_docs_hardening.py:1239 | teams, trade_doc_doc_set_items, trade_docs | trade_doc_doc_set_items | 5 | **不宜拆**（§7） |
| 21 | POST /api/v1/trade-docs/{doc_id}/doc-set/{doc_type}/receipt | ws_docs_hardening.py:1305 | teams, trade_doc_doc_set_items, trade_docs | trade_doc_doc_set_items | 5 | **不宜拆**（§7） |
| 22 | POST /api/v1/trade-docs/{doc_id}/verify-export | ws_docs_hardening.py:1369 | teams, trade_docs | business_events | 4 | **不宜拆**（§7） |
| 23 | POST /api/v1/trade-docs/{doc_id}/refresh-sources | ws_docs_ext.py:150 | cust_inquiries, entity_links, order_items, orders, quote_order_items, quote_orders, trade_docs | trade_docs | 10 | **不宜拆**（§7） |
| 24 | POST /api/v1/trade-docs/{doc_id}/confirm | ws_docs_ext.py:237 | cust_contacts, customers, entity_links, file_objects, product_profiles, teams, tenant_company_profile, tenant_company_seals, trade_doc_doc_set_items, trade_doc_facts, trade_doc_items, trade_docs | business_events, file_objects, trade_doc_files, trade_docs | 24 | **不宜拆**（§7） |
| 25 | GET /api/v1/trade-docs/{doc_id}/render-fingerprint-check | ws_docs_ext.py:384 | cust_contacts, customers, product_profiles, tenant_company_profile, tenant_company_seals, trade_docs | — | 8 | Py-RPC（只读） |
| 26 | GET /api/v1/trade-docs/render-fingerprint-checks/batch | ws_docs_ext.py:438 | cust_contacts, customers, product_profiles, tenant_company_profile, tenant_company_seals, trade_docs | — | 8 | Py-RPC（只读） |
| 27 | POST /api/v1/trade-docs/{doc_id}/translate | ws_docs_ext.py:555 | ai_providers, ai_task_bindings, trade_docs | ai_usage, trade_docs | 5 | 保持 Python（字节/PDF/AI） |
| 28 | GET /api/v1/trade-docs/{doc_id}/content-versions | ws_docs_ext.py:625 | trade_doc_content_versions, trade_docs | — | 2 | TS-DB（无 Python 计算） |
| 29 | GET /api/v1/trade-docs/{doc_id}/content-versions/{version_no} | ws_docs_ext.py:659 | trade_doc_content_versions, trade_docs | — | 2 | TS-DB（无 Python 计算） |
| 30 | POST /api/v1/trade-docs/{doc_id}/content-versions/{version_no}/restore | ws_docs_ext.py:690 | trade_doc_content_versions, trade_docs | trade_docs | 3 | **不宜拆**（§7） |
| 31 | GET /api/v1/clause-templates | ws_clause_templates.py:192 | tenant_clause_templates | tenant_clause_templates | 4 | TS-DB（无 Python 计算） |
| 32 | POST /api/v1/clause-templates | ws_clause_templates.py:226 | teams | tenant_clause_templates | 2 | TS-DB（无 Python 计算） |
| 33 | PATCH /api/v1/clause-templates/{template_id} | ws_clause_templates.py:262 | teams, tenant_clause_templates | tenant_clause_templates | 3 | TS-DB（无 Python 计算） |
| 34 | DELETE /api/v1/clause-templates/{template_id} | ws_clause_templates.py:316 | teams | tenant_clause_templates | 2 | TS-DB（无 Python 计算） |
| 35 | GET /api/v1/trade-docs/{doc_id}/files | ws_files.py:642 | file_objects, trade_doc_files | — | 1 | TS-DB（无 Python 计算） |
| 36 | POST /api/v1/trade-docs/{doc_id}/files | ws_files.py:662 | file_objects, trade_doc_files | trade_doc_files | 3 | TS-DB（无 Python 计算） |
| 37 | DELETE /api/v1/trade-docs/{doc_id}/files/{link_id} | ws_files.py:693 | — | trade_doc_files | 1 | TS-DB（无 Python 计算） |
| 38 | POST /api/v1/trade-docs/{doc_id}/files/upload | ws_files.py:705 | file_objects | file_objects, trade_doc_files | 6 | 保持 Python（字节/PDF/AI） |
| 39 | POST /api/v1/trade-docs/{doc_id}/pdf | ws_files.py:988 | file_objects, teams, trade_docs | file_objects, trade_doc_files | 8 | 保持 Python（字节/PDF/AI） |

### 4.1 trade-docs 域小节

- **A 类可拆（只读纯算）**：GET /trade-docs、GET /{id}、GET /{id}/facts、GET /{id}/consistency、POST /{id}/lint、
  GET /{id}/doc-set、GET /{id}/receipts、POST /{id}/verify-export（纯算 + 一条 business_events 写）、
  GET /{id}/render-data、GET .../render-fingerprint-check、GET .../batch、POST /preview-render-data。
- **B/C 类不拆**：POST /trade-docs（16 次 / 9 表）、PATCH /{id}（15 次 / 6 表）、POST /{id}/confirm
  （24 次 / 12 表：issuer 校验 + 状态机 + 业务事件 + 文件落库）、POST /{id}/refresh-sources（10 次）、
  PUT /{id}/doc-set（事务 delete+upsert）、POST .../doc-set/{type}/receipt、PUT/PATCH facts*、
  POST .../content-versions/{n}/restore、POST /{id}/receipts。
- **保持 Python 3 条**：POST .../files/upload、POST .../pdf（Browser Rendering + R2 字节）、
  POST .../translate（AI 外呼）。
- **纯 CRUD 走 TS-DB**：clause-templates 4、external-docs 5、content-versions 2 条 GET、doc-set GET、
  receipts GET、files 3 条（GET 链接 / POST 链接 / DELETE 链接）。

## 5. export-quote / tax-archives 补充说明

### 5.1 报价引擎 export-quote（10 条，属 quotes 域）

DB 访问面**很小且高度同构**：tenant_products（团队级产品定义，读 spec/override）、customer_cost_items
（客户定价数据）、product_profiles（英文名资料）、tenant_workstation_products（团队停用）。
计算全部在 kaas_common/export_quote/**（纯标准库），**没有「计算中途再查库」**。
⇒ 这是全平台最适合「TS 供数 → Python 纯算」的一族；契约按 §6 的 datasets 通用规范即可，
不需要为每个端点发明新 payload（同一组 dataset 名复用：tenant_products / customer_cost_items /
product_profiles / tenant_workstation_products）。

### 5.2 tax-archives / product-tax-rates（8 条，属 quotes 域）

零 Python 计算：都是「读/写一张表 + 简单校验（日期区间、税率范围、租户归属）」。
⇒ 正确处置是 **TS-DB**（门面直连 SQL），不是 Py-RPC。拆分时需要把「区间重叠校验 / 默认生效档案选择」
这类判定放在哪一层先拍板：按铁纪律应留 Python（kaas_common 若已有对应纯函数则复用；
目前这些校验写在 tax_archives.py 的 handler 内，说明它们**尚未下沉共享内核** —— 属于待办，不是本期范围）。
## 6. 拆分方案：/internal/engine/* 接口契约草案

### 6.1 命名与调用面

- 统一 **POST /internal/engine/<domain>/<action>**，**只读也 POST**：数据集走 body，避免把行数据塞 query。
- **只允许 Service Binding 调用**：内核 wrangler.jsonc 的 routes 必须保持 []（双 Worker 发布纪律），
  这些路径永远不对外；P3 内核删 main.py 公网入口后仍是内网路径。
- 门面侧**唯一**调用点：src/routes/engine.ts（P2 只登记 1 条），复用 callKernel 的重试策略
  （POST 非幂等 ⇒ 至多 1 次且 body 必须可重放；只读引擎调用虽 POST，但**语义幂等**，
  是否放宽重试需在契约里显式标注 idempotent: true 后再改策略 —— 本期保持保守）。

### 6.2 鉴权（沿用 mintInternalJwt 口径，内核不查库）

~~~
Authorization: Bearer <internal JWT>
claims:
  sub                = 用户 id（与今天内核 _get_current_user 同一口径）
  tenant_id          = "default"
  team_id            = 用户 / API token 的团队边界
  role / account_type / is_tenant_admin   ← 角色快照（内核做团队优先级、管理员判定要用）
  kaas_internal      = "engine"           ← 新增 claim：区分「门面铸的内部令牌」与「普通用户会话 JWT」
  iat / exp          = now / now+60s（TTL 与 mintInternalJwt 完全一致，HS256，JWT_SECRET 同一把）
~~~

- 内核 _require_engine_actor(request)：jwt.decode(secret, HS256) → 校验 kaas_internal == "engine"
  → 从 claims 重建 actor dict（**不查 users 表**）。缺 claim / 过期 / 签名错 → 401 同既有信封。
- 为什么必须加 kaas_internal：普通用户 JWT 与内部 JWT 同一把 secret。不加该 claim，任何用户 JWT 都能
  被直接打到 /internal/engine/*（虽然内网不可达，但这是纵深防御，且成本为零）。
- 角色快照放 claims 而不是 payload：判定依据必须**签名保护**，不能让门面在 payload 里自报 role。

### 6.3 输入 payload 通用信封

~~~json
{
  "request":  { "这里是该端点原始外部请求体，逐字；模型校验仍在内核（同一份 pydantic）" },
  "actor":    { "id": 5, "tenant_id": "default", "team_id": 2, "role": "owner",
                "account_type": "customer", "is_tenant_admin": false },
  "datasets": {
    "<dataset_name>": [ { "列名与旧 SQL 的 SELECT 列一致" } ]
  }
}
~~~

datasets 三条硬规则（金标一致性的全部来源）：

1. **过滤 / 排序责任在供数方**：门面必须执行与内核旧路径**同一 SQL 谓词与 ORDER BY**
   （例：... WHERE tenant_id=$1 AND left(spec_hash, length($2))=$2 AND status='active' AND customer_id=$3
   ORDER BY id DESC）。行顺序有语义（「最新在前、先到先得」），所以 ORDER BY 不能省。
   门面可**合并**同一 SQL 的重复调用（calculate 旧路径对同一 customer_cost_items 查询了两次）；
   契约要求「每个 dataset 只出现一次」，内核按同一份行复用 —— 语义等价（两次查询之间无写）。
2. **JSONB 以已解码 JSON 值传入**：TS 侧 postgres.js 天然解码；Python 侧**不再** dbjson 解码。
   契约上等价于旧路径 dbjson.row_to_dict(row, table) 之后的值。
3. **类型口径**：BIGINT → JSON number（门面用 num() 归一，postgres.js 默认给 string）；
   NUMERIC / Float → JSON number；时间戳 → ISO 字符串；未参与计算的列可缺省。
   ⚠️ 定价数据查询前缀用**请求的 product_key**（旧路径用解析后 product.key；两者由 tenant_products
   唯一键 (tenant_id, team_id, product_key) + spec.key 一致性保证相等；若将来允许「列 key ≠ spec.key」
   需重新定义 dataset 契约）。
   ⚠️ 已知边界：tenant_products.override 在旧路径**未登记 JSONB 解码**（dbjson 只登记了 spec），
   若库里真是 JSON 字符串，旧路径会把它当 dict 用而报错；新路径传的是对象。这是**修正**而非回归，
   但需在切片放量前用真实数据核对一次（§9 待办 5）。

### 6.4 输出与错误信封

~~~json
HTTP 200
{ "status": 200, "body": { "这里是该端点原本的响应体，逐字" } }
~~~

- 门面：status < 500 → 原样回放 body + 该状态码（4xx 信封 {"detail": ...} 逐字不变）；
  status >= 500 → 按 proxy 同口径归一到 kernel_error。内核 RPC 自身异常（payload 形状不对）→ 400
  {"error":"engine_rpc_payload_invalid", "message": ...}（这是实现 bug，不是用户输入错误）。
- 为什么把 status 塞进 body：旧端点的错误语义（400 engine_error / 403 / 409 SPEC_UPSTREAM_CHANGED /
  422 pydantic）必须逐字保留；FastAPI 在门面侧无法重建同一份 pydantic 422 detail（那会变成第二份实现）。

### 6.5 灰度与回退

- 沿用 AUTH_DB_SPLIT（默认 off）+ AUTH_DB_SPLIT_ROUTES 路由 id 白名单：
  off = **旧路径**（门面原样透传，内核自取数），行为与今天逐字一致；on + 白名单命中 = 新路径（TS 供数）。
- 新路径每请求求值开关（src/boot-flag.ts 的 useDirectRoute），路由注册保持静态 ⇒ 路由面计数不变。
- 一键回退：把 AUTH_DB_SPLIT 改回 off（无需发版）；内核新端点保留也无害（内网、无调用方）。

### 6.6 金标对照（fixture 双向锁）

backend/ts-migration/golden/ 既有 harness 是「两 URL 对打 + JSON 语义 diff」，需要双端在线；
本期新增**离线等价形态**：一份 fixture 同时被 Python 与 TS 测试读取，两侧各自断言。

fixture 五段（golden/engine-quote-calculate.fixture.json），生成脚本已入库且幂等：
backend/ts-migration/golden/gen_engine_quote_calculate_fixture.py（用旧路径真实跑一遍落盘，禁止手写）：

| 段 | 内容 | 谁断言 |
|---|---|---|
| request | 外部请求体（含固定 quote_date，消除 today 漂移） | 两侧都用它发请求 |
| actor | 用户行快照（JWT 测试里由 users 桩返回） | TS 侧构造 claims；Python 侧重建 actor |
| datasets | 供数行（tenant_products / customer_cost_items） | TS 侧断言「发给内核的 datasets 逐字段等于它」；Python 侧拿它当 DB 返回 |
| sql | 旧路径实际执行的 SQL 文本（空白归一） | **两侧都断言**「发出的 SQL == 它」⇒ 供数语义漂移必红 |
| response | 旧路径响应体（逐字） | 旧路径 == 它；新路径 == 它 |

Python 侧同时用 harness 自己的 diff_bodies()（golden/diff_responses.py）对「旧 vs 新」出一份语义 diff，
断言为空 —— 这样「改造前后逐字段一致」用的是**既有金标口径**，不是新写一套比较器。

## 7. 不适合按此拆的端点（逐条原因）

### 7.1 B 类：读后写 / 多表同事务（15 条，本期一律不拆）

| 端点 | 传递 DB 调用 | 不拆原因 |
|---|---|---|
| POST /api/v1/quotes | 10（5 表写） | 取号（_next_doc_no 查库唯一性 + kaas_common.number_rules）→ 落 quote_orders/items → 建/复用询盘 → 建 quotation 单证 + trade_doc_items；一步失败必须全回滚 |
| POST /api/v1/quotes/batch | 10 | 同上 ×N，事务边界是整批 |
| PATCH /api/v1/quotes/{id} | 13（4 表写） | 行锁 + 状态机 + 改单号查重 + **同步 quotation 单证行项**（_sync_quotation_doc_items）；计算依赖「当前行」 |
| PUT /api/v1/quotes/{id}/items | 9 | 替换行项 + 重算金额 + 同步单证 + 行锁；不可拆成「先算后写」两次调用 |
| POST /api/v1/trade-docs | 16（9 表读 / 3 表写） | _assemble_doc_inputs 分步依赖（订单/报价/客户/询盘 → 快照）、自动上传、业务事件 |
| PATCH /api/v1/trade-docs/{id} | 15 | 行项覆盖校验、文件重挂、团队校验、业务事件 |
| POST .../refresh-sources | 10 | 拉取上游（订单/报价/询盘）→ 重建 sources 快照 → 写回；「上游」本身就是计算输入 |
| POST .../confirm | 24（12 表读 / 3 表写） | issuer 校验 → 状态机 → 事实层确认 → 生成/落库文件 → 业务事件；任一环失败需回滚 |
| POST .../verify-export | 4 | 计算是纯的（trade_doc.verify），但**先写 business_events 再返回**；可拆但收益低，列 B 待评估 |

同类还有 6 条（PUT .../doc-set、POST .../doc-set/{type}/receipt、POST .../facts/confirm、
PATCH .../facts/{key}、POST .../content-versions/{n}/restore、POST .../receipts）：都是「校验 +
事务内 delete/upsert/状态机」，且 PUT doc-set 是**全量替换**语义（先删后 upsert，中间态不能被其它请求看到）。

### 7.2 C 类：计算中反复查库（含 photo / seal / product 补全链）

GET /trade-docs/{id}/render-data 与 POST /trade-docs/preview-render-data 是「装配链」：
读单证 → 读企业主体 → 读客户/联系人 → 读产品档案 → **按单据内容里的 file_id 再查文件** →
按 with_seal 再查公章 → 按订单再查产品默认值。**后一步查什么由前一步结果决定**（不是固定表集合）。
结论：可拆（把这 7 张表的行一次供数即可），但必须作为后续独立切片；第一个切片不能选它。

### 7.3 其它「看起来能拆、实际不能」的四类

| 类别 | 端点 | 原因 |
|---|---|---|
| **号码规则**（D2） | POST /quotations、POST /quotes、POST /trade-docs | build_number / build_inquiry_no / normalize_number 是 kaas_common 唯一实现的规则且**内部要查重**（_next_doc_no 查库）；按 D2「规则留 Python」，只能「TS 取号后供数、Python 校验、TS 落库」，跨两次网络 ⇒ 当期不做 |
| **Lazy write on read** | GET /clause-templates、GET /fx-rates/latest | 读端点带写副作用（§1.3）；拆到 TS-DB 必须保留同样语义，否则首次访问行为变化 |
| **文件字节 / PDF** | POST .../files/upload、POST .../pdf、GET .../files | D4：Browser Rendering + R2 字节仍在 Python；只把「元数据」搬门面无收益 |
| **AI 外呼** | POST .../translate | 模型选择 / 用量记账在 Python；拆出去等于把 AI 调用搬 TS，违反非目标（§1） |

## 8. 首个端到端切片：POST /api/v1/export-quote/calculate

### 8.1 选型理由（与候选对比）

| 候选 | 读表 | 计算 | 写 | 结论 |
|---|---|---|---|---|
| **POST /export-quote/calculate（选中）** | 2 张（tenant_products、customer_cost_items） | kaas_common.export_quote.build 纯函数 | 无 | 最小面、零副作用、A 类边界清晰 |
| GET /quotes/reference-price | 2 张 + 聚合 | SQL 聚合（avg/min/max/median） | 无 | 计算在 SQL 里，供数后要重写聚合 ⇒ 反而增加第二份实现风险 |
| GET /trade-docs/{id}/render-data | 7 张 | 装配 + 印章/照片解析 | 无 | 表太多、含 C 类链路，留作第 2/3 切片 |
| GET /export-quote/products | 3 张 | 产品注册表合并 | 无 | 可拆但不是端到端最小面（无「计算结果」对照点） |

### 8.2 实现（已落地）

- 门面 backend/ts-worker/src/routes/engine.ts：
  POST /api/v1/export-quote/calculate，AUTH_DB_SPLIT off ⇒ forwardKernelRequest（旧路径逐字不变）；
  on + 白名单 export-quote.calculate ⇒ requireUser（JWT 或 API token 同一口径）→ 两条**与 Python 逐字同义**的
  SQL 取数（unsafe + $n 占位，便于与 fixture 的 SQL 文本比对）→ 铸内部 JWT →
  POST /internal/engine/quote/calculate → 原样回放 status/body。
- 内核 backend/worker/src/engine_api.py：
  POST /internal/engine/quote/calculate，只做三件事：验内部 JWT（§6.2）→ 把 payload 的 request 交给
  _CalculateIn（**同一 pydantic 模型**，422 形状因此逐字一致）→ 调 quote_api._run_calculation（**同一算子**）；
  取数改为读 payload["datasets"]。
- quote_api.py 的改动是**纯提取**（不新增/不修改任何判定）：
  _resolve_effective_raw(rows, user, product_key)、_apply_customer_options(product, items)、
  _cost_table_from_items(items, product) 三个纯函数从原 DB helper 里拆出；
  原 helper 变成「取数 + 调纯函数」，行为与顺序不变（1842 条基线测试 + 新增金标测试共同锁定）。
- kaas_common/export_quote/**、trade_doc/** **零 diff**（见 §8.4 的自证方式）。

### 8.3 金标结论

见 backend/ts-migration/golden/engine-quote-calculate.fixture.json 与两侧测试：
- Python tests/test_engine_rpc_quote_calculate.py：旧路径响应 == 新路径响应 == fixture.response
  （并使用既有 diff_bodies() 输出空 diff）；
- TS tests/engine-quote-calculate.test.ts：门面发出的 SQL == fixture.sql、发给内核的 datasets == fixture.datasets、
  回放的 body == fixture.response；off 路径不碰 DB、只打旧透传。
- fixture 生成器：backend/ts-migration/golden/gen_engine_quote_calculate_fixture.py（同一命令重跑两次 sha256 相同）。
- 结论：**同一输入下改造前后响应 JSON 逐字段一致（0 diff）**。

### 8.4 硬约束自证

- backend/kaas_common/export_quote/**、trade_doc/** 算法零改动：git status --short 不应出现这两个目录；
- 本次未改 kaas_common/** ⇒ 无需跑 scripts/sync-shared.ps1（若后续切片改了镜像内 helper，
  必须跑；worker 内 src/kaas_common 是 build artifact、不入库）。

## 9. 未完成清单（交后续轮次）

| # | 事项 | 说明 / 前置 |
|---|---|---|
| 1 | 第二个切片：/export-quote/{verify,formulas,spec,explain} | 与 calculate 同族（同 2–3 个 dataset），可复用同一契约与 fixture 骨架 |
| 2 | 第三个切片：GET /trade-docs/{id}/render-data | 需定义 7 个 dataset（含 file_objects 按 file_id 批量、公章按 with_seal）；属 §7.2 |
| 3 | 写路径拆分 | 需先拍板「取号 / 状态机 / 事务」三类语义归属（D2 同理），否则必然出现第二份实现 |
| 4 | tax-archives 校验下沉 | 现在校验写在 handler 内，未在 kaas_common；TS-DB 前必须先下沉，否则第二份实现 |
| 5 | override JSONB 解码口径 | 旧路径 dbjson 未登记 tenant_products.override；新契约传对象。放量前用真实数据核对（§6.3 边界） |
| 6 | API token 的 team_id 边界 | 新路径以 **token 的 team_id** 为团队边界（门面全站一致），旧路径用 token 创建人当前 team；两者在「签发后换团队」时不同 —— 属有意口径，需放量前确认可接受（或切片只放行 JWT 会话） |
| 7 | routes.json 口径 | 新增的 /internal/engine/* **不进入** backend/ts-migration/routes.json（外部业务路由清单），因此不要重跑 export_routes.py，否则 193/87/280 计数会变红；若要纳入请先给生成器加 /internal/ 过滤 |
| 8 | 409 SPEC_UPSTREAM_CHANGED 分支疑似不可达 | 静态+实测（2026-10-24）：quote_api 的 409 分支只在 resolve_effective_product 抛 SpecUpstreamChanged 时触发，但后者内部不调用 assert_base_hash_match；override 的 base_spec_hash 不符实际走 spec_delta.apply_delta → SpecDeltaError（未捕获 ⇒ 500）。属共享内核既有缺口，算法冻结未修；金标用例只锁「新旧同行为」 |
| 9 | P3 联动 | 内核删 platform/db.py 前，所有仍走旧路径的引擎端点必须先有 TS 供数版本；本清单 §3/§4 的「不宜拆」是 P3 的阻塞项，需要单独决策 |