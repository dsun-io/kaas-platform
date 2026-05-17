"""Kaas v2 · CustomerCapability 仓储 (§5 T1)

客户生产规格能力 CRUD。
"""
from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import CustomerCapability


async def upsert_capability(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    customer_name: str,
    product_category: str,
    spec_constraints: dict,
    notes: Optional[str] = None,
) -> CustomerCapability:
    """插入或更新客户能力记录（存在则更新 spec_constraints）。"""
    result = await session.execute(
        select(CustomerCapability).where(
            CustomerCapability.tenant_id == tenant_id,
            CustomerCapability.customer_id == customer_id,
            CustomerCapability.product_category == product_category,
        ).limit(1)
    )
    existing = result.scalar_one_or_none()
    if existing:
        existing.customer_name = customer_name
        existing.spec_constraints = spec_constraints
        if notes is not None:
            existing.notes = notes
        await session.flush()
        await session.refresh(existing)
        return existing
    cap = CustomerCapability(
        tenant_id=tenant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        product_category=product_category,
        spec_constraints=spec_constraints,
        notes=notes,
    )
    session.add(cap)
    await session.flush()
    await session.refresh(cap)
    return cap


async def get_capabilities(
    session: AsyncSession,
    customer_id: str,
    tenant_id: Optional[str] = None,
    product_category: Optional[str] = None,
) -> list[CustomerCapability]:
    """查询客户的能力列表。"""
    stmt = select(CustomerCapability).where(
        CustomerCapability.customer_id == customer_id,
    )
    if tenant_id:
        stmt = stmt.where(CustomerCapability.tenant_id == tenant_id)
    if product_category:
        stmt = stmt.where(CustomerCapability.product_category == product_category)
    stmt = stmt.order_by(CustomerCapability.created_at.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def update_capability(
    session: AsyncSession,
    cap_id: int,
    customer_id: str,
    spec_constraints: Optional[dict] = None,
    is_active: Optional[bool] = None,
    tenant_id: Optional[str] = None,
) -> Optional[CustomerCapability]:
    """更新客户能力的 spec_constraints（前端 PATCH 兼容）。"""
    stmt = select(CustomerCapability).where(
        CustomerCapability.id == cap_id,
        CustomerCapability.customer_id == customer_id,
    )
    if tenant_id:
        stmt = stmt.where(CustomerCapability.tenant_id == tenant_id)
    stmt = stmt.limit(1)
    result = await session.execute(stmt)
    existing = result.scalar_one_or_none()
    if not existing:
        return None
    if spec_constraints is not None:
        existing.spec_constraints = spec_constraints
    await session.flush()
    await session.refresh(existing)
    return existing


async def list_capabilities(
    session: AsyncSession,
    customer_id: Optional[str] = None,
    tenant_id: Optional[str] = None,
    limit: int = 100,
) -> list[CustomerCapability]:
    """查询能力列表，可选按客户/租户过滤。"""
    stmt = select(CustomerCapability).order_by(CustomerCapability.created_at.desc())
    if customer_id:
        stmt = stmt.where(CustomerCapability.customer_id == customer_id)
    if tenant_id:
        stmt = stmt.where(CustomerCapability.tenant_id == tenant_id)
    stmt = stmt.limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())
