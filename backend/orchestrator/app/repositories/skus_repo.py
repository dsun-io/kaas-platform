"""SKU Repository。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductSku, ProductSkuRevision


async def get_sku_by_hash(
    db: AsyncSession, tenant_id: str, category_id: int, spec_hash: str
) -> ProductSku | None:
    stmt = select(ProductSku).where(
        ProductSku.tenant_id == tenant_id,
        ProductSku.category_id == category_id,
        ProductSku.spec_hash == spec_hash,
        ProductSku.is_active.is_(True),
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def get_sku_by_id(db: AsyncSession, sku_id: int, tenant_id: str) -> ProductSku | None:
    stmt = select(ProductSku).where(
        ProductSku.id == sku_id,
        ProductSku.tenant_id == tenant_id,
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def list_skus(
    db: AsyncSession, tenant_id: str, category_id: int | None = None,
    page: int = 1, page_size: int = 20
) -> tuple[list[ProductSku], int]:
    stmt = select(ProductSku).where(
        ProductSku.tenant_id == tenant_id,
        ProductSku.is_active.is_(True),
    )
    if category_id:
        stmt = stmt.where(ProductSku.category_id == category_id)

    from sqlalchemy import func
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await db.execute(count_stmt)).scalar() or 0

    stmt = stmt.order_by(ProductSku.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(stmt)
    return result.scalars().all(), total


async def create_sku(db: AsyncSession, **kwargs) -> ProductSku:
    sku = ProductSku(**kwargs)
    db.add(sku)
    await db.flush()
    return sku


async def insert_revision(db: AsyncSession, sku: ProductSku, change_reason: str | None, created_by: str | None) -> ProductSkuRevision:
    """将当前 SKU 状态快照插入修订历史。"""
    rev = ProductSkuRevision(
        sku_id=sku.id,
        revision=sku.revision,
        spec_values=sku.spec_values,
        spec_hash=sku.spec_hash,
        schema_version=sku.schema_version,
        change_reason=change_reason,
        created_by=created_by,
    )
    db.add(rev)
    await db.flush()
    return rev
