"""价格 Repository。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductSkuPrice


async def get_active_price(db: AsyncSession, sku_id: int, tenant_id: str) -> ProductSkuPrice | None:
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    stmt = (
        select(ProductSkuPrice)
        .where(
            ProductSkuPrice.sku_id == sku_id,
            ProductSkuPrice.tenant_id == tenant_id,
            ProductSkuPrice.status == "active",
            ProductSkuPrice.effective_from <= now,
            (ProductSkuPrice.effective_to.is_(None)) | (ProductSkuPrice.effective_to > now),
        )
        .order_by(ProductSkuPrice.effective_from.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_prices_for_sku(db: AsyncSession, sku_id: int) -> list[ProductSkuPrice]:
    stmt = (
        select(ProductSkuPrice)
        .where(ProductSkuPrice.sku_id == sku_id)
        .order_by(ProductSkuPrice.effective_from.desc())
    )
    result = await db.execute(stmt)
    return result.scalars().all()
