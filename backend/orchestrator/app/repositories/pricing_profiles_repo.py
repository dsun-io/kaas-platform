"""Kaas v2 · CustomerPricingProfile 仓储 (INT-R3 §1.3)

客户私有报价策略 — 利润率/税率配置。
"""
from typing import Optional
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import CustomerPricingProfile
from app.domain.category_normalizer import expand_category_search


async def get_current_profile(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_category: str,
) -> Optional[CustomerPricingProfile]:
    """查询客户当前有效的报价策略。

    - 仅 status='active' 且未过期
    - 按 effective_from DESC LIMIT 1 取最新
    """
    now = func.now()
    result = await session.execute(
        select(CustomerPricingProfile)
        .where(
            CustomerPricingProfile.tenant_id == tenant_id,
            CustomerPricingProfile.customer_id == customer_id,
            CustomerPricingProfile.product_category.in_(
                expand_category_search(product_category)
            ),
            CustomerPricingProfile.status == "active",
            or_(
                CustomerPricingProfile.effective_to.is_(None),
                CustomerPricingProfile.effective_to > now,
            ),
        )
        .order_by(CustomerPricingProfile.effective_from.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()
