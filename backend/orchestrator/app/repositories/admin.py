import uuid
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.models import EventsArchiveLog


async def insert_archive_log(
    session: AsyncSession,
    tenant_id: str,
    month: str,
    minio_path: str,
    status: str,
) -> EventsArchiveLog:
    """写入归档日志记录 (INSERT-only · 铁律5)。"""
    log = EventsArchiveLog(
        id=uuid.uuid4(),
        tenant_id=tenant_id,
        month=month,
        minio_path=minio_path,
        status=status,
    )
    session.add(log)
    await session.flush()
    return log


async def get_archive_logs(
    session: AsyncSession,
    tenant_id: Optional[str] = None,
    limit: int = 100,
) -> list[EventsArchiveLog]:
    """查询归档日志。"""
    stmt = select(EventsArchiveLog).order_by(EventsArchiveLog.archived_at.desc())
    if tenant_id:
        stmt = stmt.where(EventsArchiveLog.tenant_id == tenant_id)
    stmt = stmt.limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())
