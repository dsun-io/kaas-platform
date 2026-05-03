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
from app.middleware.route_version import RouteVersionMiddleware
from app.middleware.trace import TraceMiddleware
from app.middleware.sampling import SamplingMiddleware


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
app.add_middleware(SamplingMiddleware)
app.add_middleware(TraceMiddleware)
app.add_middleware(RouteVersionMiddleware)
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
from app.api.quote_v2 import router as quote_router
from app.api.capabilities import router as capabilities_router
from app.api.dashboard import router as dashboard_router
from app.api.quotation import router as quotation_router
from app.api.health import router as health_router
from app.api.product_specs import router as product_specs_router

app.include_router(health_router)
app.include_router(events_router)
app.include_router(oss_presign_router)
app.include_router(admin_router)
app.include_router(quote_router)
app.include_router(capabilities_router)
app.include_router(dashboard_router)
app.include_router(quotation_router)
app.include_router(product_specs_router)
