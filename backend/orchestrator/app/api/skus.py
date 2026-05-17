"""SKU API — /api/v1/spec/skus"""
from fastapi import APIRouter, Depends, Request, Query
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_viewer, require_tenant_admin
from app.repositories import skus_repo, prices_repo
from app.domain.spec_hash import compute_sku_hash
from app.schemas.spec_system import SkuPatchRequest

router = APIRouter(prefix="/api/v1/spec/skus", tags=["spec-skus"])


@router.get("")
async def list_skus(
    category_id: int | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    items, total = await skus_repo.list_skus(db, tenant_id, category_id, page, page_size)
    return {
        "items": [
            {"id": s.id, "category_id": s.category_id, "spec_values": s.spec_values,
             "spec_hash": s.spec_hash, "revision": s.revision, "weight_kg": float(s.weight_kg) if s.weight_kg else None}
            for s in items
        ],
        "total": total, "page": page, "page_size": page_size,
    }


@router.get("/{sku_id}")
async def get_sku(
    sku_id: int,
    auth=Depends(require_tenant_viewer),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    sku = await skus_repo.get_sku_by_id(db, sku_id, tenant_id)
    if not sku:
        return {"error": "not_found"}
    price = await prices_repo.get_active_price(db, sku_id, tenant_id)
    return {
        "id": sku.id, "category_id": sku.category_id, "spec_values": sku.spec_values,
        "spec_hash": sku.spec_hash, "revision": sku.revision, "schema_version": sku.schema_version,
        "weight_kg": float(sku.weight_kg) if sku.weight_kg else None,
        "price": {
            "id": price.id, "price": float(price.price), "price_unit": price.price_unit,
            "effective_from": price.effective_from.isoformat(),
            "effective_to": price.effective_to.isoformat() if price.effective_to else None,
        } if price else None,
    }


@router.patch("/{sku_id}")
async def patch_sku(
    sku_id: int,
    body: SkuPatchRequest,
    auth=Depends(require_tenant_admin),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = auth.tenant_id or ""
    sku = await skus_repo.get_sku_by_id(db, sku_id, tenant_id)
    if not sku:
        return {"error": "not_found"}

    # 重算 spec_hash，检查冲突
    from app.db.models import ProductCategory
    cat = await db.get(ProductCategory, sku.category_id)
    new_hash = compute_sku_hash(cat.code, body.spec_values, None, None)
    if new_hash != sku.spec_hash:
        conflict = await skus_repo.get_sku_by_hash(db, tenant_id, sku.category_id, new_hash)
        if conflict and conflict.id != sku_id:
            return {"error": "conflict", "message": "Spec hash conflicts with another SKU", "conflict_sku_id": conflict.id}

    # INSERT revision 快照
    await skus_repo.insert_revision(db, sku, body.change_reason, str(auth.user_id))

    # UPDATE 主表
    sku.spec_values = body.spec_values
    sku.spec_hash = new_hash
    sku.revision = sku.revision + 1
    if body.weight_kg is not None:
        sku.weight_kg = body.weight_kg
    if body.description is not None:
        sku.description = body.description
    await db.flush()

    return {"id": sku.id, "spec_hash": sku.spec_hash, "revision": sku.revision}
