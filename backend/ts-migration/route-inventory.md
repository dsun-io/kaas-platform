# W3 Phase 0 · 路由清单（Route Inventory）

> 生成工具：`backend/ts-migration/export_routes.py`（打桩法 import worker main，只读路由元数据，不跑服务器）。
> 口径：每行 = 一个 FastAPI APIRoute（method+path+endpoint）；一个 endpoint 挂多 method 算 1 条。
> 排序：按文件分组、组内按源码行号。
> 「平台运营」判定：Depends 树 ∪ handler 函数体静态扫描（_require_platform_ops( / _require_ai_admin(）。

## 总数核对

| 指标 | 数量 | 期望 | 结论 |
|---|---|---|---|
| APIRoute 业务路由 | 281 | — | — |
| FastAPI 内置（openapi/docs/redoc） | 4 | — | — |
| **app.routes 合计** | **285** | **283** | **⚠️ 仍不符（差 +2，需人工复查）** |
| method×path 展开行数 | 281 | — | 仅供参考 |

> 核对说明：计划 §2 Phase 0 登记的 253 = app.routes 全部条目；其中 4 条是 FastAPI 默认
> 挂载的文档路由（不参与业务迁移；TS 侧 Hono 是否镜像留给 Phase 1 决定）：
>
> - GET, HEAD `/openapi.json`
> - GET, HEAD `/docs`
> - GET, HEAD `/docs/oauth2-redirect`
> - GET, HEAD `/redoc`

> ⚠️ 仍有 12 条路由域归属为 misc，需人工确认规则。

## 按域汇总（迁移排序用）

| 域 | 路由数 |
|---|---|
| quotes | 40 |
| trade-docs | 38 |
| intel | 37 |
| workstations | 35 |
| orders | 24 |
| customers | 21 |
| teams | 19 |
| misc | 12 |
| outreach | 12 |
| admin | 11 |
| auth | 9 |
| files | 9 |
| ai | 8 |
| dashboard | 3 |
| cron | 2 |
| meta | 1 |

## 按文件分组明细

### `worker/src/chain.py`（41 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/ai/tasks` | `ai_tasks` | :548 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/providers` | `ai_list_providers` | :583 | `_get_current_user` | ✅ | ✅ | ai |
| PUT | `/api/v1/ai/providers/{name}` | `ai_upsert_provider` | :599 | `_get_current_user` | ✅ | ✅ | ai |
| POST | `/api/v1/ai/providers/{name}/test` | `ai_test_provider` | :627 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/task-bindings` | `ai_list_bindings` | :654 | `_get_current_user` | ✅ | ✅ | ai |
| PUT | `/api/v1/ai/task-bindings/{task_key}` | `ai_upsert_binding` | :674 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/usage` | `ai_usage` | :710 | `_get_current_user` | ✅ | ✅ | ai |
| POST | `/api/v1/ai/tasks/{task_key}/run` | `ai_run_task` | :750 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/leadgen/regions` | `leadgen_regions` | :973 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/validate` | `leadgen_validate` | :978 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/runs` | `leadgen_create_run` | :1018 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/runs/from-csv` | `leadgen_create_run_csv` | :1024 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leadgen/runs` | `leadgen_list_runs` | :1033 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leadgen/runs/{run_id}` | `leadgen_get_run` | :1050 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads` | `lead_create` | :1370 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leads` | `lead_list` | :1402 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads/scan-replied` | `lead_scan_replied` | :1437 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leads/{lead_id}` | `lead_get` | :1489 | `_get_current_user` | ✅ | — | intel |
| PATCH | `/api/v1/leads/{lead_id}` | `lead_patch` | :1542 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/outreach/mailboxes` | `mb_list` | :1685 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/mailboxes` | `mb_create` | :1695 | `_get_current_user` | ✅ | — | outreach |
| PATCH | `/api/v1/outreach/mailboxes/{mailbox_id}` | `mb_patch` | :1719 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/mailboxes/{mailbox_id}/test` | `mb_test` | :1752 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/campaigns` | `camp_list` | :1790 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/campaigns` | `camp_create` | :1800 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/generate` | `camp_generate` | :1814 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/campaigns/{campaign_id}/send` | `camp_send` | :1822 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/messages` | `msg_list` | :1899 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/messages/{message_id}` | `msg_get` | :1928 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/messages/{message_id}/retry` | `msg_retry` | :1941 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/webhook` | `outreach_webhook` | :1977 | — | — | — | outreach |
| POST | `/api/v1/leads/{lead_id}/crawl` | `lead_crawl` | :2054 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads/crawl-batch` | `lead_crawl_batch` | :2079 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/categories` | `research_categories` | :2182 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/products` | `research_list` | :2187 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/stats` | `research_stats` | :2229 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/research/products` | `research_create` | :2254 | `_get_current_user` | ✅ | — | intel |
| PATCH | `/api/v1/research/products/{research_id}` | `research_patch` | :2326 | `_get_current_user` | ✅ | — | intel |
| DELETE | `/api/v1/research/products/{research_id}` | `research_delete` | :2359 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/research/from-leadgen` | `research_from_leadgen` | :2378 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/runs` | `research_runs` | :2420 | `_get_current_user` | ✅ | — | intel |

### `worker/src/imports_api.py`（2 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/imports/orders/preview` | `preview_import_orders` | :338 | `_get_current_user` | ✅ | — | misc |
| POST | `/api/v1/imports/orders` | `create_import_orders` | :368 | `_get_current_user` | ✅ | — | misc |

### `worker/src/main.py`（82 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/bootstrap-admin` | `bootstrap_admin` | :313 | — | — | — | auth |
| POST | `/api/v1/auth/login` | `login` | :353 | — | — | — | auth |
| GET | `/api/v1/auth/me` | `get_me` | :405 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/logout` | `logout` | :424 | — | — | — | auth |
| PATCH | `/api/v1/auth/me` | `update_me` | :465 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/change-password` | `change_password` | :497 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/forgot-password` | `forgot_password` | :687 | — | — | — | auth |
| POST | `/api/v1/auth/reset-password` | `reset_password` | :723 | — | — | — | auth |
| POST | `/api/v1/auth/register` | `register` | :819 | — | — | — | auth |
| GET | `/api/v1/intel/shipments` | `list_shipments` | :1013 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/shipments/{shipment_id}` | `get_shipment` | :1047 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/intel/shipments` | `create_shipment` | :1059 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/intel/import/csv` | `import_csv` | :1074 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/trade-stats` | `list_trade_stats` | :1127 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/adapter-runs` | `list_adapter_runs` | :1151 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/channels` | `list_channels` | :1172 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/customers` | `list_customers` | :1557 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers` | `create_customer` | :1618 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customers/{customer_id}` | `get_customer` | :1691 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers/{customer_id}/contacts` | `add_contact` | :1722 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | `update_contact` | :1754 | `_get_current_user` | ✅ | — | customers |
| DELETE | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | `delete_contact` | :1786 | `_get_current_user` | ✅ | — | customers |
| DELETE | `/api/v1/customers/{customer_id}` | `soft_delete_customer` | :1804 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers/{customer_id}/inquiries` | `add_inquiry` | :1835 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customers/{customer_id}/stage` | `update_stage` | :1876 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/market/regions` | `list_market_regions` | :1962 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/regions/{region_code}/products` | `list_region_products` | :1972 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/name-lookup` | `name_lookup` | :1995 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/market/name-mappings` | `create_name_mapping` | :2015 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/name-mappings` | `list_name_mappings` | :2030 | `_get_current_user` | ✅ | — | intel |
| PATCH | `/api/v1/market/name-mappings/{mapping_id}` | `update_name_mapping` | :2072 | `_get_current_user` | ✅ | — | intel |
| DELETE | `/api/v1/market/name-mappings/{mapping_id}` | `delete_name_mapping` | :2121 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/usages` | `list_usages` | :2139 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/ports` | `list_ports` | :2148 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/subscriptions` | `list_subscriptions` | :2171 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/subscriptions/bundles` | `list_bundles` | :2180 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/dashboard/summary` | `dashboard_summary` | :2190 | `_get_current_user` | ✅ | — | dashboard |
| GET | `/api/v1/dashboard/funnel` | `dashboard_funnel` | :2305 | `_get_current_user` | ✅ | — | dashboard |
| GET | `/api/v1/dashboard/receivables` | `dashboard_receivables` | :2370 | `_get_current_user` | ✅ | — | dashboard |
| GET | `/health` | `health` | :2423 | — | — | — | meta |
| POST | `/api/v1/events` | `create_event` | :2452 | `_get_current_user` | ✅ | — | cron |
| GET | `/api/v1/quotations` | `list_quotations_api` | :2504 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotations` | `create_quotation_manual` | :2546 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/pricing-data` | `list_pricing_data` | :2655 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/pricing-data` | `create_pricing_data` | :2760 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/pricing-data/{item_id}` | `update_pricing_data` | :2868 | `_get_current_user` | ✅ | — | quotes |
| DELETE | `/api/v1/pricing-data/{item_id}` | `delete_pricing_data` | :2936 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/spec/categories` | `list_spec_categories` | :3076 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/spec/categories/{category_id}` | `get_spec_category` | :3092 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/spec/categories/{category_id}/bindings` | `get_spec_category_bindings` | :3107 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/spec/wizard/submit` | `wizard_submit` | :3165 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/spec/wizard/propose-attribute` | `wizard_propose_attribute` | :3235 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/events` | `list_events_api` | :3278 | `_get_current_user` | ✅ | ✅ | cron |
| GET | `/api/v1/admin/feature_flag` | `get_feature_flag` | :3318 | `_get_current_user` | ✅ | ✅ | admin |
| POST | `/api/v1/admin/feature_flag` | `set_feature_flag` | :3352 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/tenants` | `list_tenants` | :3404 | `_get_current_user` | ✅ | ✅ | admin |
| POST | `/api/v1/admin/tenants/reload` | `reload_tenants` | :3421 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/audit-log` | `get_audit_log` | :3450 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/archive-logs` | `get_archive_logs` | :3518 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/capability-customers` | `list_capability_customers` | :3595 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/capabilities` | `list_capabilities_api` | :3617 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/capabilities` | `upsert_capability_api` | :3639 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customer/{customer_id}/capabilities` | `get_customer_capabilities` | :3679 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customer/{customer_id}/capabilities` | `patch_customer_capability` | :3697 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/orders` | `list_orders_api` | :3920 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders` | `create_order_api` | :4087 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}` | `get_order_api` | :4423 | `_get_current_user` | ✅ | — | orders |
| PATCH | `/api/v1/orders/{order_id}` | `update_order_api` | :4488 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/status` | `change_order_status` | :4705 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}/payment-schedules` | `list_schedules` | :4790 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/payment-schedules` | `create_schedule` | :4808 | `_get_current_user` | ✅ | — | orders |
| PATCH | `/api/v1/payment-schedules/{schedule_id}` | `update_schedule` | :4855 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}/receipts` | `list_order_receipts` | :5031 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/receipts` | `create_order_receipt` | :5043 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/receivables` | `list_receivables` | :5112 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/trade-docs` | `list_trade_docs` | :5340 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs` | `create_trade_doc` | :5503 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}` | `get_trade_doc` | :5647 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/trade-docs/{doc_id}` | `update_trade_doc` | :5672 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/tenant/company-profile` | `get_company_profile` | :5886 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/tenant/company-profile` | `put_company_profile` | :5899 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/trade-docs/{doc_id}/render-data` | `get_trade_doc_render_data` | :6061 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/quote_api.py`（21 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/export-quote/products` | `export_quote_products` | :399 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/formulas` | `export_quote_product_formulas` | :430 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/terms/template` | `export_quote_terms_template` | :463 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/calculate` | `export_quote_calculate` | :906 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/calculate-internal` | `export_quote_calculate_internal` | :919 | `_require_internal_admin_dep` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/verify` | `export_quote_verify` | :929 | `_require_internal_admin_dep` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/import/template` | `export_quote_import_template` | :1032 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/import-template` | `export_quote_import_template_info` | :1050 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/import/preview` | `export_quote_import_preview` | :1097 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/import/order/template-info` | `export_quote_import_order_template_info` | :1119 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/import/order/preview` | `export_quote_import_order_preview` | :1166 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/import/calculate` | `export_quote_import_calculate` | :1186 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes` | `list_quote_orders` | :1835 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotes` | `create_quote_order` | :1900 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotes/batch` | `create_quote_batch` | :1978 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/reference-price` | `quote_reference_price` | :2019 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/cost-reference` | `quote_cost_reference` | :2071 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/{quote_id}` | `get_quote_order` | :2152 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/quotes/{quote_id}` | `update_quote_order` | :2178 | `_get_current_user` | ✅ | — | quotes |
| PUT | `/api/v1/quotes/{quote_id}/items` | `replace_quote_items` | :2311 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/spec` | `export_quote_product_spec` | :2359 | `_get_current_user` | ✅ | — | quotes |

### `worker/src/tax_archives.py`（8 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/tax-archives` | `list_tax_archives` | :202 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/tax-archives` | `create_tax_archive` | :218 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/tax-archives/{archive_id}` | `update_tax_archive` | :248 | `_get_current_user` | ✅ | — | quotes |
| DELETE | `/api/v1/tax-archives/{archive_id}` | `delete_tax_archive` | :295 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/product-tax-rates` | `list_product_tax_rates` | :372 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/product-tax-rates` | `create_product_tax_rate` | :386 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/product-tax-rates/{rate_id}` | `update_product_tax_rate` | :440 | `_get_current_user` | ✅ | — | quotes |
| DELETE | `/api/v1/product-tax-rates/{rate_id}` | `delete_product_tax_rate` | :468 | `_get_current_user` | ✅ | — | quotes |

### `worker/src/ws_admin_accounts.py`（2 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/accounts` | `list_accounts` | :53 | `_get_current_user` | ✅ | — | admin |
| PATCH | `/api/v1/admin/accounts/{user_id}` | `update_account_status` | :80 | `_get_current_user` | ✅ | — | admin |

### `worker/src/ws_admin_proposals.py`（3 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/admin/spec/attribute-proposals` | `list_attribute_proposals` | :71 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/spec/attribute-proposals/recommended` | `list_recommended_proposals` | :91 | `_get_current_user` | ✅ | ✅ | admin |
| PATCH | `/api/v1/admin/spec/attribute-proposals/{proposal_id}` | `review_attribute_proposal` | :108 | `_get_current_user` | ✅ | ✅ | admin |

### `worker/src/ws_approvals.py`（11 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/orders/{order_id}/item-change-requests` | `create_item_change_request` | :220 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}/item-change-requests` | `list_item_change_requests` | :295 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/item-change-requests/{rid}/approve` | `approve_item_change_request` | :456 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/item-change-requests/{rid}/reject` | `reject_item_change_request` | :466 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/approvals` | `list_approvals` | :478 | `_get_current_user` | ✅ | — | misc |
| GET | `/api/v1/notifications` | `list_notifications` | :591 | `_get_current_user` | ✅ | — | misc |
| GET | `/api/v1/notifications/unread-count` | `unread_notification_count` | :618 | `_get_current_user` | ✅ | — | misc |
| POST | `/api/v1/notifications/{notification_id}/read` | `mark_notification_read` | :632 | `_get_current_user` | ✅ | — | misc |
| POST | `/api/v1/notifications/read-all` | `mark_all_notifications_read` | :650 | `_get_current_user` | ✅ | — | misc |
| GET | `/api/v1/team/approvers` | `list_team_approvers` | :669 | `_get_current_user` | ✅ | — | misc |
| PUT | `/api/v1/team/approvers` | `replace_team_approvers` | :693 | `_get_current_user` | ✅ | — | misc |

### `worker/src/ws_clause_templates.py`（4 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/clause-templates` | `list_clause_templates` | :192 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/clause-templates` | `create_clause_template` | :226 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/clause-templates/{template_id}` | `update_clause_template` | :262 | `_get_current_user` | ✅ | — | trade-docs |
| DELETE | `/api/v1/clause-templates/{template_id}` | `delete_clause_template` | :316 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_crm_ext.py`（6 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| PATCH | `/api/v1/customers/{customer_id}` | `update_customer` | :210 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customers/{customer_id}/inquiries` | `list_customer_inquiries` | :260 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/inquiries` | `list_inquiries` | :303 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/inquiries/{inquiry_id}` | `get_inquiry` | :402 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/inquiries/{inquiry_id}` | `update_inquiry` | :482 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/inquiries/{inquiry_id}/stage-log` | `list_inquiry_stage_log` | :609 | `_get_current_user` | ✅ | — | customers |

### `worker/src/ws_customer_records.py`（1 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/customers/{customer_id}/records` | `customer_records` | :36 | `_get_current_user` | ✅ | — | customers |

### `worker/src/ws_docs_ext.py`（8 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/trade-docs/{doc_id}/refresh-sources` | `refresh_trade_doc_sources` | :150 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/confirm` | `confirm_trade_doc` | :237 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/render-fingerprint-check` | `check_trade_doc_render_fingerprint` | :384 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/render-fingerprint-checks/batch` | `batch_check_trade_doc_render_fingerprints` | :438 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/translate` | `translate_trade_doc` | :555 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/content-versions` | `list_trade_doc_content_versions` | :625 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/content-versions/{version_no}` | `get_trade_doc_content_version` | :659 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/content-versions/{version_no}/restore` | `restore_trade_doc_content_version` | :690 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_docs_hardening.py`（11 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/trade-docs/{doc_id}/facts` | `list_trade_doc_facts` | :600 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/facts/confirm` | `confirm_trade_doc_facts` | :625 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/trade-docs/{doc_id}/facts/{fact_key}` | `patch_trade_doc_fact` | :683 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/consistency` | `get_trade_doc_consistency` | :770 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/lint` | `lint_trade_doc` | :983 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/receipts` | `list_trade_doc_receipts` | :1048 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/receipts` | `create_trade_doc_receipt` | :1069 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}/doc-set` | `get_trade_doc_doc_set` | :1217 | `_get_current_user` | ✅ | — | trade-docs |
| PUT | `/api/v1/trade-docs/{doc_id}/doc-set` | `put_trade_doc_doc_set` | :1239 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/doc-set/{doc_type}/receipt` | `record_doc_set_receipt` | :1305 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/verify-export` | `verify_trade_doc_export` | :1369 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_enums.py`（1 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/enums` | `list_enums` | :25 | — | — | — | workstations |

### `worker/src/ws_extras.py`（12 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/fx-rates` | `list_fx_rates` | :163 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/fx-rates/latest` | `latest_fx_rate` | :180 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/fx-rates/_debug` | `fx_provider_debug` | :197 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/fx-rates` | `upsert_fx_rate` | :218 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/actual-costs` | `list_actual_costs` | :263 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/actual-costs` | `create_actual_cost` | :285 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/actual-costs/resolve` | `resolve_actual_cost` | :312 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/external-docs` | `upload_external_doc` | :336 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/external-docs` | `list_external_docs` | :363 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/external-docs/{doc_id}/download` | `download_external_doc` | :393 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/external-docs/{doc_id}` | `update_external_doc` | :418 | `_get_current_user` | ✅ | — | trade-docs |
| DELETE | `/api/v1/external-docs/{doc_id}` | `delete_external_doc` | :433 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_files.py`（22 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/products` | `list_products` | :378 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/products/{product_key}/profile` | `get_profile` | :415 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/products/{product_key}/profile` | `put_profile` | :440 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/products/{product_key}/media` | `list_media` | :461 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/products/{product_key}/media` | `upload_media` | :473 | `_get_current_user` | ✅ | — | workstations |
| PATCH | `/api/v1/file-objects/{file_id}` | `patch_file` | :496 | `_get_current_user` | ✅ | — | files |
| DELETE | `/api/v1/file-objects/{file_id}` | `retire_file` | :545 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects/{file_id}/content` | `get_file_content` | :558 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects` | `list_files` | :574 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/trade-docs/{doc_id}/files` | `list_doc_files` | :600 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/files` | `attach_doc_file` | :620 | `_get_current_user` | ✅ | — | trade-docs |
| DELETE | `/api/v1/trade-docs/{doc_id}/files/{link_id}` | `detach_doc_file` | :651 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs/{doc_id}/files/upload` | `upload_doc_file` | :663 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/orders/{order_id}/files` | `list_order_files` | :700 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/files` | `upload_order_file` | :715 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/payment-receipts/{receipt_id}/files` | `upload_receipt_file` | :742 | `_get_current_user` | ✅ | — | misc |
| POST | `/api/v1/trade-docs/{doc_id}/pdf` | `render_doc_pdf` | :946 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/file-objects/{file_id}/render-content` | `get_file_render_content` | :1072 | — | — | — | files |
| POST | `/api/v1/file-objects/presign` | `presign_upload` | :1132 | `_get_current_user` | ✅ | — | files |
| POST | `/api/v1/file-objects/register` | `register_upload` | :1148 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects/_r2_debug` | `r2_debug` | :1161 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects/{file_id}/url` | `get_file_url` | :1206 | `_get_current_user` | ✅ | — | files |

### `worker/src/ws_join_applications.py`（6 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/teams/check-name` | `check_team_name` | :93 | — | — | — | teams |
| GET | `/api/v1/me/join-application` | `my_join_application` | :115 | `_get_current_user` | ✅ | — | misc |
| POST | `/api/v1/join-applications/{application_id}/cancel` | `cancel_application` | :131 | `_get_current_user` | ✅ | — | misc |
| GET | `/api/v1/teams/{team_id}/join-applications` | `list_applications` | :163 | `_get_current_user` | ✅ | — | teams |
| POST | `/api/v1/teams/{team_id}/join-applications/{application_id}/approve` | `approve_application` | :194 | `_get_current_user` | ✅ | — | teams |
| POST | `/api/v1/teams/{team_id}/join-applications/{application_id}/reject` | `reject_application` | :242 | `_get_current_user` | ✅ | — | teams |

### `worker/src/ws_option_overrides.py`（2 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/product-options/overrides` | `list_option_overrides` | :169 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/product-options/overrides` | `update_option_overrides` | :219 | `_get_current_user` | ✅ | — | workstations |

### `worker/src/ws_products.py`（8 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/tenant-products` | `list_tenant_products` | :233 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/tenant-products` | `create_tenant_product` | :269 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/tenant-products/{product_id}` | `update_tenant_product` | :306 | `_get_current_user` | ✅ | — | workstations |
| DELETE | `/api/v1/tenant-products/{product_id}` | `delete_tenant_product` | :374 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/workstation-products` | `list_workstation_products` | :426 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/workstation-products` | `set_workstation_product` | :458 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/tenant-product-status` | `list_tenant_product_status` | :502 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/tenant-product-status` | `set_tenant_product_status` | :525 | `_get_current_user` | ✅ | — | workstations |

### `worker/src/ws_quote_ext.py`（1 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/export-quote/products/{product_key}/explain` | `export_quote_explain_product` | :128 | `_get_current_user` | ✅ | — | quotes |

### `worker/src/ws_seals.py`（6 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/tenant/company-seals` | `upload_seal` | :125 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/tenant/company-seals` | `list_seals` | :201 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/tenant/company-seals/{seal_id}/image` | `get_seal_image` | :218 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/tenant/company-seals/{seal_id}/render-content` | `get_seal_render_content` | :239 | — | — | — | workstations |
| PUT | `/api/v1/tenant/company-seals/{seal_id}/default` | `set_default_seal` | :272 | `_get_current_user` | ✅ | — | workstations |
| DELETE | `/api/v1/tenant/company-seals/{seal_id}` | `delete_seal` | :294 | `_get_current_user` | ✅ | — | workstations |

### `worker/src/ws_shipments.py`（4 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/shipments` | `list_shipments` | :171 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/shipments` | `create_shipment` | :213 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/shipments/{shipment_id}` | `get_shipment` | :314 | `_get_current_user` | ✅ | — | orders |
| PATCH | `/api/v1/shipments/{shipment_id}` | `update_shipment` | :323 | `_get_current_user` | ✅ | — | orders |

### `worker/src/ws_teams.py`（12 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/teams` | `create_team` | :160 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/teams/me` | `my_team` | :221 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/teams` | `list_teams` | :246 | `_get_current_user` | ✅ | — | teams |
| PATCH | `/api/v1/teams/{team_id}` | `update_team` | :308 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/teams/{team_id}/members` | `list_members` | :335 | `_get_current_user` | ✅ | — | teams |
| DELETE | `/api/v1/teams/{team_id}/members/{user_id}` | `remove_member` | :355 | `_get_current_user` | ✅ | — | teams |
| POST | `/api/v1/teams/{team_id}/invites` | `create_invite` | :385 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/teams/{team_id}/invites` | `list_invites` | :422 | `_get_current_user` | ✅ | — | teams |
| DELETE | `/api/v1/teams/{team_id}/invites/{invite_id}` | `revoke_invite` | :439 | `_get_current_user` | ✅ | — | teams |
| POST | `/api/v1/teams/join` | `join_team` | :460 | `_get_current_user` | ✅ | — | teams |
| POST | `/api/v1/teams/{team_id}/transfer` | `transfer_team` | :510 | `_get_current_user` | ✅ | — | teams |
| PUT | `/api/v1/teams/{team_id}/members/{user_id}/console-access` | `set_console_access` | :550 | `_get_current_user` | ✅ | — | teams |

### `worker/src/ws_workstations.py`（7 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/me/workstations` | `my_workstations` | :123 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/teams/{team_id}/subscriptions` | `list_team_subscriptions` | :155 | `_get_current_user` | ✅ | — | teams |
| PUT | `/api/v1/teams/{team_id}/subscriptions/{code}` | `set_team_subscription` | :169 | `_get_current_user` | ✅ | — | teams |
| DELETE | `/api/v1/teams/{team_id}/subscriptions/{code}` | `revoke_team_subscription` | :200 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/users/{user_id}/subscriptions` | `list_user_subscriptions` | :230 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/users/{user_id}/subscriptions/{code}` | `set_user_subscription` | :244 | `_get_current_user` | ✅ | — | workstations |
| DELETE | `/api/v1/users/{user_id}/subscriptions/{code}` | `revoke_user_subscription` | :272 | `_get_current_user` | ✅ | — | workstations |
