"""
Kaas v2 · FastAPI 应用入口
──────────────────────────
- /health            → 健康检查（Docker HEALTHCHECK 用）

设计约束：
- 单实例服务模式（非按需脚本）
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.config.settings import settings

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理：启动 / 关闭钩子。"""
    # ─── Startup ───
    import structlog
    logger = structlog.get_logger()
    logger.info(
        "kaas_v2_starting",
        env=settings.app_env,
        log_level=settings.log_level,
    )
    yield
    # ─── Shutdown ───
    from app.db.session import engine
    await engine.dispose()
    logger.info("kaas_v2_shutdown")


app = FastAPI(
    title="Kaas v2 Orchestrator",
    description="Kaas V2 Backend Orchestrator (W0)",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_env == "development" else None,
    redoc_url="/redoc" if settings.app_env == "development" else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
