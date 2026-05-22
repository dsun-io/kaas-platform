"""Kaas v2 · FastAPI 生命周期管理 (§15.4)

启动: 日志 + 安全校验 + LLM client 预热
停机: scheduler → DB engine dispose → 日志
"""
from contextlib import asynccontextmanager
import structlog

logger = structlog.get_logger()

# ── 默认密钥集合（T1 安全校验）──
DEFAULT_SECRETS = {
    "kaas-dev-jwt-secret-change-in-prod",
    "change-me",
    "secret",
    "jwt-secret",
    "",
}


@asynccontextmanager
async def lifespan(app):
    logger.info("app.startup")

    # ── 安全校验：JWT 密钥检查 (T1) ──
    from app.config.settings import settings

    if settings.jwt_secret in DEFAULT_SECRETS:
        raise RuntimeError(
            "SECURITY ERROR: JWT_SECRET 使用默认值或弱密钥。"
            "请在环境变量中设置强密钥后重启服务。"
        )

    if settings.app_env == "production":
        if len(settings.jwt_secret) < 32:
            raise RuntimeError(
                "SECURITY ERROR (Production): JWT_SECRET 长度必须 >= 32 字符。"
                f"当前长度: {len(settings.jwt_secret)}"
            )

    logger.info("kaas.startup.security_checks_passed", env=settings.app_env)

    from app.jobs.archive import start_scheduler
    start_scheduler()
    logger.info("app.scheduler_started")

    try:
        from app.services.llm_client import get_llm_client
        llm = get_llm_client()
        logger.info("app.llm_client_ready", provider=type(llm).__name__)
    except Exception as e:
        logger.warning("app.llm_client_init_failed", error=str(e))

    yield

    logger.info("app.shutdown_start")

    try:
        from app.jobs.archive import _scheduler
        if _scheduler and _scheduler.running:
            _scheduler.shutdown(wait=True)
            logger.info("app.scheduler_stopped")
    except Exception as e:
        logger.warning("app.scheduler_shutdown_failed", error=str(e))

    try:
        from app.db.session import engine
        await engine.dispose()
        logger.info("app.db_engine_disposed")
    except Exception as e:
        logger.warning("app.db_dispose_failed", error=str(e))

    logger.info("app.shutdown_complete")
