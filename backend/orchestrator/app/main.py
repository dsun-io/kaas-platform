"""
Kaas v2 · FastAPI 应用入口
──────────────────────────
- /health            → 健康检查（Docker HEALTHCHECK 用）
- /api/v1/events     → 原始事件写入
- /api/v1/oss-presign → MinIO 预签名上传
- /api/v1/admin/*    → 管理端点

设计约束：
- 单实例服务模式（非按需脚本）
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.core.logging_config import setup_logging
from app.core.lifecycle import lifespan
from app.config.settings import settings

# ── 结构化日志（最先初始化）──
setup_logging()

from app.middleware.request_context import RequestContextMiddleware
from app.middleware.body_limit import BodySizeLimitMiddleware
from app.middleware.tenant import TenantContextMiddleware
from app.middleware.auth import AuthContextMiddleware
from app.middleware.route_version import RouteVersionMiddleware
from app.middleware.trace import TraceMiddleware
from app.middleware.sampling import SamplingMiddleware
from app.middleware.workstation import WorkstationSubscriptionMiddleware


app = FastAPI(
    title="Kaas v2 Orchestrator",
    description="Kaas V2 Backend Orchestrator (W1)",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_env == "development" else None,
    redoc_url="/redoc" if settings.app_env == "development" else None,
)

# ── 安全头 (T8 · §14) ──
from app.core.security import setup_security_headers
setup_security_headers(app)

# ── Rate Limiter (T4 · §15.1) ──
from app.middleware.rate_limit import setup_rate_limiter
setup_rate_limiter(app)

# 中间件注册顺序（§8.2）
# Starlette: add_middleware wraps inside-out, so LAST added = outermost.
# 请求流向: CORS(最外层) → TenantContext → Sampling → Trace → RouteVersion(最内层) → handler
# CORSMiddleware 必须是最外层，否则 OPTIONS preflight 会被 tenant 中间件拦截。
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(TenantContextMiddleware)
app.add_middleware(AuthContextMiddleware)
app.add_middleware(SamplingMiddleware)
app.add_middleware(TraceMiddleware)
app.add_middleware(RouteVersionMiddleware)
# 工位订阅拦截（2026-10-11 授权模型：边界是"团队/个人开通了哪些工位"，不是租户）。
# 放在**最后一个 add** = 最外层：未开通的工位要在任何业务逻辑（含鉴权、租户校验）之前
# 就返回 404，否则"这个工位存在、只是你没买"会从别的错误码里泄露出去。
# 它自己会放行无 token 的请求与 is_always_allowed 的路径，因此不会干扰既有中间件语义。
app.add_middleware(WorkstationSubscriptionMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    allow_headers=["*"],
    expose_headers=["X-Request-Id", "X-Elapsed-Ms"],
)

# ── Metrics (T3 · §8.3) ──
from app.core.metrics import setup_metrics
setup_metrics(app)

# ─── API Routers ───
from app.api.events import router as events_router
from app.api.oss_presign import router as oss_presign_router
from app.api.admin import router as admin_router
from app.api.admin_accounts import router as admin_accounts_router
from app.api.capabilities import router as capabilities_router
from app.api.dashboard import router as dashboard_router
from app.api.health import router as health_router
from app.api.auth import router as auth_router
from app.api.pricing_data import router as pricing_data_router
from app.api.option_overrides import router as option_overrides_router
from app.api.categories import router as categories_router
from app.api.quote_wizard import router as quote_wizard_router
from app.api.quotations_api import router as quotations_api_router
from app.api.prices import router as prices_router
from app.api.admin_proposals import router as admin_proposals_router
from app.api.intel import router as intel_router
from app.api.ai import router as ai_router
from app.api.leadgen import router as leadgen_router
from app.api.outreach import router as outreach_router
from app.api.research import router as research_router
from app.api.market import router as market_router
from app.api.export_quote import router as export_quote_router
from app.api.quote_profiles import router as quote_profiles_router
# 注：单证渲染已改为前端实现（X′ 方案）——模板与渲染逻辑属前端静态资产，
# 预览/打印本就在浏览器发生，后端的 render 路由已归档（archive/2026-09-trade-doc-xprime-python）。
# ── 工位业务模块（P3 接线）──
# 这 6 个模块早已实现但未挂载，导致「后端写好了、前端用不到」。
# 客户管理 / 报价单 / 订单 / 出货 / 单证台账 / 业务字典 均在此接入。
from app.api.customers import router as customers_router
# 报价单：现行实现是 `quote_orders.py`。
# 旧的 `quotes.py` 已退役（docs/CURRENT_IMPLEMENTATION_MAP.md 判其为遗留：
# 前端零调用、线上无此路由，且缺少多行整批编辑/询盘关联）。两者路由前缀相同，
# **同时挂载会因先注册者优先而产生隐性遮蔽**，因此这里只挂新的那个。
from app.api.quote_orders import router as quote_orders_router
from app.api.orders import router as orders_router
from app.api.shipments import router as shipments_router
from app.api.trade_docs import router as trade_docs_router
from app.api.enums import router as enums_router
from app.api.company_profile import router as company_profile_router
from app.api.company_seals import router as company_seals_router
from app.api.fx_rates import router as fx_rates_router
from app.api.actual_costs import router as actual_costs_router
from app.api.external_docs import router as external_docs_router
from app.api.files import router as files_router
from app.api.tenant_products import router as tenant_products_router
from app.api.workstation_products import router as workstation_products_router
from app.api.teams import router as teams_router
# 工位开通/撤销 + 「我的工位」（前端据此隐藏入口 / 显示开通引导页）。
# 判定真源 = kaas_common/workstation/subscriptions.py，本路由只做 HTTP 适配。
from app.api.workstations import router as workstations_router
from app.api.customer_records import router as customer_records_router
from app.api.product_costs import router as product_costs_router

app.include_router(health_router)
app.include_router(auth_router)
app.include_router(pricing_data_router)
app.include_router(option_overrides_router)
app.include_router(events_router)
app.include_router(oss_presign_router)
app.include_router(admin_router)
app.include_router(admin_accounts_router)
app.include_router(capabilities_router)
app.include_router(dashboard_router)
app.include_router(categories_router)
app.include_router(quote_wizard_router)
app.include_router(quotations_api_router)
app.include_router(prices_router)
app.include_router(admin_proposals_router)
app.include_router(intel_router)
app.include_router(ai_router)
app.include_router(leadgen_router)
app.include_router(outreach_router)
# 市场调研（研发后端补的移植版：原先只有线上 Worker 有实现，本地 8 个接口全 404）
app.include_router(research_router)
# 产品市场对照（同上，5 个接口原先只有线上有）
app.include_router(market_router)
app.include_router(export_quote_router)
# 客户税率档案：「税务档案」下拉里的客户那一层（法定档案仍由 export_quote 提供）
app.include_router(quote_profiles_router)
# ── 工位业务模块（P3 接线）──
app.include_router(enums_router)
app.include_router(customers_router)
app.include_router(quote_orders_router)
app.include_router(orders_router)
app.include_router(shipments_router)
app.include_router(trade_docs_router)
app.include_router(company_profile_router)
app.include_router(company_seals_router)
app.include_router(product_costs_router)
app.include_router(fx_rates_router)
app.include_router(actual_costs_router)
app.include_router(external_docs_router)
app.include_router(files_router)
app.include_router(tenant_products_router)
app.include_router(workstation_products_router)
app.include_router(teams_router)
app.include_router(workstations_router)
app.include_router(customer_records_router)

