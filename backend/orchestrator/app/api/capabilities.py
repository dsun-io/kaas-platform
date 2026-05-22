"""Kaas v2 · 客户能力 API (§5 T9)

GET/POST /api/v1/capabilities — 查询/更新客户生产规格能力。
"""
from fastapi import APIRouter, Request, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.db.session import get_db_session
from app.db.models import CustomerCapability
from app.repositories.capabilities_repo import (
    get_capabilities,
    list_capabilities,
    upsert_capability,
)
from app.schemas.capabilities import CapabilityListResponse, CapabilityItem
from app.core.auth import AuthContext, require_customer_access
from app.core.auth_utils import require_internal, require_customer_code_access, require_tenant_match, require_customer_match

router = APIRouter(prefix="/api/v1", tags=["capabilities"])


@router.get("/customers")
async def list_customers(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """客户列表。

    AUTH: internal 可查看全部，customer/free 只能查看自己。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if not auth:
        raise HTTPException(status_code=401, detail="unauthorized: Authentication required")

    stmt = (
        select(
            CustomerCapability.customer_id,
            CustomerCapability.customer_name,
            func.count(CustomerCapability.id).label("category_count"),
            func.max(CustomerCapability.updated_at).label("updated_at"),
        )
        .group_by(CustomerCapability.customer_id, CustomerCapability.customer_name)
        .order_by(CustomerCapability.customer_name)
    )

    # customer/free 只能看自己
    if auth.is_customer() and auth.customer_code:
        stmt = stmt.where(CustomerCapability.customer_id == auth.customer_code)

    result = await db.execute(stmt)
    rows = result.all()
    return [
        {
            "customer_id": r.customer_id,
            "customer_name": r.customer_name,
            "category_count": r.category_count,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
            "locale": "zh-CN",
            "region": "CN",
        }
        for r in rows
    ]


@router.get("/capabilities", response_model=CapabilityListResponse)
async def list_customer_capabilities(
    request: Request,
    customer_id: str | None = None,
    db: AsyncSession = Depends(get_db_session),
):
    """查询客户能力列表。

    AUTH-WX-R1: customer 账号只能查看自己的数据。
    Query params:
    - customer_id: str (可选，internal 可指定，customer 被忽略)
    """
    auth: AuthContext = getattr(request.state, "auth", None)

    # customer 账号只能查看自己的数据，拒绝不匹配的 customer_id 查询参数
    if auth and auth.is_customer():
        require_customer_match(auth, customer_id)
        cid = auth.customer_code
        caps = await get_capabilities(db, customer_id=cid, tenant_id=auth.tenant_id)
    elif auth and auth.is_internal():
        if customer_id:
            caps = await get_capabilities(db, customer_id=customer_id)
        else:
            caps = await list_capabilities(db)
    else:
        tenant_id = getattr(request.state, "tenant_id", "unknown")
        cid = customer_id or tenant_id
        caps = await get_capabilities(db, customer_id=cid) if customer_id else await list_capabilities(db)

    return {
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
    }


@router.get("/customer/{customer_id}/capabilities")
async def get_customer_capabilities_by_id(
    customer_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """兼容前端路径: GET /api/v1/customer/{customer_id}/capabilities

    AUTH: internal 可读任意客户，customer/free 只能读自己。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if not auth:
        raise HTTPException(status_code=401, detail="unauthorized: Authentication required")
    require_customer_code_access(auth, customer_id)

    caps = await get_capabilities(db, customer_id=customer_id, tenant_id=auth.tenant_id if not auth.is_internal() else None)
    return [
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
    ]


@router.patch("/customer/{customer_id}/capabilities")
async def patch_customer_capability(
    customer_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """兼容前端路径: PATCH /api/v1/customer/{customer_id}/capabilities

    AUTH: internal 可写任意客户，customer/free 只能写自己。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if not auth:
        raise HTTPException(status_code=401, detail="unauthorized: Authentication required")
    require_customer_code_access(auth, customer_id)

    body = await request.json()
    cap_id = body.get("id")
    spec_constraints = body.get("spec_constraints")
    is_active = body.get("is_active")

    if not cap_id:
        raise HTTPException(status_code=400, detail="MISSING_FIELD: id is required")

    from app.repositories.capabilities_repo import update_capability

    updated = await update_capability(
        session=db,
        cap_id=cap_id,
        customer_id=customer_id,
        spec_constraints=spec_constraints,
        is_active=is_active,
        tenant_id=auth.tenant_id if not auth.is_internal() else None,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="CAPABILITY_NOT_FOUND: Capability not found")

    return {
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
    }


@router.post("/capabilities", response_model=CapabilityItem)
async def update_customer_capability(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """新增或更新客户能力。

    AUTH-WX-R1: customer 账号只能更新自己的数据。

    请求 body:
    - customer_id: str (customer 账号传了其他 customer_id 也会被忽略)
    - customer_name: str
    - product_category: str
    - spec_constraints: dict
    - notes: str (可选)
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    body = await request.json()

    if auth and auth.is_customer():
        require_tenant_match(auth, body.get("tenant_id"))
        require_customer_match(auth, body.get("customer_id"))
        customer_id = auth.customer_code or ""
        tenant_id = auth.tenant_id or ""
    else:
        customer_id = body.get("customer_id", "")
        tenant_id = body.get("tenant_id") or getattr(request.state, "tenant_id", "")

    customer_name = body.get("customer_name", "")
    product_category = body.get("product_category", "")
    spec_constraints = body.get("spec_constraints", {})
    notes = body.get("notes")

    if not customer_id or not product_category:
        raise HTTPException(
            status_code=400,
            detail="missing_fields: customer_id and product_category are required",
        )

    cap = await upsert_capability(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        product_category=product_category,
        spec_constraints=spec_constraints,
        notes=notes,
    )

    return {
        "id": cap.id,
        "customer_id": cap.customer_id,
        "customer_name": cap.customer_name,
        "product_category": cap.product_category,
        "spec_constraints": cap.spec_constraints,
        "notes": cap.notes,
        "updated_at": cap.updated_at.isoformat() if cap.updated_at else None,
    }
