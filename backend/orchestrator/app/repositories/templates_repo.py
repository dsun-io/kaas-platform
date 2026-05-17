"""模板 Repository。"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import IndustryTemplate


async def get_templates(
    db: AsyncSession, category_id: int | None = None, scope: str | None = None
) -> list[IndustryTemplate]:
    stmt = select(IndustryTemplate).where(IndustryTemplate.is_active.is_(True))
    if scope:
        stmt = stmt.where(IndustryTemplate.template_type == scope)
    result = await db.execute(stmt.order_by(IndustryTemplate.code))
    return result.scalars().all()


async def get_template_by_id(db: AsyncSession, template_id: int) -> IndustryTemplate | None:
    return await db.get(IndustryTemplate, template_id)
