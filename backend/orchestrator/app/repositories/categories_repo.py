"""品类 Repository。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductCategory


async def get_category_tree(db: AsyncSession) -> list[ProductCategory]:
    result = await db.execute(
        select(ProductCategory).where(ProductCategory.is_active.is_(True)).order_by(ProductCategory.path)
    )
    return result.scalars().all()


async def get_category_by_id(db: AsyncSession, category_id: int) -> ProductCategory | None:
    return await db.get(ProductCategory, category_id)


async def get_leaf_categories(db: AsyncSession) -> list[ProductCategory]:
    result = await db.execute(
        select(ProductCategory).where(
            ProductCategory.is_leaf.is_(True),
            ProductCategory.is_active.is_(True),
        ).order_by(ProductCategory.path)
    )
    return result.scalars().all()
