"""Kaas v2 · 报价查询 API (§5 T10)

GET /api/v1/quotations — 查询历史报价记录。
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.repositories.quotations_repo import list_quotations, count_quotations
from app.schemas.quotation import QuotationListResponse
from app.core.auth import AuthContext

router = APIRouter(prefix="/api/v1", tags=["quotations"])


@router.post("/quotation")
async def create_quotation_manual(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """手动录入报价记录（兼容前端 /quotation 路径）。"""
    from app.repositories.quotations_repo import insert_quotation
    from app.domain.spec_hash import compute_spec_hash

    body = await request.json()
    auth: AuthContext = getattr(request.state, "auth", None)

    # customer 账号只能创建自己的报价
    if auth and auth.is_customer():
        customer_id = auth.customer_id_str
    else:
        customer_id = body.get("customer_id") or getattr(request.state, "tenant_id", None)
    product_category = body.get("product_category")
    product_spec = body.get("product_spec", {})
    unit_price = body.get("unit_price")
    quantity = body.get("quantity")
    notes = body.get("notes", "")
    source = body.get("source", "manual")
    currency = body.get("currency", "CNY")
    unit = body.get("unit", "meter")

    if not customer_id or not product_category:
        return JSONResponse(
            status_code=400,
            content={
                "error_code": "MISSING_FIELDS",
                "message": "customer_id and product_category are required",
            },
        )

    spec_hash = compute_spec_hash(product_spec)

    q = await insert_quotation(
        session=db,
        customer_id=customer_id,
        product_category=product_category,
        product_spec=product_spec,
        spec_hash=spec_hash,
        unit_price=unit_price,
        currency=currency,
        unit=unit,
        discount=body.get("discount"),
        min_quantity=quantity,
        source=source,
        notes=notes,
    )

    return JSONResponse(
        status_code=201,
        content={
            "id": str(q.id),
            "spec_hash": spec_hash,
        },
    )


@router.get("/quotations", response_model=QuotationListResponse)
async def get_quotations(
    request: Request,
    customer_id: str | None = None,
    product_category: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db_session),
):
    """查询历史报价记录。

    Query params:
    - customer_id: str (可选)
    - product_category: str (可选)
    - limit: int (默认 100)
    """
    tenant_id: str = getattr(request.state, "tenant_id", "unknown")
    auth: AuthContext = getattr(request.state, "auth", None)

    # customer 账号只能查看自己的报价
    if auth and auth.is_customer():
        cid = auth.customer_id_str or tenant_id
    else:
        cid = customer_id or tenant_id

    quotes = await list_quotations(
        db,
        customer_id=cid if (customer_id or (auth and auth.is_customer())) else None,
        product_category=product_category,
        limit=min(limit, 500),
    )
    total = await count_quotations(db, customer_id=cid if (customer_id or (auth and auth.is_customer())) else None)

    serialized = [
        {
            "id": str(q.id),
            "customer_id": q.customer_id,
            "product_category": q.product_category,
            "product_spec": q.product_spec,
            "spec_hash": q.spec_hash,
            "unit_price": float(q.unit_price) if q.unit_price else None,
            "currency": q.currency,
            "unit": q.unit,
            "discount": float(q.discount) if q.discount else None,
            "min_quantity": q.min_quantity,
            "source": q.source,
            "notes": q.notes,
            "effective_from": q.effective_from.isoformat(),
            "created_at": q.created_at.isoformat(),
        }
        for q in quotes
    ]
    return JSONResponse(
        status_code=200,
        content={
            "items": serialized,
            "quotations": serialized,
            "total": total,
            "limit": min(limit, 500),
        },
    )
