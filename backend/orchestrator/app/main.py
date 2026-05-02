"""
Kaas v2 · FastAPI 应用入口
──────────────────────────
- /health            → 健康检查（Docker HEALTHCHECK 用）
- /api/v1/*          → 业务路由（全部经 TenantContextMiddleware）
- /docs              → Swagger UI（开发环境）

设计约束：
- 单实例服务模式（非按需脚本），通过 X-Tenant-Id 路由
- 所有 API 路由必须在 TenantContextMiddleware 之后
- CORS 配置从环境变量读取
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config.settings import settings
from app.middleware.tenant import TenantContextMiddleware


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
    description=(
        "报价工位混合架构 · 本地 Orchestrator\n\n"
        "五条铁律：AI不做范围决策 / 报价不进向量库 / 确定性优先 / "
        "客户数据主权 / 原始事件INSERT-only"
    ),
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs" if settings.app_env == "development" else None,
    redoc_url="/redoc" if settings.app_env == "development" else None,
)

# ─── Middleware 注册顺序：CORS → Tenant ───
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(TenantContextMiddleware)


# ─── Health Check (Docker HEALTHCHECK 用，不经过 TenantContextMiddleware) ───
@app.get("/health", tags=["infra"])
async def health_check():
    """
    健康检查端点。

    Docker HEALTHCHECK 和负载均衡器使用。
    不需要 X-Tenant-Id header。
    """
    return {
        "status": "healthy",
        "service": "kaas-v2-orchestrator",
        "version": "0.1.0",
    }


# ─── API v1 占位路由（W1 阶段实现具体业务） ───
@app.get("/api/v1/ping", tags=["debug"])
async def ping():
    """
    API 连通性测试（需要 X-Tenant-Id header）。
    验证 TenantContextMiddleware 工作正常。
    """
    return {"message": "pong", "api_version": "v1"}
