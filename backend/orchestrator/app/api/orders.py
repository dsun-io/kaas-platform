"""订单工位 API（WORKSTATION_DESIGN.md §5-§6 / §10.2 / §10.5 / §10.7）

端点：
- GET   /api/v1/orders                          订单列表（分页 + 筛选 + 可见范围）
- POST  /api/v1/orders                          新建订单（可带 quote_order_id 由报价转化）
- GET   /api/v1/orders/{id}                     订单详情（行项 + 报价来源 + 付款计划 + 应收）
- PATCH /api/v1/orders/{id}                     更新字段
- POST  /api/v1/orders/{id}/status              状态流转
- GET/POST   /api/v1/orders/{id}/payment-schedules   付款计划
- PATCH      /api/v1/payment-schedules/{id}     更新 / 标记收款（联动应收 + 汇兑损益）
- GET        /api/v1/receivables                应收台账列表

订单状态机（§10.4）：
    pending → confirmed → producing → shipped → completed
       ↓           ↓
    cancelled   cancelled
确认时（pending→confirmed）按 §10.2 重新锁定汇率（不用报价时旧汇率）并创建应收台账。
"""
from typing import List, Optional
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func

from app.db.session import get_db_session
from app.db.workstation_links import (
    Order, OrderItem, OrderQuoteRef, QuoteOrder, QuoteOrderItem,
)
from app.db.workstation_models import PaymentSchedule, Receivable
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import (
    validate_enum, ORDER_STATUS, SCHEDULE_TYPE, SCHEDULE_STATUS, CURRENCY, OWNER_SCOPE,
)
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no, lock_fx_rate,
)

router = APIRouter(prefix="/api/v1", tags=["orders"])

ORDER_NEXT = {
    "pending": ("confirmed", "cancelled"),
    "confirmed": ("producing", "cancelled"),
    "producing": ("shipped",),
    "shipped": ("completed",),
}


# ── Schemas ──────────────────────────────────────────────────────────────────

class OrderItemIn(BaseModel):
    sku_id: Optional[int] = None
    product_name: Optional[str] = None
    spec_snapshot: Optional[dict] = None
    qty: Decimal = Decimal("1")
    qty_unit: Optional[str] = None
    unit_price: Optional[Decimal] = None
    currency: Optional[str] = None
    line_amount: Optional[Decimal] = None
    sort_order: int = 0


class OrderCreate(BaseModel):
    quote_order_id: Optional[int] = None     # 由报价转化（converted_from）
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    currency: Optional[str] = None           # 未传时：报价转化继承报价币种，否则 USD
    order_date: Optional[str] = None
    delivery_date: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: str = "private"
    items: List[OrderItemIn] = []


class OrderPatch(BaseModel):
    customer_name: Optional[str] = None
    delivery_date: Optional[str] = None
    notes: Optional[str] = None


class StatusChange(BaseModel):
    status: str


class ScheduleCreate(BaseModel):
    schedule_type: str                       # deposit | balance | full
    ratio: Optional[Decimal] = None          # 与 amount 二选一
    amount: Optional[Decimal] = None
    currency: Optional[str] = None
    due_date: Optional[str] = None
    notes: Optional[str] = None


class SchedulePatch(BaseModel):
    amount: Optional[Decimal] = None
    due_date: Optional[str] = None
    status: Optional[str] = None             # 标记 paid 时联动应收
    actual_date: Optional[str] = None
    fx_rate: Optional[Decimal] = None        # 实际收汇汇率
    notes: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_dt(value: Optional[str]):
    return datetime.fromisoformat(value) if value else None


def _parse_date(value: Optional[str]):
    from datetime import date
    return date.fromisoformat(value) if value else None


def _row_to_order(o: Order) -> dict:
    return {
        "id": o.id, "order_no": o.order_no, "customer_id": o.customer_id,
        "customer_name": o.customer_name, "status": o.status, "currency": o.currency,
        "total_amount": float(o.total_amount) if o.total_amount is not None else None,
        "order_date": o.order_date.isoformat() if o.order_date else None,
        "delivery_date": o.delivery_date.isoformat() if o.delivery_date else None,
        "notes": o.notes,
        "fx_rate": float(o.fx_rate) if o.fx_rate is not None else None,
        "fx_rate_date": o.fx_rate_date.isoformat() if o.fx_rate_date else None,
        "created_at": o.created_at.isoformat() if o.created_at else None,
        "owner_id": o.owner_id, "owner_scope": o.owner_scope,
    }


def _row_to_item(it: OrderItem) -> dict:
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


