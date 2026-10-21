# W3 Phase 0 · 路由清单（Route Inventory）

> 生成工具：`backend/ts-migration/export_routes.py`（打桩法 import worker main，只读路由元数据，不跑服务器）。
> 口径：每行 = 一个 FastAPI APIRoute（method+path+endpoint）；一个 endpoint 挂多 method 算 1 条。
> 排序：按文件分组、组内按源码行号。
> 「平台运营」判定：Depends 树 ∪ handler 函数体静态扫描（_require_platform_ops( / _require_ai_admin(）。

## 总数核对

| 指标 | 数量 | 期望 | 结论 |
|---|---|---|---|
| APIRoute 业务路由 | 249 | — | — |
| FastAPI 内置（openapi/docs/redoc） | 4 | — | — |
| **app.routes 合计** | **253** | **253** | **✅ 一致** |
| method×path 展开行数 | 249 | — | 仅供参考 |

> 核对说明：计划 §2 Phase 0 登记的 253 = app.routes 全部条目；其中 4 条是 FastAPI 默认
> 挂载的文档路由（不参与业务迁移；TS 侧 Hono 是否镜像留给 Phase 1 决定）：
>
> - GET, HEAD `/openapi.json`
> - GET, HEAD `/docs`
> - GET, HEAD `/docs/oauth2-redirect`
> - GET, HEAD `/redoc`

## 按域汇总（迁移排序用）

| 域 | 路由数 |
|---|---|
| quotes | 38 |
| trade-docs | 38 |
| workstations | 35 |
| intel | 34 |
| customers | 20 |
| orders | 16 |
| teams | 15 |
| outreach | 12 |
| admin | 11 |
| auth | 9 |
| files | 9 |
| ai | 8 |
| cron | 2 |
| dashboard | 1 |
| meta | 1 |

## 按文件分组明细

### `worker/src/chain.py`（41 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/ai/tasks` | `ai_tasks` | :545 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/providers` | `ai_list_providers` | :580 | `_get_current_user` | ✅ | ✅ | ai |
| PUT | `/api/v1/ai/providers/{name}` | `ai_upsert_provider` | :596 | `_get_current_user` | ✅ | ✅ | ai |
| POST | `/api/v1/ai/providers/{name}/test` | `ai_test_provider` | :624 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/task-bindings` | `ai_list_bindings` | :651 | `_get_current_user` | ✅ | ✅ | ai |
| PUT | `/api/v1/ai/task-bindings/{task_key}` | `ai_upsert_binding` | :671 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/ai/usage` | `ai_usage` | :707 | `_get_current_user` | ✅ | ✅ | ai |
| POST | `/api/v1/ai/tasks/{task_key}/run` | `ai_run_task` | :747 | `_get_current_user` | ✅ | ✅ | ai |
| GET | `/api/v1/leadgen/regions` | `leadgen_regions` | :970 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/validate` | `leadgen_validate` | :975 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/runs` | `leadgen_create_run` | :1015 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leadgen/runs/from-csv` | `leadgen_create_run_csv` | :1021 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leadgen/runs` | `leadgen_list_runs` | :1030 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leadgen/runs/{run_id}` | `leadgen_get_run` | :1047 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads` | `lead_create` | :1367 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leads` | `lead_list` | :1399 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads/scan-replied` | `lead_scan_replied` | :1434 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/leads/{lead_id}` | `lead_get` | :1486 | `_get_current_user` | ✅ | — | intel |
| PATCH | `/api/v1/leads/{lead_id}` | `lead_patch` | :1539 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/outreach/mailboxes` | `mb_list` | :1682 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/mailboxes` | `mb_create` | :1692 | `_get_current_user` | ✅ | — | outreach |
| PATCH | `/api/v1/outreach/mailboxes/{mailbox_id}` | `mb_patch` | :1716 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/mailboxes/{mailbox_id}/test` | `mb_test` | :1749 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/campaigns` | `camp_list` | :1787 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/campaigns` | `camp_create` | :1797 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/generate` | `camp_generate` | :1811 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/campaigns/{campaign_id}/send` | `camp_send` | :1819 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/messages` | `msg_list` | :1896 | `_get_current_user` | ✅ | — | outreach |
| GET | `/api/v1/outreach/messages/{message_id}` | `msg_get` | :1925 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/messages/{message_id}/retry` | `msg_retry` | :1938 | `_get_current_user` | ✅ | — | outreach |
| POST | `/api/v1/outreach/webhook` | `outreach_webhook` | :1974 | — | — | — | outreach |
| POST | `/api/v1/leads/{lead_id}/crawl` | `lead_crawl` | :2051 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/leads/crawl-batch` | `lead_crawl_batch` | :2076 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/categories` | `research_categories` | :2179 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/products` | `research_list` | :2184 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/stats` | `research_stats` | :2226 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/research/products` | `research_create` | :2251 | `_get_current_user` | ✅ | — | intel |
| PATCH | `/api/v1/research/products/{research_id}` | `research_patch` | :2323 | `_get_current_user` | ✅ | — | intel |
| DELETE | `/api/v1/research/products/{research_id}` | `research_delete` | :2356 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/research/from-leadgen` | `research_from_leadgen` | :2375 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/research/runs` | `research_runs` | :2417 | `_get_current_user` | ✅ | — | intel |

### `worker/src/main.py`（75 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| POST | `/api/v1/auth/bootstrap-admin` | `bootstrap_admin` | :295 | — | — | — | auth |
| POST | `/api/v1/auth/login` | `login` | :335 | — | — | — | auth |
| GET | `/api/v1/auth/me` | `get_me` | :387 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/logout` | `logout` | :406 | — | — | — | auth |
| PATCH | `/api/v1/auth/me` | `update_me` | :447 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/change-password` | `change_password` | :479 | `_get_current_user` | ✅ | — | auth |
| POST | `/api/v1/auth/forgot-password` | `forgot_password` | :668 | — | — | — | auth |
| POST | `/api/v1/auth/reset-password` | `reset_password` | :704 | — | — | — | auth |
| POST | `/api/v1/auth/register` | `register` | :796 | — | — | — | auth |
| GET | `/api/v1/intel/shipments` | `list_shipments` | :943 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/shipments/{shipment_id}` | `get_shipment` | :977 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/intel/shipments` | `create_shipment` | :989 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/intel/import/csv` | `import_csv` | :1004 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/trade-stats` | `list_trade_stats` | :1057 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/adapter-runs` | `list_adapter_runs` | :1081 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/intel/channels` | `list_channels` | :1102 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/customers` | `list_customers` | :1368 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers` | `create_customer` | :1429 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customers/{customer_id}` | `get_customer` | :1502 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers/{customer_id}/contacts` | `add_contact` | :1533 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | `update_contact` | :1565 | `_get_current_user` | ✅ | — | customers |
| DELETE | `/api/v1/customers/{customer_id}/contacts/{contact_id}` | `delete_contact` | :1597 | `_get_current_user` | ✅ | — | customers |
| DELETE | `/api/v1/customers/{customer_id}` | `soft_delete_customer` | :1615 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/customers/{customer_id}/inquiries` | `add_inquiry` | :1646 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customers/{customer_id}/stage` | `update_stage` | :1675 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/market/regions` | `list_market_regions` | :1741 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/regions/{region_code}/products` | `list_region_products` | :1751 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/name-lookup` | `name_lookup` | :1774 | `_get_current_user` | ✅ | — | intel |
| POST | `/api/v1/market/name-mappings` | `create_name_mapping` | :1794 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/usages` | `list_usages` | :1809 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/market/ports` | `list_ports` | :1818 | `_get_current_user` | ✅ | — | intel |
| GET | `/api/v1/subscriptions` | `list_subscriptions` | :1841 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/subscriptions/bundles` | `list_bundles` | :1850 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/dashboard/summary` | `dashboard_summary` | :1860 | `_get_current_user` | ✅ | — | dashboard |
| GET | `/health` | `health` | :1925 | — | — | — | meta |
| POST | `/api/v1/events` | `create_event` | :1954 | `_get_current_user` | ✅ | — | cron |
| GET | `/api/v1/quotations` | `list_quotations_api` | :2005 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotations` | `create_quotation_manual` | :2047 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/pricing-data` | `list_pricing_data` | :2156 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/pricing-data` | `create_pricing_data` | :2261 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/pricing-data/{item_id}` | `update_pricing_data` | :2369 | `_get_current_user` | ✅ | — | quotes |
| DELETE | `/api/v1/pricing-data/{item_id}` | `delete_pricing_data` | :2437 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/spec/categories` | `list_spec_categories` | :2577 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/spec/categories/{category_id}` | `get_spec_category` | :2593 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/spec/categories/{category_id}/bindings` | `get_spec_category_bindings` | :2608 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/spec/wizard/submit` | `wizard_submit` | :2666 | `_get_current_user` | ✅ | — | workstations |
| POST | `/api/v1/spec/wizard/propose-attribute` | `wizard_propose_attribute` | :2736 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/events` | `list_events_api` | :2779 | `_get_current_user` | ✅ | ✅ | cron |
| GET | `/api/v1/admin/feature_flag` | `get_feature_flag` | :2819 | `_get_current_user` | ✅ | ✅ | admin |
| POST | `/api/v1/admin/feature_flag` | `set_feature_flag` | :2853 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/tenants` | `list_tenants` | :2905 | `_get_current_user` | ✅ | ✅ | admin |
| POST | `/api/v1/admin/tenants/reload` | `reload_tenants` | :2922 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/audit-log` | `get_audit_log` | :2951 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/admin/archive-logs` | `get_archive_logs` | :3019 | `_get_current_user` | ✅ | ✅ | admin |
| GET | `/api/v1/capability-customers` | `list_capability_customers` | :3096 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/capabilities` | `list_capabilities_api` | :3118 | `_get_current_user` | ✅ | — | customers |
| POST | `/api/v1/capabilities` | `upsert_capability_api` | :3140 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customer/{customer_id}/capabilities` | `get_customer_capabilities` | :3180 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/customer/{customer_id}/capabilities` | `patch_customer_capability` | :3198 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/orders` | `list_orders_api` | :3389 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders` | `create_order_api` | :3467 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}` | `get_order_api` | :3683 | `_get_current_user` | ✅ | — | orders |
| PATCH | `/api/v1/orders/{order_id}` | `update_order_api` | :3736 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/status` | `change_order_status` | :3849 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/orders/{order_id}/payment-schedules` | `list_schedules` | :3941 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/orders/{order_id}/payment-schedules` | `create_schedule` | :3959 | `_get_current_user` | ✅ | — | orders |
| PATCH | `/api/v1/payment-schedules/{schedule_id}` | `update_schedule` | :4006 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/receivables` | `list_receivables` | :4100 | `_get_current_user` | ✅ | — | orders |
| GET | `/api/v1/trade-docs` | `list_trade_docs` | :4328 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/trade-docs` | `create_trade_doc` | :4482 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/trade-docs/{doc_id}` | `get_trade_doc` | :4622 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/trade-docs/{doc_id}` | `update_trade_doc` | :4647 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/tenant/company-profile` | `get_company_profile` | :4858 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/tenant/company-profile` | `put_company_profile` | :4871 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/trade-docs/{doc_id}/render-data` | `get_trade_doc_render_data` | :5016 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/quote_api.py`（19 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/export-quote/products` | `export_quote_products` | :339 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/formulas` | `export_quote_product_formulas` | :414 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/terms/template` | `export_quote_terms_template` | :447 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/calculate` | `export_quote_calculate` | :886 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/calculate-internal` | `export_quote_calculate_internal` | :899 | `_require_internal_admin_dep` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/verify` | `export_quote_verify` | :909 | `_require_internal_admin_dep` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/import/template` | `export_quote_import_template` | :1002 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/import-template` | `export_quote_import_template_info` | :1020 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/import/preview` | `export_quote_import_preview` | :1067 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/export-quote/import/calculate` | `export_quote_import_calculate` | :1089 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes` | `list_quote_orders` | :1738 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotes` | `create_quote_order` | :1803 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/quotes/batch` | `create_quote_batch` | :1881 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/reference-price` | `quote_reference_price` | :1922 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/cost-reference` | `quote_cost_reference` | :1974 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/quotes/{quote_id}` | `get_quote_order` | :2055 | `_get_current_user` | ✅ | — | quotes |
| PATCH | `/api/v1/quotes/{quote_id}` | `update_quote_order` | :2081 | `_get_current_user` | ✅ | — | quotes |
| PUT | `/api/v1/quotes/{quote_id}/items` | `replace_quote_items` | :2214 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/export-quote/products/{product_key}/spec` | `export_quote_product_spec` | :2262 | `_get_current_user` | ✅ | — | quotes |

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

### `worker/src/ws_clause_templates.py`（4 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/clause-templates` | `list_clause_templates` | :192 | `_get_current_user` | ✅ | — | trade-docs |
| POST | `/api/v1/clause-templates` | `create_clause_template` | :226 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/clause-templates/{template_id}` | `update_clause_template` | :262 | `_get_current_user` | ✅ | — | trade-docs |
| DELETE | `/api/v1/clause-templates/{template_id}` | `delete_clause_template` | :316 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_crm_ext.py`（5 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| PATCH | `/api/v1/customers/{customer_id}` | `update_customer` | :166 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/customers/{customer_id}/inquiries` | `list_customer_inquiries` | :216 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/inquiries` | `list_inquiries` | :259 | `_get_current_user` | ✅ | — | customers |
| PATCH | `/api/v1/inquiries/{inquiry_id}` | `update_inquiry` | :301 | `_get_current_user` | ✅ | — | customers |
| GET | `/api/v1/inquiries/{inquiry_id}/stage-log` | `list_inquiry_stage_log` | :413 | `_get_current_user` | ✅ | — | customers |

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
| GET | `/api/v1/fx-rates` | `list_fx_rates` | :162 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/fx-rates/latest` | `latest_fx_rate` | :179 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/fx-rates/_debug` | `fx_provider_debug` | :196 | `_get_current_user` | ✅ | — | quotes |
| POST | `/api/v1/fx-rates` | `upsert_fx_rate` | :217 | `_get_current_user` | ✅ | — | quotes |
| GET | `/api/v1/actual-costs` | `list_actual_costs` | :262 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/actual-costs` | `create_actual_cost` | :284 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/actual-costs/resolve` | `resolve_actual_cost` | :311 | `_get_current_user` | ✅ | — | orders |
| POST | `/api/v1/external-docs` | `upload_external_doc` | :335 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/external-docs` | `list_external_docs` | :362 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/external-docs/{doc_id}/download` | `download_external_doc` | :392 | `_get_current_user` | ✅ | — | trade-docs |
| PATCH | `/api/v1/external-docs/{doc_id}` | `update_external_doc` | :405 | `_get_current_user` | ✅ | — | trade-docs |
| DELETE | `/api/v1/external-docs/{doc_id}` | `delete_external_doc` | :420 | `_get_current_user` | ✅ | — | trade-docs |

### `worker/src/ws_files.py`（19 条）

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
| POST | `/api/v1/trade-docs/{doc_id}/pdf` | `render_doc_pdf` | :851 | `_get_current_user` | ✅ | — | trade-docs |
| GET | `/api/v1/file-objects/{file_id}/render-content` | `get_file_render_content` | :977 | — | — | — | files |
| POST | `/api/v1/file-objects/presign` | `presign_upload` | :1037 | `_get_current_user` | ✅ | — | files |
| POST | `/api/v1/file-objects/register` | `register_upload` | :1053 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects/_r2_debug` | `r2_debug` | :1066 | `_get_current_user` | ✅ | — | files |
| GET | `/api/v1/file-objects/{file_id}/url` | `get_file_url` | :1111 | `_get_current_user` | ✅ | — | files |

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
| POST | `/api/v1/export-quote/products/{product_key}/explain` | `export_quote_explain_product` | :127 | `_get_current_user` | ✅ | — | quotes |

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
| POST | `/api/v1/teams/{team_id}/transfer` | `transfer_team` | :507 | `_get_current_user` | ✅ | — | teams |
| PUT | `/api/v1/teams/{team_id}/members/{user_id}/console-access` | `set_console_access` | :547 | `_get_current_user` | ✅ | — | teams |

### `worker/src/ws_workstations.py`（7 条）

| Method | Path | Endpoint | 行号 | Depends | 登录态 | 平台运营 | 域 |
|---|---|---|---|---|---|---|---|
| GET | `/api/v1/me/workstations` | `my_workstations` | :122 | `_get_current_user` | ✅ | — | workstations |
| GET | `/api/v1/teams/{team_id}/subscriptions` | `list_team_subscriptions` | :154 | `_get_current_user` | ✅ | — | teams |
| PUT | `/api/v1/teams/{team_id}/subscriptions/{code}` | `set_team_subscription` | :168 | `_get_current_user` | ✅ | — | teams |
| DELETE | `/api/v1/teams/{team_id}/subscriptions/{code}` | `revoke_team_subscription` | :199 | `_get_current_user` | ✅ | — | teams |
| GET | `/api/v1/users/{user_id}/subscriptions` | `list_user_subscriptions` | :229 | `_get_current_user` | ✅ | — | workstations |
| PUT | `/api/v1/users/{user_id}/subscriptions/{code}` | `set_user_subscription` | :243 | `_get_current_user` | ✅ | — | workstations |
| DELETE | `/api/v1/users/{user_id}/subscriptions/{code}` | `revoke_user_subscription` | :271 | `_get_current_user` | ✅ | — | workstations |
