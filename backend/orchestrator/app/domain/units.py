"""
单位归一化服务 — 查询 units 表进行单位换算。
"""
from decimal import Decimal
from typing import Any
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Unit


async def get_unit_by_code(db: AsyncSession, code: str) -> Unit | None:
    result = await db.execute(select(Unit).where(Unit.code == code))
    return result.scalar_one_or_none()


async def convert_to_base_unit(
    value: Any,
    from_unit: str,
    base_unit: str,
    db: AsyncSession,
) -> Decimal:
    """将 value 从 from_unit 换算到 base_unit。"""
    if from_unit == base_unit:
        return Decimal(str(value))

    from_u = await get_unit_by_code(db, from_unit)
    base_u = await get_unit_by_code(db, base_unit)

    if from_u is None:
        raise ValueError(f"Unknown unit: {from_unit}")
    if base_u is None:
        raise ValueError(f"Unknown unit: {base_unit}")
    if from_u.unit_group != base_u.unit_group:
        raise ValueError(f"Unit mismatch: {from_unit} ({from_u.unit_group}) vs {base_unit} ({base_u.unit_group})")

    return Decimal(str(value)) * (Decimal(str(from_u.to_base_factor)) / Decimal(str(base_u.to_base_factor)))


def convert_to_base_unit_sync(
    value: Any,
    from_unit: str,
    base_unit: str,
    factor_map: dict[str, Decimal],
) -> Decimal:
    """同步版本，使用预加载的 factor_map（用于 spec_hash 计算时无 db session 场景）。"""
    if from_unit == base_unit:
        return Decimal(str(value))
    from_factor = factor_map.get(from_unit)
    base_factor = factor_map.get(base_unit)
    if from_factor is None or base_factor is None:
        raise ValueError(f"Unknown unit: {from_unit} or {base_unit}")
    return Decimal(str(value)) * (from_factor / base_factor)
