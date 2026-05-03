"""
Kaas v2 · 事件归档定时任务 (§3.7.13 / §3.7.16)
APScheduler daily job:
  扫描超过 ARCHIVE_TTL_DAYS 的分区，COPY 到 MinIO 后写入 events_archive_log。
"""
import json
import os
from datetime import datetime, timezone, timedelta

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from minio import Minio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.config.settings import settings
from app.db.session import async_session_factory
from app.db.models import Event
from app.repositories.admin import insert_archive_log

ARCHIVE_TTL_DAYS = int(os.environ.get("ARCHIVE_TTL_DAYS", "90"))


async def _get_minio_client() -> Minio:
    return Minio(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
    )


async def _ensure_bucket(client: Minio) -> None:
    bucket = settings.minio_bucket
    found = client.bucket_exists(bucket)
    if not found:
        client.make_bucket(bucket)


async def archive_old_events():
    """
    归档超期事件到 MinIO。
    扫描超过 ARCHIVE_TTL_DAYS 的事件分区，导出 JSON 后写入归档日志。
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=ARCHIVE_TTL_DAYS)
    cutoff_str = cutoff.strftime("%Y-%m-%d")
    month_str = cutoff.strftime("%Y-%m")

    async with async_session_factory() as session:
        result = await session.execute(
            select(Event)
            .where(Event.created_at < cutoff)
            .order_by(Event.created_at.asc())
            .limit(10000)
        )
        rows = result.scalars().all()

        if not rows:
            return {"archived": 0, "message": f"No events before {cutoff_str}"}

        # 按租户分组
        tenant_events: dict[str, list] = {}
        for evt in rows:
            tenant_events.setdefault(evt.tenant_id, []).append({
                "id": str(evt.id),
                "created_at": evt.created_at.isoformat(),
                "trace_id": evt.trace_id,
                "route_version": evt.route_version,
                "tenant_id": evt.tenant_id,
                "event_type": evt.event_type,
                "schema_version": evt.schema_version,
                "payload": evt.payload,
                "sampled": evt.sampled,
                "source": evt.source,
            })

        client = await _get_minio_client()
        await _ensure_bucket(client)

        archived_count = 0
        bucket = settings.minio_bucket

        for tenant_id, events in tenant_events.items():
            object_name = f"archive/{tenant_id}/{month_str}/events_{cutoff_str}.json"
            data = json.dumps(events, ensure_ascii=False, default=str).encode("utf-8")
            client.put_object(
                bucket_name=bucket,
                object_name=object_name,
                data=data,
                length=len(data),
                content_type="application/json",
            )

            await insert_archive_log(
                session=session,
                tenant_id=tenant_id,
                month=month_str,
                minio_path=f"{bucket}/{object_name}",
                status="archived",
            )
            archived_count += len(events)

        await session.commit()

        return {
            "archived": archived_count,
            "tenants": list(tenant_events.keys()),
            "month": month_str,
        }


_scheduler: AsyncIOScheduler | None = None


def start_scheduler():
    """启动 APScheduler，注册每日归档任务。"""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(
        archive_old_events,
        trigger=CronTrigger(hour=3, minute=0),
        id="archive_old_events",
        name="Daily events archive to MinIO",
        replace_existing=True,
    )
    _scheduler.start()


def stop_scheduler():
    """关闭 APScheduler。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
