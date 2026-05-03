"""Kaas v2 · 客户能力 API (§5 T9)

GET/POST /api/v1/capabilities — 查询/更新客户生产规格能力。
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.repositories.capabilities_repo import (
    get_capabilities,
    list_capabilities,
    upsert_capability,
)
from app.schemas.capabilities import CapabilityListResponse, CapabilityItem

router = APIRouter(prefix="/api/v1", tags=["capabilities"])


@router.get("/capabilities", response_model=CapabilityListResponse)
async def list_customer_capabilities(
    request: Request,
    customer_id: str | None = None,
    db: AsyncSession = Depends(get_db_session),
):
    """查询客户能力列表。

    Query params:
    - customer_id: str (可选，默认取当前租户)
    """
    tenant_id: str = getattr(request.state, "tenant_id", "unknown")
    cid = customer_id or tenant_id

    if customer_id:
        caps = await get_capabilities(db, customer_id=cid)
    else:
        caps = await list_capabilities(db)

    return JSONResponse(
        status_code=200,
        content={
            "capabilities": [
                {
                    "id": c.id,
                    "customer_id": c.customer_id,
                    "customer_name": c.customer_name,
                    "product_category": c.product_category,
                    "spec_constraints": c.spec_constraints,
                    "notes": c.notes,
                    "effective_from": c.effective_from.isoformat(),
                    "updated_at": c.updated_at.isoformat() if c.updated_at else None,
                }
                for c in caps
            ]
        },
    )


@router.get("/customer/{customer_id}/capabilities")
async def get_customer_capabilities_by_id(
    customer_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """兼容前端路径: GET /api/v1/customer/{customer_id}/capabilities"""
    caps = await get_capabilities(db, customer_id=customer_id)
    return JSONResponse(
        status_code=200,
        content=[
            {
                "id": c.id,
                "customer_id": c.customer_id,
                "customer_name": c.customer_name,
                "product_category": c.product_category,
                "spec_constraints": c.spec_constraints,
                "notes": c.notes,
                "is_active": True,
                "effective_from": c.effective_from.isoformat(),
                "updated_at": c.updated_at.isoformat() if c.updated_at else None,
            }
            for c in caps
        ],
    )


@router.patch("/customer/{customer_id}/capabilities")
async def patch_customer_capability(
    customer_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """兼容前端路径: PATCH /api/v1/customer/{customer_id}/capabilities"""
    body = await request.json()
    cap_id = body.get("id")
    spec_constraints = body.get("spec_constraints")
    is_active = body.get("is_active")

    if not cap_id:
        return JSONResponse(
            status_code=400,
            content={"error_code": "MISSING_FIELD", "message": "id is required"},
        )

    from app.repositories.capabilities_repo import update_capability

    updated = await update_capability(
        session=db,
        cap_id=cap_id,
        customer_id=customer_id,
        spec_constraints=spec_constraints,
        is_active=is_active,
    )
    if not updated:
        return JSONResponse(
            status_code=404,
            content={
                "error_code": "CAPABILITY_NOT_FOUND",
                "message": "Capability not found",
            },
        )

    return JSONResponse(
        status_code=200,
        content={
            "capability": {
                "id": updated.id,
                "customer_id": updated.customer_id,
                "customer_name": updated.customer_name,
                "product_category": updated.product_category,
                "spec_constraints": updated.spec_constraints,
                "notes": updated.notes,
                "is_active": True,
                "effective_from": updated.effective_from.isoformat(),
                "updated_at": updated.updated_at.isoformat() if updated.updated_at else None,
            },
            "sync_job_id": f"sync-{cap_id}-{int(__import__('time').time())}",
        },
    )


@router.post("/capabilities", response_model=CapabilityItem)
async def update_customer_capability(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """新增或更新客户能力。

    请求 body:
    - customer_id: str
    - customer_name: str
    - product_category: str
    - spec_constraints: dict
    - notes: str (可选)
    """
    body = await request.json()
    customer_id = body.get("customer_id", "")
    customer_name = body.get("customer_name", "")
    product_category = body.get("product_category", "")
    spec_constraints = body.get("spec_constraints", {})
    notes = body.get("notes")

    if not customer_id or not product_category:
        return JSONResponse(
            status_code=400,
            content={
                "error": "missing_fields",
                "message": "customer_id and product_category are required",
            },
        )

    cap = await upsert_capability(
        session=db,
        customer_id=customer_id,
        customer_name=customer_name,
        product_category=product_category,
        spec_constraints=spec_constraints,
        notes=notes,
    )

    return JSONResponse(
        status_code=200,
        content={
            "id": cap.id,
            "customer_id": cap.customer_id,
            "customer_name": cap.customer_name,
            "product_category": cap.product_category,
            "spec_constraints": cap.spec_constraints,
            "notes": cap.notes,
            "updated_at": cap.updated_at.isoformat() if cap.updated_at else None,
        },
    )
