"""Kaas v2 · Quotation 仓储 (§5 T1)

INSERT-only（铁律5），按 spec_hash 查最新报价。
"""
from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Quotation


async def insert_quotation(
    session: AsyncSession,
    customer_id: str,
    product_category: str,
    product_spec: dict,
    spec_hash: str,
    unit_price: Optional[float],
    currency: str,
    unit: str,
    discount: Optional[float],
    min_quantity: Optional[int],
    source: str,
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> Quotation:
    """插入报价记录 (INSERT-only · 铁律5)。"""
    q = Quotation(
        customer_id=customer_id,
        product_category=product_category,
        product_spec=product_spec,
        spec_hash=spec_hash,
        unit_price=unit_price,
        currency=currency,
        unit=unit,
        discount=discount,
        min_quantity=min_quantity,
        source=source,
        notes=notes,
        created_by=created_by,
    )
    session.add(q)
    await session.flush()
    return q


async def get_latest_price(
    session: AsyncSession,
    customer_id: str,
    product_category: str,
    spec_hash: str,
) -> Optional[Quotation]:
    """按客户+品类+spec_hash 查询最新报价。"""
    result = await session.execute(
        select(Quotation)
        .where(
            Quotation.customer_id == customer_id,
            Quotation.product_category == product_category,
            Quotation.spec_hash == spec_hash,
        )
        .order_by(Quotation.effective_from.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def list_quotations(
    session: AsyncSession,
    customer_id: Optional[str] = None,
    product_category: Optional[str] = None,
    limit: int = 100,
) -> list[Quotation]:
    """查询报价列表，可按客户/品类过滤。"""
    stmt = select(Quotation).order_by(Quotation.effective_from.desc())
    if customer_id:
        stmt = stmt.where(Quotation.customer_id == customer_id)
    if product_category:
        stmt = stmt.where(Quotation.product_category == product_category)
    stmt = stmt.limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def count_quotations(
    session: AsyncSession,
    customer_id: Optional[str] = None,
) -> int:
    """统计报价条数。"""
    stmt = select(func.count()).select_from(Quotation)
    if customer_id:
        stmt = stmt.where(Quotation.customer_id == customer_id)
    result = await session.execute(stmt)
    return result.scalar() or 0
