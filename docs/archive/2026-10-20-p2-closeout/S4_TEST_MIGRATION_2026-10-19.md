# S4 测试处置清单（2026-10-19）

> 本文是 [S4_SINGLE_APP_PLAN_2026-10-19.md](./S4_SINGLE_APP_PLAN_2026-10-19.md) §4 的落地记录：
> 单应用收口（worker 为唯一运行时）后，原 orchestrator 业务壳与其 96 个测试文件的**逐类处置**。
> 判据：S3 parity 测试每域清零 ⇒ 该域 orchestrator 行为测试可删（由 worker 侧用例替代）。

## 0. 结果总览（可复现数字）

| 项 | S4 前 | S4 后 | 说明 |
|---|---|---|---|
| orchestrator 测试文件 | 96 | **20 + conftest** | 只留共享内核纯函数 / ORM 模型 / 迁移 / schema 对齐 |
| orchestrator 测试用例 | 1,220 | **222** | `uv run --extra migrations pytest tests -q` |
| worker 测试用例 | 590 passed + 5 skipped | **954 passed + 5 skipped** | 迁入 15 个报价引擎纯逻辑测试文件（+364 条） |
| worker parity 测试 | auth 66 / CRM 61 / quote 120 | 不变 | 三域差异棘轮已清零（S3） |

## 1. 保留（20 文件 · 222 条）

| 类别 | 文件 |
|---|---|
| 共享内核纯函数 | `test_company_rules.py`、`test_customer_records_tree.py`、`test_customer_stage_rules.py`、`test_entity_links_kernel.py`、`test_files_s3.py`、`test_kaas_common_db.py`、`test_number_rules.py`、`test_product_scope.py`、`test_receipt_rules.py`、`test_team_scope_rules.py`、`test_team_transfer_rules.py`、`test_trade_doc_kernel.py`、`test_workstation_subscriptions.py`、`test_crawl_extract.py` |
| ORM 模型 / schema / 迁移 | `test_legacy_models.py`、`test_team_scope_schema_parity.py`、`test_alembic_bootstrap.py`、`test_product_team_scope_migration.py`、`test_openapi_schema.py` |

> 这些文件**不 import 已删除的业务模块**，跑法是
> `cd backend/orchestrator; uv run --extra migrations pytest tests -q`（不需要 FastAPI/SQLAlchemy 运行时之外的东西）。
> `tests/conftest.py` 已精简为 win32 事件循环策略；旧 fixtures（HTTP client / test DB）随业务测试一起删除。

## 2. 迁入 worker（15 文件 → `backend/worker/tests/test_kernel_eq_*.py`）

报价引擎真源已从 `orchestrator/app/services/export_quote` 迁到 `backend/kaas_common/export_quote`
（`sync-shared.ps1` 镜像进 worker）。原测试只 import 引擎、不做 HTTP/DB，因此**整文件迁移**，
仅做 import 重定向（`app.services.export_quote` → `kaas_common.export_quote`），断言零改动：

`export_quote_core / engine / formulas / import / template / deer_net / chain_link /
numeric_input / packaging_engine / spec_delta / spec_delta_lists / spec_delta_warning_contract /
effective_spec / terms_dap_ddp / real_data_regression`

两处**显式裁剪**（已写进文件尾部注释）：
- `TestImportApi`（import 文件）：原用例打 orchestrator 的 `/export-quote/import` API；worker 侧
  同一批端点行为由 `tests/test_parity_quote.py` 覆盖（Q1–Q26）。
- `TestTemplateApi` / `TestTemplateClosedLoop`（template 文件）：同上。
- xlsx 相关用例需要 `openpyxl`（Worker 运行时装不了 C 扩展，仅测试期使用）：已加 worker `dev` 依赖。

## 3. 由 worker 侧测试替代（删除）

| 域 | 原 orchestrator 测试（代表） | 替代 |
|---|---|---|
| 认证/账号 | `test_password_reset`、`test_admin_accounts`、`test_teams_api`、`test_teams_transfer_api`、`test_split_model`、`test_shared_identity*` | `tests/test_parity_auth.py`（66）+ `tests/test_admin_authz.py` |
| 客户/询盘 | `test_customer_records_api`、`test_team_scope_read`、`test_tenant_isolation` | `tests/test_parity_crm.py`（61） |
| 报价/订单/单证 | `test_export_quote_api`、`test_quote_item_internal_view`、`test_trade_docs_api`、`test_trade_doc_links/render/seal/product_defaults`、`test_price_reference`、`test_pricing_service` | `tests/test_parity_quote.py`（120）+ 引擎纯逻辑（上节迁入） |
| 管理/平台 | `test_admin_api`、`test_admin_tenants_contract`、`test_capabilities_api`、`test_workstations_api`、`test_option_overrides` | worker `ws_admin*`/`ws_products` 单测 + `test_admin_authz` |
| 系统层（CORS/限流/指标/中间件/请求上下文/健康检查） | `test_cors`、`test_rate_limit`、`test_metrics`、`test_middleware_chain`、`test_request_context`、`test_health`、`test_body_limit`、`test_lifecycle`、`test_sanitizer` | **无替代（有意删除）**：这些由 Cloudflare Worker 运行时 + 入口中间件（`main.py` 的 headers/CORS/请求 ID）承担，本地 `local_run` 冒烟已覆盖健康检查 |
| 情报/AI 抓取 | `test_extractor`、`test_crawl_one`、`test_enrich_product`、`test_lead_crawl_ssrf`、`test_deepseek_client`、`test_llm_fallback`、`test_knowledge_provider`、`test_http_retry`、`test_text_knowledge_repo` | 逻辑已迁共享内核（`kaas_common/crawl_extract.py`、`net.py`）+ worker 路由测试；orchestrator 侧无运行时，删除 |
| 真实数据回归 | `test_real_data_regression`（引擎部分） | 已迁（`test_kernel_eq_real_data_regression.py`） |
| 其他 | `test_archive_job`（APScheduler，已被 CF Cron `ws_cron.py` 重建）、`test_company_seals`、`test_files_k8s/roundtrip/team_scope`、`test_business_events`、`test_doc_ref_integrity`、`test_packaging` 等 | CF Cron 由 `test_ws_cron.py`（30）覆盖；文件/封印逻辑在 `kaas_common/files` + worker `ws_files.py` 测试 |

> 完整删除清单（81 条 `git rm`，含 `e2e/`、旧 `__init__.py`）见 S4 提交：
> `git show <S4 commit> --stat -- backend/orchestrator/tests`。
> 回退方式：`git revert <S4 commit>`（业务壳、测试、CI 一起恢复）。

## 4. 验收证据

- `cd backend/worker && uv run --frozen --with pytest --with httpx2 python -m pytest tests -q`
  → **954 passed, 5 skipped**（含迁入的 15 个引擎文件；真 PG 集成无 PG 时 skip）。
- `cd backend/orchestrator && uv run --extra migrations pytest tests -q` → **222 passed**。
- `uv run --extra migrations alembic check`（本地 `kaas_local`，head `202610190020`）→ no new operations。
- `scripts/check-runtime-deps.py` / `check-schema-coverage.py` / `check-schema-drift.py` / `sync-shared.ps1 -Check` 全 PASS。
- `cd frontend && pnpm contracts:check` 全 PASS（R6 openapi 新鲜度随单应用退役，见 `scripts/archive/README.md`）。
