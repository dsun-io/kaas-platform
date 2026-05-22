"""Kaas v2 · 健康检查端点 (§9.1 · 三层探针)

/health       — K8s liveness（进程存活）
/health/ready — K8s readiness（DB 可用）
/health/deep  — 全链路深度检查（DB + LLM + KB）
"""
import os
import structlog
from fastapi import APIRouter, Depends, HTTPException
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
    if not all_ok:
        raise HTTPException(status_code=503, detail={"status": "degraded", "checks": checks})
    return {"status": "ready", "checks": checks}


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

    # KB — 使用 KnowledgeRetrievalProvider (默认 postgres，不依赖 FastGPT)
    # FASTGPT_ENABLED=false 时不会报错，只报告为 disabled
    fastgpt_enabled = os.getenv("FASTGPT_ENABLED", "false").lower() == "true"
    try:
        from app.services.knowledge_provider import get_knowledge_provider
        provider = get_knowledge_provider("__healthcheck__")
        pname = type(provider).__name__
        if "PostgreSQL" in pname:
            checks["kb"] = "ok (postgres)"
        elif "FastGPT" in pname:
            if fastgpt_enabled:
                checks["kb"] = "ok (fastgpt)"
            else:
                checks["kb"] = "disabled (fastgpt not enabled)"
        else:
            checks["kb"] = f"ok ({pname})"
    except Exception as e:
        checks["kb"] = f"error: {e}"

    def _is_ok(val: str) -> bool:
        return val.startswith("ok") or val == "stub" or "disabled" in val

    all_ok = all(_is_ok(v) for v in checks.values())
    logger.info("health.deep_check", checks=checks, all_ok=all_ok)
    if not all_ok:
        raise HTTPException(status_code=503, detail={"status": "degraded", "checks": checks})
    return {"status": "healthy", "checks": checks}