def _row_to_schedule(s: PaymentSchedule) -> dict:
    return {
        "id": s.id, "order_id": s.order_id, "trade_doc_id": s.trade_doc_id,
        "schedule_type": s.schedule_type,
        "ratio": float(s.ratio) if s.ratio is not None else None,
        "amount": float(s.amount) if s.amount is not None else None,
        "currency": s.currency, "due_date": s.due_date.isoformat() if s.due_date else None,
        "actual_date": s.actual_date.isoformat() if s.actual_date else None,
        "status": s.status,
        "fx_rate": float(s.fx_rate) if s.fx_rate is not None else None,
        "exchange_gain_loss": float(s.exchange_gain_loss) if s.exchange_gain_loss is not None else None,
        "notes": s.notes,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _row_to_receivable(r: Receivable) -> dict:
    return {
        "id": r.id, "order_id": r.order_id, "currency": r.currency,
        "total_amount": float(r.total_amount),
        "fx_rate": float(r.fx_rate) if r.fx_rate is not None else None,
        "fx_rate_date": r.fx_rate_date.isoformat() if r.fx_rate_date else None,
        "base_currency": r.base_currency,
        "base_amount": float(r.base_amount) if r.base_amount is not None else None,
        "received_amount": float(r.received_amount),
        "exchange_gain_loss": float(r.exchange_gain_loss) if r.exchange_gain_loss is not None else None,
        "status": r.status,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


async def _get_order_or_404(db, tenant_id, order_id, auth) -> Order:
    stmt = select(Order).where(
        Order.tenant_id == tenant_id, Order.id == order_id,
    )
    stmt = scope_filter(stmt, Order, auth)
    o = (await db.execute(stmt)).scalar_one_or_none()
    if o is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "ORDER_NOT_FOUND"})
    return o


async def _create_receivable_for_order(db, o: Order):
    """§10.2 确认时建应收：原币应收 + 锁定汇率折算本币。幂等（tenant+order 唯一）。"""
    existing = (await db.execute(
        select(Receivable).where(
            Receivable.tenant_id == o.tenant_id, Receivable.order_id == o.id,
        )
    )).scalar_one_or_none()
    if existing is not None:
        return existing
    total = o.total_amount or Decimal("0")
    rate = o.fx_rate
    rate_date = o.fx_rate_date
    base_amount = None
    if rate is not None:
        base_amount = (total * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    recv = Receivable(
        tenant_id=o.tenant_id, order_id=o.id, currency=o.currency,
        total_amount=total, fx_rate=rate, fx_rate_date=rate_date,
        base_amount=base_amount, owner_id=o.owner_id, owner_scope=o.owner_scope,
    )
    db.add(recv)
    await db.flush()
    return recv


# ── 订单 ─────────────────────────────────────────────────────────────────────

@router.get("/orders")
async def list_orders(
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(Order).where(Order.tenant_id == tenant_id)
    if status:
        validate_enum("order_status", status)
        stmt = stmt.where(Order.status == status)
    if customer_id:
        stmt = stmt.where(Order.customer_id == customer_id)
    stmt = scope_filter(stmt, Order, auth)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(Order.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_order(o) for o in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("/orders", status_code=201)
async def create_order(
    body: OrderCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    currency = (validate_enum("currency", body.currency) if body.currency else None) or "USD"
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"

    customer_id, customer_name = body.customer_id, body.customer_name
    item_ins: List[OrderItemIn] = list(body.items)
    quote: Optional[QuoteOrder] = None

    if body.quote_order_id is not None:
        # 报价转化：复制头信息 + 行项（客户未覆盖时），建 converted_from 关联
        stmt = select(QuoteOrder).where(
            QuoteOrder.tenant_id == tenant_id, QuoteOrder.id == body.quote_order_id,
        )
        stmt = scope_filter(stmt, QuoteOrder, auth)
        quote = (await db.execute(stmt)).scalar_one_or_none()
        if quote is None:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "QUOTE_NOT_FOUND"})
        if quote.status in ("rejected", "expired", "cancelled"):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "QUOTE_NOT_CONVERTIBLE",
                "detail": f"报价单状态 {quote.status} 不可转化",
            })
        customer_id = customer_id or quote.customer_id
        customer_name = customer_name or quote.customer_name
        if body.currency is None:
            currency = quote.currency
        if not item_ins:
            q_items = (await db.execute(
                select(QuoteOrderItem).where(
                    QuoteOrderItem.tenant_id == tenant_id,
                    QuoteOrderItem.quote_order_id == quote.id,
                ).order_by(QuoteOrderItem.sort_order, QuoteOrderItem.id)
            )).scalars().all()
            item_ins = [OrderItemIn(
                sku_id=i.sku_id, product_name=i.product_name,
                spec_snapshot=i.spec_snapshot, qty=i.qty, qty_unit=i.qty_unit,
                unit_price=i.unit_price, currency=i.currency,
                line_amount=i.line_amount, sort_order=i.sort_order,
            ) for i in q_items]

    items, total = [], Decimal("0")
    for i in item_ins:
        line = i.line_amount
        if line is None and i.unit_price is not None:
            line = (i.qty * i.unit_price).quantize(Decimal("0.01"))
        items.append(OrderItem(
            tenant_id=tenant_id, sku_id=i.sku_id, product_name=i.product_name,
            spec_snapshot=i.spec_snapshot, qty=i.qty, qty_unit=i.qty_unit,
            unit_price=i.unit_price,
            currency=validate_enum("currency", i.currency) if i.currency else currency,
            line_amount=line, sort_order=i.sort_order,
        ))
        if line is not None:
            total += line

    o = Order(
        tenant_id=tenant_id, order_no=await next_doc_no(db, tenant_id, "order"),
        customer_id=customer_id, customer_name=customer_name,
        status="pending", currency=currency, total_amount=total or None,
        order_date=_parse_dt(body.order_date),
        delivery_date=_parse_dt(body.delivery_date),
        notes=body.notes, created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
    )
    db.add(o)
    await db.flush()
    for it in items:
        it.order_id = o.id
        db.add(it)

    if quote is not None:
        db.add(OrderQuoteRef(
            tenant_id=tenant_id, order_id=o.id, quote_order_id=quote.id,
            ref_type="converted_from",
        ))
        quote.status = "accepted"  # 转化即视为接单

    await db.commit()
    await db.refresh(o)
    return _row_to_order(o)


