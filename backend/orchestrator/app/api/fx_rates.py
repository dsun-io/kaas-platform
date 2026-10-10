"""汇率 API：查询/手动补录 USD/CNY 汇率（fx_rates）。

与 scripts/fetch_fx_rates.py 配套：脚本负责每日拉取，这里提供查询与人工兜底录入。
报价/订单生成时由 ws_common.lock_fx_rate 锁定当日快照，故这里只读为主。
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import FxRate
from app.core.auth import AuthContext, get_auth_context

router = APIRouter(prefix="/api/v1", tags=["fx-rates"])


class FxRateIn(BaseModel):
    base_currency: str = "USD"
    quote_currency: str = "CNY"
    rate: float
    rate_date: Optional[str] = None
    source: str = "manual"


class FxRateOut(BaseModel):
    base_currency: str
    quote_currency: str
    rate: float
    rate_date: str
    source: Optional[str]
    is_stale: bool


@router.get("/fx-rates", response_model=list[FxRateOut])
async def list_fx_rates(
    base_currency: str = "USD",
    quote_currency: str = "CNY",
    limit: int = 30,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> list[FxRateOut]:
    rows = (await db.execute(
        select(FxRate)
        .where(
            FxRate.base_currency == base_currency,
            FxRate.quote_currency == quote_currency,
        )
        .order_by(desc(FxRate.rate_date))
        .limit(min(max(limit, 1), 365))
    )).scalars().all()
    return [
        FxRateOut(
            base_currency=r.base_currency,
            quote_currency=r.quote_currency,
            rate=float(r.rate),
            rate_date=r.rate_date.isoformat(),
            source=r.source,
            is_stale=bool(r.is_stale),
        )
        for r in rows
    ]


@router.get("/fx-rates/latest")
async def latest_fx_rate(
    base_currency: str = "USD",
    quote_currency: str = "CNY",
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> FxRateOut:
    r = (await db.execute(
        select(FxRate)
        .where(
            FxRate.base_currency == base_currency,
            FxRate.quote_currency == quote_currency,
        )
        .order_by(desc(FxRate.rate_date))
        .limit(1)
    )).scalar_one_or_none()
    if r is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FX_RATE_NOT_FOUND"})
    return FxRateOut(
        base_currency=r.base_currency,
        quote_currency=r.quote_currency,
        rate=float(r.rate),
        rate_date=r.rate_date.isoformat(),
        source=r.source,
        is_stale=bool(r.is_stale),
    )


@router.post("/fx-rates", status_code=201)
async def upsert_fx_rate(
    body: FxRateIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> FxRateOut:
    if body.rate <= 0:
        raise HTTPException(status_code=422, detail={"error": "invalid_rate", "message": "rate must be > 0"})
    rate_date = date.fromisoformat(body.rate_date) if body.rate_date else date.today()
    row = (await db.execute(
        select(FxRate).where(
            FxRate.base_currency == body.base_currency,
            FxRate.quote_currency == body.quote_currency,
            FxRate.rate_date == rate_date,
        )
    )).scalar_one_or_none()
    if row is None:
        row = FxRate(
            base_currency=body.base_currency,
            quote_currency=body.quote_currency,
            rate=Decimal(str(body.rate)),
            rate_date=rate_date,
            source=body.source,
            is_stale=False,
            fetched_at=datetime.now(timezone.utc),
        )
        db.add(row)
    else:
        row.rate = Decimal(str(body.rate))
        row.source = body.source
        row.is_stale = False
        row.fetched_at = datetime.now(timezone.utc)
    await db.commit()
    return FxRateOut(
        base_currency=row.base_currency,
        quote_currency=row.quote_currency,
        rate=float(row.rate),
        rate_date=row.rate_date.isoformat(),
        source=row.source,
        is_stale=bool(row.is_stale),
    )
