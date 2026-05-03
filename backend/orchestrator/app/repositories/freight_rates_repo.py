"""Kaas v2 · CustomerFreightRate 仓储 (INT-R3 §1.5)

客户私有运费表 — 支持 base_plus_weight / per_kg / fixed 三种公式。
"""
from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import CustomerFreightRate


async def get_freight_rates(
    session: AsyncSession,
    tenant_id: str,
    customer_id: str,
    province: str,
) -> list[CustomerFreightRate]:
    """查询客户指定省份的运费记录。

    仅 status='active' 且未过期的记录，按 effective_from DESC 排序。
    """
    now = func.now()
    stmt = (
        select(CustomerFreightRate)
        .where(
            CustomerFreightRate.tenant_id == tenant_id,
            CustomerFreightRate.customer_id == customer_id,
            CustomerFreightRate.province == province,
            CustomerFreightRate.status == "active",
            (CustomerFreightRate.effective_to.is_(None))
            | (CustomerFreightRate.effective_to > now),
        )
        .order_by(CustomerFreightRate.effective_from.desc())
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())