@router.get("/orders/{order_id}")
async def get_order(
    order_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    o = await _get_order_or_404(db, tenant_id, order_id, auth)
    items = (await db.execute(
        select(OrderItem).where(
            OrderItem.tenant_id == tenant_id, OrderItem.order_id == o.id,
        ).order_by(OrderItem.sort_order, OrderItem.id)
    )).scalars().all()
    refs = (await db.execute(
        select(OrderQuoteRef).where(
            OrderQuoteRef.tenant_id == tenant_id, OrderQuoteRef.order_id == o.id,
        )
    )).scalars().all()
    schedules = (await db.execute(
        select(PaymentSchedule).where(
            PaymentSchedule.tenant_id == tenant_id, PaymentSchedule.order_id == o.id,
        ).order_by(PaymentSchedule.due_date, PaymentSchedule.id)
    )).scalars().all()
    recv = (await db.execute(
        select(Receivable).where(
            Receivable.tenant_id == tenant_id, Receivable.order_id == o.id,
        )
    )).scalar_one_or_none()
    return {
        **_row_to_order(o),
        "items": [_row_to_item(i) for i in items],
        "quote_refs": [{"quote_order_id": r.quote_order_id, "ref_type": r.ref_type} for r in refs],
        "payment_schedules": [_row_to_schedule(s) for s in schedules],
        "receivable": _row_to_receivable(recv) if recv else None,
    }


@router.patch("/orders/{order_id}")
async def update_order(
    order_id: int,
    body: OrderPatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    o = await _get_order_or_404(db, tenant_id, order_id, auth)
    check_write_access(o, auth)
    if body.customer_name is not None:
        o.customer_name = body.customer_name
    if body.delivery_date is not None:
        o.delivery_date = _parse_dt(body.delivery_date)
    if body.notes is not None:
        o.notes = body.notes
    await db.commit()
    await db.refresh(o)
    return _row_to_order(o)


@router.post("/orders/{order_id}/status")
async def change_order_status(
    order_id: int,
    body: StatusChange,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    o = await _get_order_or_404(db, tenant_id, order_id, auth)
    check_write_access(o, auth)
    target = validate_enum("order_status", body.status)
    allowed = ORDER_NEXT.get(o.status, ())
    if target != o.status and target not in allowed:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "ILLEGAL_TRANSITION",
            "field": "status", "from": o.status, "to": target, "allowed": list(allowed),
        })

    if target == "confirmed" and o.status == "pending":
        # §10.2 确认时重新锁定汇率（不用报价时旧汇率）+ 建应收
        rate, rate_date = await lock_fx_rate(db, o.currency)
        o.fx_rate = rate
        o.fx_rate_date = rate_date
        await _create_receivable_for_order(db, o)

    o.status = target
    await db.commit()
    await db.refresh(o)
    return _row_to_order(o)


# ── 付款计划 ─────────────────────────────────────────────────────────────────

@router.get("/orders/{order_id}/payment-schedules")
async def list_schedules(
    order_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    await _get_order_or_404(db, tenant_id, order_id, auth)
    rows = (await db.execute(
        select(PaymentSchedule).where(
            PaymentSchedule.tenant_id == tenant_id, PaymentSchedule.order_id == order_id,
        ).order_by(PaymentSchedule.due_date, PaymentSchedule.id)
    )).scalars().all()
    return {"items": [_row_to_schedule(s) for s in rows], "total": len(rows)}


@router.post("/orders/{order_id}/payment-schedules", status_code=201)
async def create_schedule(
    order_id: int,
    body: ScheduleCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    o = await _get_order_or_404(db, tenant_id, order_id, auth)
    check_write_access(o, auth)
    stype = validate_enum("schedule_type", body.schedule_type)
    currency = (validate_enum("currency", body.currency) if body.currency else None) or o.currency

    amount = body.amount
    if amount is None and body.ratio is not None and o.total_amount is not None:
        amount = (o.total_amount * body.ratio).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

    s = PaymentSchedule(
        tenant_id=tenant_id, order_id=order_id, schedule_type=stype,
        ratio=body.ratio, amount=amount, currency=currency,
        due_date=_parse_date(body.due_date), notes=body.notes,
        owner_id=str(auth.user_id), owner_scope=o.owner_scope,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _row_to_schedule(s)


@router.patch("/payment-schedules/{schedule_id}")
async def update_schedule(
    schedule_id: int,
    body: SchedulePatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    s = (await db.execute(
        select(PaymentSchedule).where(
            PaymentSchedule.tenant_id == tenant_id, PaymentSchedule.id == schedule_id,
        )
    )).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "SCHEDULE_NOT_FOUND"})
    o = await _get_order_or_404(db, tenant_id, s.order_id, auth)
    check_write_access(o, auth)

    if body.amount is not None:
        s.amount = body.amount
    if body.due_date is not None:
        s.due_date = _parse_date(body.due_date)
    if body.notes is not None:
        s.notes = body.notes

    if body.status is not None:
        target = validate_enum("schedule_status", body.status)
        if target == "paid" and s.status != "paid":
            # 标记收款：记实际收汇汇率，按 §10.2 口径算汇兑损益，联动应收台账
            s.actual_date = _parse_date(body.actual_date) or s.actual_date
            s.fx_rate = body.fx_rate
            if s.amount is not None and body.fx_rate is not None:
                recv = (await db.execute(
                    select(Receivable).where(
                        Receivable.tenant_id == tenant_id, Receivable.order_id == s.order_id,
                    )
                )).scalar_one_or_none()
                lock_rate = (recv.fx_rate if recv is not None else None) or o.fx_rate
                if lock_rate is not None:
                    gl = (s.amount * (body.fx_rate - lock_rate)).quantize(
                        Decimal("0.01"), rounding=ROUND_HALF_UP)
                    s.exchange_gain_loss = gl
                    if recv is not None:
                        recv.exchange_gain_loss = (recv.exchange_gain_loss or Decimal("0")) + gl
            s.status = "paid"
            # 应收台账回写：已收金额累计 + 状态推导
            recv = (await db.execute(
                select(Receivable).where(
                    Receivable.tenant_id == tenant_id, Receivable.order_id == s.order_id,
                )
            )).scalar_one_or_none()
            if recv is not None and s.amount is not None:
                recv.received_amount = recv.received_amount + s.amount
                recv.status = ("paid" if recv.received_amount >= recv.total_amount
                               else "partial")
        elif target == "pending" and s.status == "paid":
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "detail": "已收款不可回退为 pending",
            })
        else:
            s.status = target

    await db.commit()
    await db.refresh(s)
    return _row_to_schedule(s)


# ── 应收台账 ─────────────────────────────────────────────────────────────────

@router.get("/receivables")
async def list_receivables(
    status: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(Receivable, Order.order_no, Order.customer_name).join(
        Order, Receivable.order_id == Order.id, isouter=True,
    ).where(Receivable.tenant_id == tenant_id)
    if status:
        validate_enum("receivable_status", status)
        stmt = stmt.where(Receivable.status == status)
    stmt = scope_filter(stmt, Receivable, auth)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(Receivable.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).all()
    items = []
    for r, order_no, customer_name in rows:
        items.append({**_row_to_receivable(r), "order_no": order_no, "customer_name": customer_name})
    return {"items": items, "total": total, "page": page, "page_size": page_size}
