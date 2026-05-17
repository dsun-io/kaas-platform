"""属性 Repository。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import SpecAttribute, SpecAttributeValue, CategoryAttributeBinding


async def get_attributes_for_category(
    db: AsyncSession, category_id: int, tenant_id: str
) -> list[tuple[CategoryAttributeBinding, SpecAttribute]]:
    """获取类目下所有活跃属性绑定 + 属性详情。"""
    stmt = (
        select(CategoryAttributeBinding, SpecAttribute)
        .join(SpecAttribute, CategoryAttributeBinding.attribute_id == SpecAttribute.id)
        .where(
            CategoryAttributeBinding.category_id == category_id,
            SpecAttribute.status == "active",
            (
                (CategoryAttributeBinding.scope == "public") |
                ((CategoryAttributeBinding.scope == "private") & (CategoryAttributeBinding.tenant_id == tenant_id))
            ),
        )
        .order_by(CategoryAttributeBinding.sort_order)
    )
    result = await db.execute(stmt)
    return result.fetchall()


async def get_attribute_by_id(db: AsyncSession, attr_id: int) -> SpecAttribute | None:
    return await db.get(SpecAttribute, attr_id)


async def get_attribute_values(
    db: AsyncSession, attribute_id: int, tenant_id: str | None = None
) -> list[SpecAttributeValue]:
    stmt = (
        select(SpecAttributeValue)
        .where(
            SpecAttributeValue.attribute_id == attribute_id,
            SpecAttributeValue.status == "active",
        )
        .order_by(SpecAttributeValue.sort_order)
    )
    if tenant_id:
        stmt = stmt.where(
            (SpecAttributeValue.scope == "public") |
            ((SpecAttributeValue.scope == "private") & (SpecAttributeValue.tenant_id == tenant_id))
        )
    else:
        stmt = stmt.where(SpecAttributeValue.scope == "public")
    result = await db.execute(stmt)
    return result.scalars().all()


async def list_attributes(
    db: AsyncSession, scope: str | None = None, group_code: str | None = None
) -> list[SpecAttribute]:
    stmt = select(SpecAttribute).where(SpecAttribute.status == "active")
    if scope:
        stmt = stmt.where(SpecAttribute.scope == scope)
    if group_code:
        stmt = stmt.where(SpecAttribute.group_code == group_code)
    result = await db.execute(stmt.order_by(SpecAttribute.group_code, SpecAttribute.code))
    return result.scalars().all()


async def create_attribute(db: AsyncSession, **kwargs) -> SpecAttribute:
    attr = SpecAttribute(**kwargs)
    db.add(attr)
    await db.flush()
    return attr


async def create_attribute_value(db: AsyncSession, **kwargs) -> SpecAttributeValue:
    val = SpecAttributeValue(**kwargs)
    db.add(val)
    await db.flush()
    return val
