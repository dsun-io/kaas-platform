"""Kaas v2 · 仪表盘聚合 API"""
from fastapi import APIRouter, Request, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from app.db.session import get_db_session
from app.db.models import Event, Quotation

router = APIRouter(prefix="/api/v1", tags=["dashboard"])


@router.get("/dashboard/summary")
async def dashboard_summary(
    request: Request,
    range: str = Query("today", description="时间范围: today/week/month"),
    db: AsyncSession = Depends(get_db_session),
):
    """聚合仪表盘数据。"""
    # Count events
    count_events = select(func.count()).select_from(Event)
    events_result = await db.execute(count_events)
    total_events = events_result.scalar() or 0

    # Count quotations
    count_quotations = select(func.count()).select_from(Quotation)
    quotations_result = await db.execute(count_quotations)
    total_quotations = quotations_result.scalar() or 0

    # Active tenants from events
    tenant_q = select(func.count(func.distinct(Event.tenant_id)))
    tenant_result = await db.execute(tenant_q)
    active_tenants = tenant_result.scalar() or 0

    return JSONResponse(
        status_code=200,
        content={
            "range": range,
            "quotations_total": total_quotations,
            "quotations_sampled": total_quotations,
            "active_customers": active_tenants,
            "customers_sampled": active_tenants,
            "dataset_hits": {"seed_data": total_quotations},
            "token_total": 0,
            "token_sampled": 0,
            "p95_latency_ms": 0,
            "latency_sampled": 0,
        },
    )
