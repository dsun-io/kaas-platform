"""
Kaas v2 · 事件归档定时任务 (§3.7.10)
APScheduler daily job at 00:30 Asia/Shanghai:
  SELECT * FROM events WHERE created_at::date = (CURRENT_DATE - 1)
  按 schema_version 分桶 → JSONL + GZIP → OSS
"""
import gzip
import hashlib
import json
import os
import structlog
from datetime import datetime, timezone, timedelta
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from minio import Minio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.config.settings import settings
from app.db.session import async_session_factory
from app.db.models import Event
from app.repositories.admin import insert_archive_log

MAX_RETRIES = 3
ARCHIVE_TIMEZONE = "Asia/Shanghai"


async def _get_minio_client() -> Minio:
    return Minio(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
    )


async def _ensure_bucket(client: Minio) -> None:
    bucket = settings.minio_bucket
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


async def _do_archive_events(session: AsyncSession, target_date: str) -> dict:
    """查询目标日期的所有事件，按 schema_version 分桶，上传 OSS。"""
    result = await session.execute(
        select(Event)
        .where(Event.created_at >= f"{target_date}T00:00:00+00:00")
        .where(Event.created_at < f"{target_date}T23:59:59+00:00")
        .order_by(Event.created_at.asc())
    )
    rows = result.scalars().all()

    if not rows:
        return {"archived": 0, "message": f"No events on {target_date}"}

    # 按 schema_version 分桶
    version_buckets: dict[int, list[dict]] = {}
    for evt in rows:
        version_buckets.setdefault(evt.schema_version, []).append({
            "id": evt.id,
            "schema_version": evt.schema_version,
            "tenant_id": evt.tenant_id,
            "event_type": evt.event_type,
            "event_source": evt.event_source,
            "actor_id": evt.actor_id,
            "session_id": evt.session_id,
            "payload": evt.payload,
            "trace_id": evt.trace_id,
            "sampled": evt.sampled,
            "created_at": evt.created_at.isoformat(),
        })

    client = await _get_minio_client()
    await _ensure_bucket(client)
    bucket = settings.minio_bucket
    date_parts = target_date.split("-")  # YYYY-MM-DD
    archived_count = 0

    for schema_version, events in version_buckets.items():
        # JSONL + GZIP
        jsonl = "\n".join(json.dumps(e, ensure_ascii=False, default=str) for e in events)
        compressed = gzip.compress(jsonl.encode("utf-8"))
        sha256_hex = hashlib.sha256(compressed).hexdigest()

        # OSS key: events-archive/{yyyy}/{mm}/{dd}/v{schema_version}.jsonl.gz
        oss_key = (
            f"events-archive/{date_parts[0]}/{date_parts[1]}/{date_parts[2]}/"
            f"v{schema_version}.jsonl.gz"
        )

        client.put_object(
            bucket_name=bucket,
            object_name=oss_key,
            data=compressed,
            length=len(compressed),
            content_type="application/gzip",
        )

        await insert_archive_log(
            session=session,
            tenant_id="*",
            month=f"{date_parts[0]}-{date_parts[1]}",
            minio_path=f"{bucket}/{oss_key}",
            status="archived",
        )

        archived_count += len(events)

    await session.commit()
    return {
        "archived": archived_count,
        "date": target_date,
        "version_count": len(version_buckets),
    }


async def archive_old_events() -> dict:
    """归档昨日事件到 OSS，最多重试 3 次。"""
    from app.core.metrics import ARCHIVE_RUN_TOTAL, ARCHIVE_ROWS_AFFECTED
    logger = structlog.get_logger()

    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
    last_error: Optional[Exception] = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            async with async_session_factory() as session:
                result = await _do_archive_events(session, yesterday)
            ARCHIVE_RUN_TOTAL.labels(status="success").inc()
            ARCHIVE_ROWS_AFFECTED.inc(result.get("archived", 0))
            logger.info("archive_job_complete", date=yesterday, archived=result.get("archived"), version_count=result.get("version_count"))
            return result
        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES:
                continue
            ARCHIVE_RUN_TOTAL.labels(status="failed").inc()
            logger.error("archive_job_failed", date=yesterday, error=str(e))

    return {
        "archived": 0,
        "date": yesterday,
        "error": str(last_error) if last_error else "unknown",
    }


_scheduler: Optional[AsyncIOScheduler] = None


def start_scheduler():
    """启动 APScheduler，注册每日 00:30 Asia/Shanghai 归档任务。"""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = AsyncIOScheduler(timezone=ARCHIVE_TIMEZONE)
    _scheduler.add_job(
        archive_old_events,
        trigger=CronTrigger(hour=0, minute=30),
        id="archive_old_events",
        name="Daily events archive to OSS",
        replace_existing=True,
    )
    _scheduler.start()


def stop_scheduler():
    """关闭 APScheduler。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
