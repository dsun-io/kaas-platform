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

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config.settings import settings
from app.middleware.tenant import TenantContextMiddleware
from app.middleware.route_version import RouteVersionMiddleware
from app.middleware.trace import TraceMiddleware
from app.middleware.sampling import SamplingMiddleware

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动 / 关闭钩子。"""
    import structlog
    logger = structlog.get_logger()

    # ─── Startup ───
    logger.info(
        "kaas_v2_starting",
        env=settings.app_env,
        log_level=settings.log_level,
    )

    from app.jobs.archive import start_scheduler
    start_scheduler()
    logger.info("archive_scheduler_started")

    yield

    # ─── Shutdown ───
    from app.jobs.archive import stop_scheduler
    stop_scheduler()
    from app.db.session import engine
    await engine.dispose()
    logger.info("kaas_v2_shutdown")


app = FastAPI(
    title="Kaas v2 Orchestrator",
    description="Kaas V2 Backend Orchestrator (W1)",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_env == "development" else None,
    redoc_url="/redoc" if settings.app_env == "development" else None,
)

# 中间件注册顺序（§3.7.11）
# Starlette: 先注册 = 最外层 = 最先处理请求。
# 请求流向: Sampling(最外层) → Trace → RouteVersion → TenantContext(最内层) → handler
app.add_middleware(SamplingMiddleware)
app.add_middleware(TraceMiddleware)
app.add_middleware(RouteVersionMiddleware)
app.add_middleware(TenantContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── API Routers ───
from app.api.events import router as events_router
from app.api.oss_presign import router as oss_presign_router
from app.api.admin import router as admin_router

app.include_router(events_router)
app.include_router(oss_presign_router)
app.include_router(admin_router)

# ─── Health Check ───
@app.get("/health", tags=["infra"])
async def health_check():
    """
    健康检查端点。
    Docker HEALTHCHECK 和负载均衡器使用。
    """
    return {
        "status": "healthy",
        "service": "kaas-v2-orchestrator",
        "version": "0.1.0",
    }
