"""价格 API — /api/v1/spec/skus/{id}/prices + /api/v1/spec/prices/{id}"""
from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_admin
from app.services.price_engine import upsert_price
from app.repositories import skus_repo, prices_repo
from app.schemas.spec_system import PriceCreateRequest, PricePatchRequest

router = APIRouter(tags=["spec-prices"])


@router.post("/api/v1/spec/skus/{sku_id}/prices")
async def create_price(
    sku_id: int,
    body: PriceCreateRequest,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    sku = await skus_repo.get_sku_by_id(db, sku_id, tenant_id)
    if not sku:
        return {"error": "not_found"}

    price_id = await upsert_price(
        db=db,
        sku_id=sku_id,
        tenant_id=tenant_id,
        price=body.price,
        price_unit_code=body.price_unit,
        effective_from=body.effective_from,
        effective_to=body.effective_to,
        min_qty=body.min_qty,
        tier_rules=body.tier_rules,
        note=body.note,
        change_reason=body.change_reason,
        created_by=str(auth.user_id),
    )
    return {"id": price_id}


@router.patch("/api/v1/spec/prices/{price_id}")
async def patch_price(
    price_id: int,
    body: PricePatchRequest,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    from sqlalchemy import select
    from app.db.models import ProductSkuPrice

    price = await db.get(ProductSkuPrice, price_id)
    if not price:
        return {"error": "not_found"}

    # 只允许改 status / note / effective_to
    if body.status is not None:
        price.status = body.status
    if body.note is not None:
        price.note = body.note
    if body.effective_to is not None:
        price.effective_to = body.effective_to
    await db.flush()

    return {"id": price.id, "status": price.status}
