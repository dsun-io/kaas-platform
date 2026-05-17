"""Kaas v2 · ProductSpec 仓储 (INT-R3 §1.1)

按产品类别/类型/规格参数查询平台通用规格记录。
"""
from typing import Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductSpec
from app.domain.category_normalizer import expand_category_search


async def list_specs(
    db: AsyncSession,
    product_category: str,
    product_type: Optional[str] = None,
) -> list[ProductSpec]:
    """按品类（+可选类型）列出所有活跃规格。"""
    stmt = select(ProductSpec).where(
        ProductSpec.product_category.in_(expand_category_search(product_category)),
        ProductSpec.is_active == True,
    )
    if product_type:
        stmt = stmt.where(ProductSpec.product_type == product_type)
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_spec_by_hash(
    db: AsyncSession,
    spec_hash: str,
) -> Optional[ProductSpec]:
    """按 spec_hash 查询规格。"""
    result = await db.execute(
        select(ProductSpec).where(
            ProductSpec.spec_hash == spec_hash,
            ProductSpec.is_active == True,
        )
    )
    return result.scalar_one_or_none()


async def match_specs(
    db: AsyncSession,
    product_category: str,
    product_type: Optional[str] = None,
    wire_diameter: Optional[str] = None,
    height: Optional[float] = None,
    mesh_width: Optional[float] = None,
    mesh_spec: Optional[str] = None,
    roll_length: Optional[float] = None,
) -> list[ProductSpec]:
    """按规格参数查询活跃的平台通用规格。

    所有可选参数均为 AND 过滤，只有非 None 的参数参与查询。
    返回匹配列表供调用方判断 matched / no_match / too_many。
    """
    stmt = select(ProductSpec).where(
        ProductSpec.product_category.in_(expand_category_search(product_category)),
        ProductSpec.is_active == True,
    )
    if product_type is not None:
        stmt = stmt.where(ProductSpec.product_type == product_type)
    if wire_diameter is not None:
        stmt = stmt.where(ProductSpec.wire_diameter == wire_diameter)
    if height is not None:
        stmt = stmt.where(ProductSpec.height == height)
    if mesh_width is not None:
        stmt = stmt.where(ProductSpec.mesh_width == mesh_width)
    if mesh_spec is not None:
        stmt = stmt.where(ProductSpec.mesh_spec == mesh_spec)
    if roll_length is not None:
        stmt = stmt.where(ProductSpec.roll_length == roll_length)

    result = await db.execute(stmt)
    return list(result.scalars().all())


async def create_spec(
    db: AsyncSession,
    product_category: str,
    spec_hash: str,
    product_type: Optional[str] = None,
    wire_diameter: Optional[str] = None,
    height: Optional[float] = None,
    mesh_width: Optional[float] = None,
    mesh_spec: Optional[str] = None,
    roll_length: Optional[float] = None,
    bundle_size: Optional[int] = None,
    weight_kg: Optional[float] = None,
) -> ProductSpec:
    """创建新平台规格记录。"""
    spec = ProductSpec(
        product_category=product_category,
        product_type=product_type,
        wire_diameter=wire_diameter,
        height=height,
        mesh_width=mesh_width,
        mesh_spec=mesh_spec,
        roll_length=roll_length,
        bundle_size=bundle_size,
        weight_kg=weight_kg,
        spec_hash=spec_hash,
    )
    db.add(spec)
    await db.flush()
    return spec
