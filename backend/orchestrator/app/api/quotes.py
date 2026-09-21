"""报价工位 API（WORKSTATION_DESIGN.md §5-§6 / §10.2 / §10.7）

端点：
- GET   /api/v1/quotes            报价单列表（分页 + status 筛选 + 可见范围）
- POST  /api/v1/quotes            新建报价单（QUO 单号 + 生成时锁汇率快照）
- GET   /api/v1/quotes/{id}       报价单详情（含行项）
- PATCH /api/v1/quotes/{id}       更新字段 / 状态流转
                                  （draft→sent→accepted/rejected/expired）

报价单状态机（§10.4）：draft → sent → accepted / rejected / expired。
accepted 由订单工位转化订单时联动置位（order_quote_refs converted_from）。
"""
from typing import List, Optional
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func

from app.db.session import get_db_session
from app.db.workstation_links import QuoteOrder, QuoteOrderItem
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, QUOTE_STATUS, CURRENCY, OWNER_SCOPE
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no, lock_fx_rate,
)

router = APIRouter(prefix="/api/v1", tags=["quotes"])

ORDER_NEXT = {"draft": ("sent", "expired"), "sent": ("accepted", "rejected", "expired")}


# ── Schemas ──────────────────────────────────────────────────────────────────

class QuoteItemIn(BaseModel):
    sku_id: Optional[int] = None
    product_name: Optional[str] = None
    spec_snapshot: Optional[dict] = None
    qty: Decimal = Decimal("1")
    qty_unit: Optional[str] = None
    unit_price: Optional[Decimal] = None
    currency: Optional[str] = None
    line_amount: Optional[Decimal] = None
    sort_order: int = 0


class QuoteCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    currency: str = "USD"
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: str = "private"
    items: List[QuoteItemIn] = []


class QuotePatch(BaseModel):
    customer_name: Optional[str] = None
    currency: Optional[str] = None
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_quote(q: QuoteOrder) -> dict:
    return {
        "id": q.id, "quote_no": q.quote_no, "customer_id": q.customer_id,
        "customer_name": q.customer_name, "status": q.status, "currency": q.currency,
        "total_amount": float(q.total_amount) if q.total_amount is not None else None,
        "valid_until": q.valid_until.isoformat() if q.valid_until else None,
        "notes": q.notes,
        "fx_rate": float(q.fx_rate) if q.fx_rate is not None else None,
        "fx_rate_date": q.fx_rate_date.isoformat() if q.fx_rate_date else None,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "owner_id": q.owner_id, "owner_scope": q.owner_scope,
    }


def _row_to_item(it: QuoteOrderItem) -> dict:
    return {
        "id": it.id, "sku_id": it.sku_id, "product_name": it.product_name,
        "spec_snapshot": it.spec_snapshot,
        "qty": float(it.qty) if it.qty is not None else None,
        "qty_unit": it.qty_unit,
        "unit_price": float(it.unit_price) if it.unit_price is not None else None,
        "currency": it.currency,
        "line_amount": float(it.line_amount) if it.line_amount is not None else None,
        "sort_order": it.sort_order,
    }


async def _get_quote_or_404(db, tenant_id, quote_id, auth) -> QuoteOrder:
    stmt = select(QuoteOrder).where(
        QuoteOrder.tenant_id == tenant_id, QuoteOrder.id == quote_id,
    )
    stmt = scope_filter(stmt, QuoteOrder, auth)
    q = (await db.execute(stmt)).scalar_one_or_none()
    if q is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "QUOTE_NOT_FOUND"})
    return q


def _parse_dt(value: Optional[str]):
    return datetime.fromisoformat(value) if value else None


# ── 端点 ─────────────────────────────────────────────────────────────────────

@router.get("/quotes")
async def list_quotes(
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(QuoteOrder).where(QuoteOrder.tenant_id == tenant_id)
    if status:
        validate_enum("quote_status", status)
        stmt = stmt.where(QuoteOrder.status == status)
    if customer_id:
        stmt = stmt.where(QuoteOrder.customer_id == customer_id)
    stmt = scope_filter(stmt, QuoteOrder, auth)
    total = (await db.execute(
        select(func.count()).select_from(stmt.subquery())
    )).scalar_one()
    stmt = stmt.order_by(QuoteOrder.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_quote(q) for q in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("/quotes", status_code=201)
async def create_quote(
    body: QuoteCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    currency = validate_enum("currency", body.currency) or "USD"
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"

    items = []
    total = Decimal("0")
    for i in body.items:
        line = i.line_amount
        if line is None and i.unit_price is not None:
            line = (i.qty * i.unit_price).quantize(Decimal("0.01"))
        items.append(QuoteOrderItem(
            tenant_id=tenant_id, sku_id=i.sku_id, product_name=i.product_name,
            spec_snapshot=i.spec_snapshot, qty=i.qty, qty_unit=i.qty_unit,
            unit_price=i.unit_price,
            currency=validate_enum("currency", i.currency) if i.currency else currency,
            line_amount=line, sort_order=i.sort_order,
        ))
        if line is not None:
            total += line

    # §10.2：报价生成时锁定汇率快照
    rate, rate_date = await lock_fx_rate(db, currency)

    q = QuoteOrder(
        tenant_id=tenant_id, quote_no=await next_doc_no(db, tenant_id, "quotation"),
        customer_id=body.customer_id, customer_name=body.customer_name,
        status="draft", currency=currency, total_amount=total or None,
        valid_until=_parse_dt(body.valid_until),
        notes=body.notes, fx_rate=rate, fx_rate_date=rate_date,
        created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
    )
    db.add(q)
    await db.flush()  # 取 q.id 挂行项
    for it in items:
        it.quote_order_id = q.id
        db.add(it)
    await db.commit()
    await db.refresh(q)
    return _row_to_quote(q)


@router.get("/quotes/{quote_id}")
async def get_quote(
    quote_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    q = await _get_quote_or_404(db, tenant_id, quote_id, auth)
    items = (await db.execute(
        select(QuoteOrderItem)
        .where(QuoteOrderItem.tenant_id == tenant_id, QuoteOrderItem.quote_order_id == q.id)
        .order_by(QuoteOrderItem.sort_order, QuoteOrderItem.id)
    )).scalars().all()
    return {**_row_to_quote(q), "items": [_row_to_item(i) for i in items]}


@router.patch("/quotes/{quote_id}")
async def update_quote(
    quote_id: int,
    body: QuotePatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    q = await _get_quote_or_404(db, tenant_id, quote_id, auth)
    check_write_access(q, auth)

    if body.status is not None:
        target = validate_enum("quote_status", body.status)
        allowed = ORDER_NEXT.get(q.status, ())
        if target != q.status and target not in allowed:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "field": "status", "from": q.status, "to": target, "allowed": list(allowed),
            })
        q.status = target

    if body.customer_name is not None:
        q.customer_name = body.customer_name
    if body.currency is not None:
        q.currency = validate_enum("currency", body.currency) or q.currency
    if body.valid_until is not None:
        q.valid_until = _parse_dt(body.valid_until)
    if body.notes is not None:
        q.notes = body.notes

    await db.commit()
    await db.refresh(q)  # UPDATE 后 server-onupdate 列需显式 refresh（MissingGreenlet 坑）
    return _row_to_quote(q)
