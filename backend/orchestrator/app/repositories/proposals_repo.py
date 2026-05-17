"""属性沉淀提案 Repository。"""
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import AttributeProposal


async def list_proposals(
    db: AsyncSession, tenant_id: str | None = None, status: str | None = None
) -> list[AttributeProposal]:
    stmt = select(AttributeProposal)
    if tenant_id:
        stmt = stmt.where(AttributeProposal.tenant_id == tenant_id)
    if status:
        stmt = stmt.where(AttributeProposal.status == status)
    result = await db.execute(stmt.order_by(AttributeProposal.created_at.desc()))
    return result.scalars().all()


async def list_recommended(db: AsyncSession) -> list[AttributeProposal]:
    stmt = (
        select(AttributeProposal)
        .where(
            AttributeProposal.recommended_for_promotion.is_(True),
            AttributeProposal.status == "pending",
        )
        .order_by(AttributeProposal.recommendation_score.desc())
    )
    result = await db.execute(stmt)
    return result.scalars().all()


async def get_proposal_by_id(db: AsyncSession, proposal_id: int) -> AttributeProposal | None:
    return await db.get(AttributeProposal, proposal_id)


async def update_proposal_status(
    db: AsyncSession, proposal_id: int, status: str, reviewer: str, review_note: str | None = None
) -> None:
    from datetime import datetime, timezone
    await db.execute(
        update(AttributeProposal)
        .where(AttributeProposal.id == proposal_id)
        .values(
            status=status,
            reviewer=reviewer,
            review_note=review_note,
            reviewed_at=datetime.now(timezone.utc),
        )
    )


async def create_proposal(db: AsyncSession, **kwargs) -> AttributeProposal:
    proposal = AttributeProposal(**kwargs)
    db.add(proposal)
    await db.flush()
    return proposal
