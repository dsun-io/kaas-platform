"""
价格引擎 — SKU 价格 upsert + 时段重叠检测。
INSERT-only 模式: 改价 = expire 旧 + insert 新。
"""
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ProductSkuPrice, PriceUnit


async def get_price_unit_by_code(db: AsyncSession, code: str) -> PriceUnit | None:
    result = await db.execute(select(PriceUnit).where(PriceUnit.code == code))
    return result.scalar_one_or_none()


async def get_active_price(
    db: AsyncSession,
    tenant_id: str,
    sku_id: int,
    at_date: Optional[datetime] = None,
) -> ProductSkuPrice | None:
    """获取指定 SKU 的当前有效价格。"""
    if at_date is None:
        at_date = datetime.now(timezone.utc)
    stmt = (
        select(ProductSkuPrice)
        .where(
            ProductSkuPrice.sku_id == sku_id,
            ProductSkuPrice.tenant_id == tenant_id,
            ProductSkuPrice.status == "active",
            ProductSkuPrice.effective_from <= at_date,
            (ProductSkuPrice.effective_to.is_(None)) | (ProductSkuPrice.effective_to > at_date),
        )
        .order_by(ProductSkuPrice.effective_from.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def upsert_price(
    db: AsyncSession,
    sku_id: int,
    tenant_id: str,
    price: float,
    price_unit_code: str,
    effective_from: datetime,
    effective_to: Optional[datetime] = None,
    min_qty: Optional[float] = None,
    tier_rules: Optional[list[dict]] = None,
    note: Optional[str] = None,
    change_reason: Optional[str] = None,
    created_by: Optional[str] = None,
) -> int:
    """
    Upsert SKU 价格。
    1. 检测时段重叠
    2. 老价截断或 superseded
    3. INSERT 新价
    返回新 price id。
    """
    # 查找重叠的 active 价格
    overlap_stmt = text("""
        SELECT id, effective_from, effective_to FROM product_sku_prices
        WHERE sku_id = :sku_id AND status = 'active'
          AND tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz), '[)')
              && tstzrange(:new_from, COALESCE(:new_to, 'infinity'::timestamptz), '[)')
        FOR UPDATE
    """)
    overlapping = await db.execute(overlap_stmt, {
        "sku_id": sku_id,
        "new_from": effective_from,
        "new_to": effective_to,
    })

    for old in overlapping.fetchall():
        old_from, old_to = old.effective_from, old.effective_to
        # 新价完全覆盖旧价 → superseded
        if old_from >= effective_from and (effective_to is None or (old_to is not None and old_to <= effective_to)):
            await db.execute(
                text("UPDATE product_sku_prices SET status='superseded' WHERE id=:id"),
                {"id": old.id},
            )
        # 旧价开始早于新价 → 截断旧价
        elif old_from < effective_from:
            await db.execute(
                text("UPDATE product_sku_prices SET effective_to=:cut WHERE id=:id"),
                {"cut": effective_from, "id": old.id},
            )
        else:
            raise ValueError("New price is fully contained in an existing active price range.")

    # INSERT 新价
    new_price = ProductSkuPrice(
        sku_id=sku_id,
        tenant_id=tenant_id,
        price=price,
        price_unit=price_unit_code,
        min_qty=min_qty,
        tier_rules=tier_rules,
        effective_from=effective_from,
        effective_to=effective_to,
        status="active",
        note=note,
        change_reason=change_reason,
        created_by=created_by,
    )
    db.add(new_price)
    await db.flush()
    return new_price.id
