"""Kaas v2 · CustomerSalePriceItem 仓储 (INT-R3 §1.4)

客户私有销售价覆盖 — INSERT-only，不删历史。
"""
from typing import Optional
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import CustomerSalePriceItem


async def get_current_sale_price(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    spec_hash: str,
) -> Optional[CustomerSalePriceItem]:
    """查询客户当前有效销售价。

    - 仅 status='active' 且未过期
    - 按 effective_from DESC LIMIT 1 取最新
    """
    now = func.now()
    result = await session.execute(
        select(CustomerSalePriceItem)
        .where(
            CustomerSalePriceItem.tenant_id == tenant_id,
            CustomerSalePriceItem.customer_id == customer_id,
            CustomerSalePriceItem.spec_hash == spec_hash,
            CustomerSalePriceItem.status == "active",
            or_(
                CustomerSalePriceItem.effective_to.is_(None),
                CustomerSalePriceItem.effective_to > now,
            ),
        )
        .order_by(CustomerSalePriceItem.effective_from.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def insert_sale_price_item(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_category: str,
    spec_hash: str,
    sale_price_type: str,
    amount: float,
    currency: str,
    unit: str,
    product_spec_id: Optional[int] = None,
    product_spec_json: Optional[dict] = None,
    min_quantity: Optional[int] = None,
    effective_from: Optional[object] = None,
    effective_to: Optional[object] = None,
    source: str = "manual",
    notes: Optional[str] = None,
    created_by: Optional[str] = None,
) -> CustomerSalePriceItem:
    """插入客户销售价覆盖记录 (INSERT-only · 铁律5)。"""
    item = CustomerSalePriceItem(
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_category=product_category,
        spec_hash=spec_hash,
        sale_price_type=sale_price_type,
        amount=amount,
        currency=currency,
        unit=unit,
        product_spec_id=product_spec_id,
        product_spec_json=product_spec_json,
        min_quantity=min_quantity,
        effective_from=effective_from,
        effective_to=effective_to,
        source=source,
        notes=notes,
        created_by=created_by,
    )
    session.add(item)
    await session.flush()
    return item
