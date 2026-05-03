"""Kaas v2 · 健康检查端点 (§9.1 · 三层探针)

/health       — K8s liveness（进程存活）
/health/ready — K8s readiness（DB 可用）
/health/deep  — 全链路深度检查（DB + LLM + KB）
"""
import structlog
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.schemas.health import LivenessResponse, ReadinessResponse, DeepCheckResponse

router = APIRouter(tags=["health"])
logger = structlog.get_logger()


@router.get("/health", response_model=LivenessResponse)
async def health_liveness():
    """K8s liveness probe — 进程活着就返回 200。"""
    return {"status": "ok"}


@router.get("/health/ready", response_model=ReadinessResponse)
async def health_readiness(db: AsyncSession = Depends(get_db_session)):
    """K8s readiness probe — DB 连接可用。"""
    checks = {}
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {e}"
        logger.error("health.db_check_failed", error=str(e))

    all_ok = all(v == "ok" for v in checks.values())
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={"status": "ready" if all_ok else "degraded", "checks": checks},
    )


@router.get("/health/deep", response_model=DeepCheckResponse)
async def health_deep(db: AsyncSession = Depends(get_db_session)):
    """深度检查 — DB + LLM + KB 全链路。"""
    checks = {}

    # DB
    try:
        await db.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception as e:
        checks["database"] = f"error: {e}"

    # LLM（轻量 ping — stub 模式跳过）
    try:
        from app.services.llm_client import get_llm_client
        client = get_llm_client()
        if hasattr(client, "_client") and getattr(client, "_client", None) is not None:
            try:
                resp = await client._client.get("/v1/models")
                checks["llm"] = "ok" if resp.status_code == 200 else f"status: {resp.status_code}"
            except Exception:
                checks["llm"] = "unreachable"
        else:
            checks["llm"] = "stub"
    except Exception as e:
        checks["llm"] = f"error: {e}"

    # KB（stub 模式跳过）
    try:
        from app.services.kb_client import get_kb_client
        kb = get_kb_client("__healthcheck__")
        checks["kb"] = "stub" if type(kb).__name__ == "StubKBClient" else "ok"
    except Exception as e:
        checks["kb"] = f"error: {e}"

    all_ok = all(v in ("ok", "stub") for v in checks.values())
    logger.info("health.deep_check", checks=checks)
    return JSONResponse(
        status_code=200 if all_ok else 503,
        content={"status": "healthy" if all_ok else "degraded", "checks": checks},
    )
