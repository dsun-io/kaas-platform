import uuid
from datetime import datetime, timezone
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import Event


async def insert_event(
    session: AsyncSession,
    tenant_id: str,
    trace_id: str,
    route_version: str,
    event_type: str,
    schema_version: str,
    payload: dict,
    sampled: bool,
    source: str,
) -> Event:
    """
    持久化原始事件 (INSERT-only · 铁律5)。
    所有参数必须显式传入，严禁依赖隐式上下文。
    """
    new_event = Event(
        id=uuid.uuid4(),
        created_at=datetime.now(timezone.utc),
        trace_id=trace_id,
        route_version=route_version,
        tenant_id=tenant_id,
        event_type=event_type,
        schema_version=schema_version,
        payload=payload,
        sampled=sampled,
        source=source,
    )
    session.add(new_event)
    await session.flush()
    return new_event


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
    """获取指定月份分区的所有事件（用于归档 COPY）。"""
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
