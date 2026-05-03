from typing import Optional
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Event


async def insert_event(
    session: AsyncSession,
    tenant_id: str,
    trace_id: Optional[str],
    event_type: str,
    schema_version: int,
    event_source: str,
    payload: dict,
    sampled: bool,
    actor_id: Optional[str] = None,
    session_id: Optional[str] = None,
) -> Event:
    """持久化原始事件 (INSERT-only · 铁律5)。"""
    new_event = Event(
        tenant_id=tenant_id,
        trace_id=trace_id,
        event_type=event_type,
        schema_version=schema_version,
        event_source=event_source,
        payload=payload,
        sampled=sampled,
        actor_id=actor_id,
        session_id=session_id,
    )
    session.add(new_event)
    await session.flush()
    return new_event


async def list_events(
    session: AsyncSession,
    tenant_id: str | None = None,
    event_type: str | None = None,
    schema_version: int | None = None,
    actor_id: str | None = None,
    event_source: str | None = None,
    sampled: bool | None = None,
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[Event], int]:
    """查询事件列表，支持过滤和分页。"""
    conditions = []
    if tenant_id:
        conditions.append(Event.tenant_id == tenant_id)
    if event_type:
        conditions.append(Event.event_type == event_type)
    if schema_version is not None:
        conditions.append(Event.schema_version == schema_version)
    if actor_id:
        conditions.append(Event.actor_id == actor_id)
    if event_source:
        conditions.append(Event.event_source == event_source)
    if sampled is not None:
        conditions.append(Event.sampled == sampled)

    # Count
    count_q = select(func.count()).select_from(Event)
    if conditions:
        count_q = count_q.where(*conditions)
    total_result = await session.execute(count_q)
    total = total_result.scalar() or 0

    # Query
    q = select(Event).order_by(Event.created_at.desc()).limit(limit).offset(offset)
    if conditions:
        q = q.where(*conditions)
    result = await session.execute(q)
    events = list(result.scalars().all())

    return events, total


async def get_events_by_tenant(
    session: AsyncSession,
    tenant_id: str,
    limit: int = 100,
) -> list[Event]:
    """按租户查询事件（用于测试验证租户隔离）。"""
    result = await session.execute(
        select(Event)
        .where(Event.tenant_id == tenant_id)
        .order_by(Event.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def list_events_by_trace(
    session: AsyncSession,
    tenant_id: str,
    trace_id: str,
    limit: int = 100,
) -> list[Event]:
    """按 trace_id 查询事件列表（租户隔离）。"""
    result = await session.execute(
        select(Event)
        .where(Event.tenant_id == tenant_id, Event.trace_id == trace_id)
        .order_by(Event.created_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def count_by_partition(
    session: AsyncSession,
    tenant_id: str,
    month: str,
) -> int:
    """统计指定月份分区的记录数（month 格式: YYYY_MM）。"""
    result = await session.execute(
        select(func.count())
        .select_from(Event)
        .where(
            Event.tenant_id == tenant_id,
            func.to_char(Event.created_at, "YYYY_MM") == month,
        )
    )
    return result.scalar() or 0


async def get_events_by_partition(
    session: AsyncSession,
    tenant_id: str,
    month: str,
    limit: int = 10000,
) -> list[Event]:
    """获取指定月份的所有事件（用于归档）。"""
    result = await session.execute(
        select(Event)
        .where(
            Event.tenant_id == tenant_id,
            func.to_char(Event.created_at, "YYYY_MM") == month,
        )
        .order_by(Event.created_at.asc())
        .limit(limit)
    )
    return list(result.scalars().all())
