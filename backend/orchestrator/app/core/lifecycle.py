"""Kaas v2 · FastAPI 生命周期管理 (§15.4)

启动: 日志 + LLM client 预热
停机: scheduler → DB engine dispose → 日志
"""
from contextlib import asynccontextmanager
import structlog

logger = structlog.get_logger()


@asynccontextmanager
async def lifespan(app):
    logger.info("app.startup")

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
