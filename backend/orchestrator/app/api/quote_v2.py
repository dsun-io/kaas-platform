"""Kaas v2 · INT-R3 报价 API (V2)

POST /api/v1/quote — 新引擎报价，串联规格匹配 → 定价计算 → 配件计价 → 运费 → 话术。
"""
import os
import time
import structlog
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.schemas.quote_v2 import QuoteV2Request, QuoteV2Response
from app.services.quote_engine import create_quote
from app.core.permissions import require_permission, sanitize_payload
from app.core.metrics import QUOTE_REQUESTS, QUOTE_LATENCY
from app.middleware.rate_limit import limiter
from app.repositories.events import insert_event

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["quote_v2"])


@router.post("/quote", response_model=QuoteV2Response)
@limiter.limit(os.getenv("RATE_LIMIT_QUOTE", "20/minute"))
async def create_quote_v2(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """创建报价 (V2 引擎)。"""
    start = time.perf_counter()

    # ── Auth Context (永远从 header/state 取，不信任 body) ──
    tenant_id: str = getattr(request.state, "tenant_id", "")
    customer_id: str = request.headers.get("X-Customer-Id", "") or tenant_id

    if not tenant_id:
        return JSONResponse(
            status_code=401,
            content={"error": "tenant_required", "message": "Missing tenant context"},
        )

    # ── 权限校验 ──
    try:
        await require_permission(request, "quote:run")
    except HTTPException:
        raise
    except Exception:
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "Insufficient permissions"},
        )

    # ── 解析请求体 ──
    body = await request.json()
    try:
        quote_req = QuoteV2Request(**body)
    except Exception as e:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": str(e)},
        )

    # ── 执行报价 ──
    request_dict = quote_req.model_dump(exclude_none=True)
    try:
        result = await create_quote(
            db=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            request=request_dict,
        )
    except Exception as e:
        logger.error("quote_v2_failed", tenant_id=tenant_id, error=str(e))
        return JSONResponse(
            status_code=500,
            content={"error": "quote_failed", "message": "Internal quote error"},
        )

    # ── 事件记录（脱敏后） ──
    try:
        sanitized = sanitize_payload(request_dict)
        await insert_event(
            session=db,
            tenant_id=tenant_id,
            trace_id=None,
            event_type="quote.request",
            schema_version=2,
            event_source="kaas-web",
            payload={
                "customer_id": customer_id,
                "product_category": quote_req.product_category,
                "request": sanitized,
                "result_status": result.get("status"),
            },
            sampled=True,
        )
    except Exception as e:
        logger.warning("quote_event_log_failed", error=str(e))

    # ── 指标 ──
    elapsed = time.perf_counter() - start
    path = result.get("status", "unknown")
    QUOTE_REQUESTS.labels(tenant_id=tenant_id, path=path, status="success").inc()
    QUOTE_LATENCY.labels(tenant_id=tenant_id, path=path).observe(elapsed)

    return JSONResponse(status_code=200, content=result)
