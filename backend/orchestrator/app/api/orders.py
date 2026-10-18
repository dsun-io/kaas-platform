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
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_links import (
    Order, OrderItem, QuoteOrder, QuoteOrderItem,
)
from app.db.workstation_models import PaymentSchedule, Receivable
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import (
    validate_enum, ORDER_STATUS, SCHEDULE_TYPE, SCHEDULE_STATUS, CURRENCY, OWNER_SCOPE,
)
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no,
    next_number_for_customer, lock_fx_rate, resolve_customer_for_doc,
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
    # 业务客户外键（整数）：必须从**已有业务客户**里选，后端强校验（2026-10-11）
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None
    currency: Optional[str] = None           # 未传时：报价转化继承报价币种，否则 USD
    order_date: Optional[str] = None
    delivery_date: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: str = "private"
    # 贸易条款（202609260001 新增正列）：报价转订单时未传则从报价单继承，
    # 后续单证要拿这些值印在发票/合同/提单上
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None
    items: List[OrderItemIn] = []


class OrderPatch(BaseModel):
    # 改单时也能换客户（历史单据被清洗成 NULL 后要能人工认领回来）
    customer_id: Optional[int] = None
    customer_name: Optional[str] = None
    delivery_date: Optional[str] = None
    notes: Optional[str] = None
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None


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
    from kaas_common.workstation.order_serializers import row_to_order
    return row_to_order(o)


def _row_to_item(it: OrderItem) -> dict:
    from kaas_common.workstation.order_serializers import row_to_order_item
    return row_to_order_item(it)


def _row_to_schedule(s: PaymentSchedule) -> dict:
    from kaas_common.workstation.order_serializers import row_to_schedule
    return row_to_schedule(s)


def _row_to_receivable(r: Receivable) -> dict:
    from kaas_common.workstation.order_serializers import row_to_receivable
    return row_to_receivable(r)


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
        team_id=o.team_id,
    )
    db.add(recv)
    await db.flush()
    return recv


# ── 订单 ─────────────────────────────────────────────────────────────────────

@router.get("/orders")
async def list_orders(
    status: Optional[str] = None,
    customer_id: Optional[int] = None,
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

    # 业务客户强校验：不存在 / 已软删 / 别家团队 → 404 CUSTOMER_NOT_FOUND。
    # **放在报价转化之后**：转化会从报价单继承 customer_id，继承来的 id 同样是
    # "落到本单据上的客户引用"，必须过同一道闸门（否则报价单里一个已软删的客户
    # 会顺着转化成一张挂着无效客户的订单）。
    customer = await resolve_customer_for_doc(db, tenant_id, customer_id, auth)

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

    # 贸易条款：本次传入优先，否则从报价单继承（报价谈定的条款不能丢，
    # 否则后面开单证时只能手工重填，极易与合同不一致）
    def _term(field: str):
        value = getattr(body, field, None)
        if value is None and quote is not None:
            value = getattr(quote, field, None)
        return value

    o = Order(
        tenant_id=tenant_id,
        order_no=await next_number_for_customer(
            db, tenant_id, "order", Order, Order.order_no, customer),
        customer_id=customer.id if customer is not None else None,
        # 客户名快照：未显式传时按客户档案自动填（开单当时的客户名）
        customer_name=customer_name or (customer.name if customer is not None else None),
        status="pending", currency=currency, total_amount=total or None,
        order_date=_parse_dt(body.order_date),
        delivery_date=_parse_dt(body.delivery_date),
        notes=body.notes, created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        # 单据与客户同团队（管理员替别家团队开单时不能把单据留在自己团队）
        team_id=customer.team_id if customer is not None else auth.team_id,
        incoterm=_term("incoterm"), payment_terms=_term("payment_terms"),
        port_of_loading=_term("port_of_loading"),
        port_of_destination=_term("port_of_destination"),
        shipping_marks=_term("shipping_marks"),
        country_of_origin=_term("country_of_origin"),
    )
    db.add(o)
    await db.flush()
    for it in items:
        it.order_id = o.id
        db.add(it)

    if quote is not None:
        # 报价来源关系**不再写 `order_quote_refs`**（该表已随 202610110014 改名 `_legacy` 留档）：
        # 归属列的触发器（`trg_orders_links`）会从 `orders.quote_id` 自动派生 `entity_links` 边，
        # 任何写入路径都绕不过 —— 这里再手写一份就是"两套真相"。
        # 守 `ck_orders_has_customer`：customer_id 为空的历史形态下不写列（约束会拒绝该行更新）。
        if o.customer_id is not None:
            o.quote_id = quote.id
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
    # 报价来源：读**边表 `entity_links`**（旧 `order_quote_refs` 已改名留档、不再读）。
    # 边表由 `trg_orders_links` 从 `orders.quote_id` 自动派生，所以这里同时覆盖了
    # 列的当前值（触发器 INSERT）与"原本由报价 A、后改 B"的变更史（旧边 `deleted_at` 非空）；
    # 取有效边 => 与旧表 `SELECT ... WHERE order_id=?` 的结果一致（旧表也是每单一行有效关系）。
    quote_links = (await db.execute(
        text(
            "SELECT dst_id AS quote_order_id, rel_type"
            "  FROM entity_links"
            " WHERE tenant_id = :tenant_id AND src_type = 'order' AND src_id = :order_id"
            "   AND dst_type = 'quote' AND deleted_at IS NULL"
            " ORDER BY id"
        ),
        {"tenant_id": tenant_id, "order_id": o.id},
    )).mappings().all()
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
        "quote_refs": [{"quote_order_id": r["quote_order_id"], "ref_type": r["rel_type"]}
                       for r in quote_links],
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
    if body.customer_id is not None:
        # 换客户：同样走强校验；快照与团队一并跟着客户走
        customer = await resolve_customer_for_doc(db, tenant_id, body.customer_id, auth)
        o.customer_id = customer.id
        o.team_id = customer.team_id
        if body.customer_name is None:
            o.customer_name = customer.name
    if body.customer_name is not None:
        o.customer_name = body.customer_name
    if body.delivery_date is not None:
        o.delivery_date = _parse_dt(body.delivery_date)
    if body.notes is not None:
        o.notes = body.notes
    for field in ("incoterm", "payment_terms", "port_of_loading",
                  "port_of_destination", "shipping_marks", "country_of_origin"):
        value = getattr(body, field, None)
        if value is not None:
            setattr(o, field, value)
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
        team_id=o.team_id,
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

