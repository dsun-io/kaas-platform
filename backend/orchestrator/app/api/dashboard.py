"""Kaas v2 · 仪表盘聚合 API

从 DB 中聚合实际业务指标：
- 报价数、活跃客户、Token 消耗、P95 延迟、数据集命中、采样覆盖率。
"""
from fastapi import APIRouter, Request, Query, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, text
from app.db.session import get_db_session
from app.db.models import Event, Quotation

router = APIRouter(prefix="/api/v1", tags=["dashboard"])


@router.get("/dashboard/summary")
async def dashboard_summary(
    request: Request,
    range: str = Query("today", description="时间范围: today/week/month"),
    db: AsyncSession = Depends(get_db_session),
):
    """聚合仪表盘数据，全部从 DB 采集。"""

    # ── 时间范围过滤 ──────────────────────────────────────────────────
    import re
    from datetime import datetime, timezone, timedelta

    now = datetime.now(timezone.utc)
    if range == "today":
        since = now.replace(hour=0, minute=0, second=0, microsecond=0)
    elif range == "7d":
        since = now - timedelta(days=7)
    elif range == "30d":
        since = now - timedelta(days=30)
    else:
        since = now.replace(hour=0, minute=0, second=0, microsecond=0)

    since_str = since.isoformat()

    # ── Quote counts ───────────────────────────────────────────────────
    count_q_total = select(func.count()).select_from(Quotation).where(
        Quotation.created_at >= since
    )
    result = await db.execute(count_q_total)
    quotations_total = result.scalar() or 0

    # sampled quotations (sampled via event source or sampling flag)
    count_q_sampled = (
        select(func.count())
        .select_from(Quotation)
        .where(Quotation.created_at >= since)
        .where(Quotation.source == "auto")
    )
    result = await db.execute(count_q_sampled)
    quotations_sampled = result.scalar() or 0

    # ── Active customers ───────────────────────────────────────────────
    cust_q = (
        select(func.count(func.distinct(Quotation.customer_id)))
        .select_from(Quotation)
        .where(Quotation.created_at >= since)
    )
    result = await db.execute(cust_q)
    active_customers = result.scalar() or 0

    cust_s_q = (
        select(func.count(func.distinct(Quotation.customer_id)))
        .select_from(Quotation)
        .where(Quotation.created_at >= since)
        .where(Quotation.source == "auto")
    )
    result = await db.execute(cust_s_q)
    customers_sampled = result.scalar() or 0

    # ── Token consumption (from event payloads) ────────────────────────
    # Events store token usage in payload as JSON: {"token_total": N, ...}
    token_q = text("""
        SELECT
            COALESCE(SUM(CAST(payload->>'token_total' AS INTEGER)), 0) AS token_total,
            COALESCE(SUM(CASE WHEN sampled THEN CAST(payload->>'token_total' AS INTEGER) ELSE 0 END), 0) AS token_sampled,
            COUNT(*) FILTER (WHERE payload ? 'token_total') AS token_events
        FROM events
        WHERE created_at >= :since
          AND payload ? 'token_total'
    """)
    result = await db.execute(token_q, {"since": since_str})
    row = result.fetchone()
    token_total = row._mapping["token_total"] if row else 0
    token_sampled = row._mapping["token_sampled"] if row else 0

    # ── P95 latency from event timestamps ──────────────────────────────
    # Use quote.response events and compute latency from quote.request -> quote.response
    latency_q = text("""
        WITH request_times AS (
            SELECT
                tenant_id,
                EXTRACT(EPOCH FROM created_at) AS req_time,
                payload->>'request_id' AS req_id
            FROM events
            WHERE event_type = 'quote.request'
              AND created_at >= :since
        ),
        response_times AS (
            SELECT
                tenant_id,
                EXTRACT(EPOCH FROM created_at) AS resp_time,
                payload->>'request_id' AS req_id
            FROM events
            WHERE event_type = 'quote.response'
              AND created_at >= :since
        )
        SELECT
            percentile_cont(0.95) WITHIN GROUP (ORDER BY (r.resp_time - q.req_time) * 1000) AS p95_ms,
            COUNT(*) AS latency_count
        FROM request_times q
        JOIN response_times r USING (req_id)
    """)
    result = await db.execute(latency_q, {"since": since_str})
    row = result.fetchone()
    p95_latency_ms = round(row._mapping["p95_ms"], 1) if row and row._mapping["p95_ms"] else 0
    latency_sampled = row._mapping["latency_count"] if row and row._mapping["latency_count"] else 0

    # ── Fallback / dataset hits from event payloads ─────────────────────
    dataset_q = text("""
        SELECT payload->>'dataset_name' AS ds, COUNT(*) AS cnt
        FROM events
        WHERE event_type = 'kb.query'
          AND created_at >= :since
        GROUP BY payload->>'dataset_name'
        ORDER BY cnt DESC
        LIMIT 10
    """)
    result = await db.execute(dataset_q, {"since": since_str})
    dataset_hits = {row._mapping["ds"]: row._mapping["cnt"] for row in result.fetchall()}
    if not dataset_hits:
        dataset_hits = {"kb_query": 0}

    return JSONResponse(
        status_code=200,
        content={
            "range": range,
            "quotations_total": quotations_total,
            "quotations_sampled": quotations_sampled,
            "active_customers": active_customers,
            "customers_sampled": customers_sampled,
            "dataset_hits": dataset_hits,
            "token_total": token_total,
            "token_sampled": token_sampled,
            "p95_latency_ms": p95_latency_ms,
            "latency_sampled": latency_sampled,
        },
    )
