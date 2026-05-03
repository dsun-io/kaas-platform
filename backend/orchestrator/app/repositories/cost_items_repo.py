"""Kaas v2 · CustomerCostItem 仓储 (INT-R3 §1.2)

客户私有成本价 — INSERT-only，不删历史。
仅查询 status='active' 且未过期（effective_to IS NULL OR > now）的记录。
"""
from typing import Optional
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import CustomerCostItem


async def get_current_cost(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    spec_hash: str,
) -> Optional[CustomerCostItem]:
    """查询客户当前有效成本价。

    - 仅 status='active' 且未过期
    - 按 effective_from DESC LIMIT 1 取最新
    """
    now = func.now()
    result = await session.execute(
        select(CustomerCostItem)
        .where(
            CustomerCostItem.tenant_id == tenant_id,
            CustomerCostItem.customer_id == customer_id,
            CustomerCostItem.spec_hash == spec_hash,
            CustomerCostItem.status == "active",
            or_(
                CustomerCostItem.effective_to.is_(None),
                CustomerCostItem.effective_to > now,
            ),
        )
        .order_by(CustomerCostItem.effective_from.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def list_cost_items(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_category: Optional[str] = None,
) -> list[CustomerCostItem]:
    """查询客户成本价列表，可按品类过滤。"""
    now = func.now()
    stmt = select(CustomerCostItem).where(
        CustomerCostItem.tenant_id == tenant_id,
        CustomerCostItem.customer_id == customer_id,
        CustomerCostItem.status == "active",
        or_(
            CustomerCostItem.effective_to.is_(None),
            CustomerCostItem.effective_to > now,
        ),
    )
    if product_category:
        stmt = stmt.where(CustomerCostItem.product_category == product_category)
    stmt = stmt.order_by(CustomerCostItem.effective_from.desc())
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def insert_cost_item(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_category: str,
    spec_hash: str,
    cost_type: str,
    amount: float,
    currency: str,
    unit: str,
    product_spec_id: Optional[int] = None,
    product_spec_json: Optional[dict] = None,
    effective_from: Optional[object] = None,
    effective_to: Optional[object] = None,
    source: str = "manual",
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> CustomerCostItem:
    """插入客户成本价记录 (INSERT-only · 铁律5)。"""
    item = CustomerCostItem(
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_category=product_category,
        spec_hash=spec_hash,
        cost_type=cost_type,
        amount=amount,
        currency=currency,
        unit=unit,
        product_spec_id=product_spec_id,
        product_spec_json=product_spec_json,
        effective_from=effective_from,
        effective_to=effective_to,
        source=source,
        notes=notes,
        created_by=created_by,
    )
    session.add(item)
    await session.flush()
    return item
