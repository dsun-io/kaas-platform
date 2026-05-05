"""Kaas v2 · 报价 API (§5 T8 / §13 集成)

POST /api/v1/quote — 提交报价请求，串联 LLM 提参 + 定价引擎 + 话术。

铁律4: FastGPT 不参与报价决策。报价链路不依赖 FastGPT。
"""
import os
import time
import structlog
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.services.extractor import extract_product_spec
from app.services.pricing import get_price, record_quotation
from app.services.quote_templates import generate_quote_response
from app.domain.session_store import session_store
from app.core.metrics import QUOTE_REQUESTS, QUOTE_LATENCY
from app.middleware.rate_limit import limiter
from app.schemas.quote import QuoteResponse, QuoteRequest

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["quote"])


@router.post("/quote", response_model=QuoteResponse)
@limiter.limit(os.getenv("RATE_LIMIT_QUOTE", "20/minute"))
async def create_quote(request: Request, db: AsyncSession = Depends(get_db_session)):
    """创建报价。串联整个报价链路。"""
    start = time.perf_counter()
    body = await request.json()
    try:
        quote_req = QuoteRequest(**body)
    except Exception as e:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": str(e)},
        )
    tenant_id: str = getattr(request.state, "tenant_id", "unknown")
    customer_id = quote_req.customer_id or tenant_id
    product_category = quote_req.product_category
    product_spec = quote_req.product_spec
    raw_text = quote_req.raw_text
    session_id = quote_req.session_id
    quantity = quote_req.quantity

    # Step 1: 参数提取 (LLM with fallback → regex)
    llm_tokens_in = 0
    llm_tokens_out = 0
    if not product_spec and raw_text:
        try:
            product_spec = await extract_product_spec(raw_text, product_category)
        except Exception as e:
            logger.warning("extract_product_spec_failed", error=str(e))
            product_spec = None

    if not product_spec:
        return JSONResponse(
            status_code=400,
            content={
                "error": "spec_required",
                "message": "product_spec or raw_text is required for quote",
            },
        )

    # Step 2: 定价引擎（SQL 精确匹配 / spec_not_supported）
    # 铁律4: FastGPT 不参与报价决策。不使用 KB 做定价估算。
    try:
        result = await get_price(
            db=db,
            customer_id=customer_id,
            product_category=product_category,
            product_spec=product_spec,
            quantity=quantity,
        )
    except Exception as e:
        logger.error("pricing_failed", error=str(e))
        return JSONResponse(
            status_code=500,
            content={"error": "pricing_failed", "message": "Internal pricing error"},
        )

    # Step 3: 记录报价事实 (INSERT-only · 铁律5)
    try:
        await record_quotation(
            db=db,
            customer_id=customer_id,
            product_category=product_category,
            product_spec=product_spec,
            result=result,
        )
    except Exception as e:
        logger.warning("record_quotation_failed", error=str(e))

    # Step 4: 话术生成（零 KB 依赖 — kb_chunks 已移除，kb 不参与话术）
    price_range = ""
    if result.unit_price is not None:
        price_range = f"{result.unit_price} {result.currency}/{result.unit}"
    try:
        script = await generate_quote_response(
            status=result.status,
            unit_price=result.unit_price,
            unit=result.unit,
            currency=result.currency,
            product_category=product_category,
            confidence=result.confidence,
            notes=result.notes,
            spec_summary=str(product_spec),
            price_range=price_range,
        )
    except Exception as e:
        logger.warning("script_generation_failed", error=str(e))
        script = f"【{result.status}】{product_category} 报价 {price_range or 'N/A'}"

    # Step 5: 更新会话上下文
    if session_id:
        try:
            session_store.update(session_id, {
                "last_product_category": product_category,
                "last_product_spec": product_spec,
                "last_result": {
                    "status": result.status,
                    "unit_price": result.unit_price,
                    "currency": result.currency,
                    "unit": result.unit,
                },
            })
        except Exception:
            pass

    elapsed = time.perf_counter() - start
    path = result.status  # matched / estimated / spec_not_supported
    QUOTE_REQUESTS.labels(tenant_id=tenant_id, path=path, status="success").inc()
    QUOTE_LATENCY.labels(tenant_id=tenant_id, path=path).observe(elapsed)

    return JSONResponse(
        status_code=200,
        content={
            "status": result.status,
            "unit_price": result.unit_price,
            "currency": result.currency,
            "unit": result.unit,
            "confidence": result.confidence,
            "source": result.source,
            "spec_hash": result.spec_hash,
            "notes": result.notes,
            "script": script,
        },
    )
