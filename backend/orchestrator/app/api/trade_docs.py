"""外贸单证工位 API（WORKSTATION_DESIGN.md §6.3 / §10.7）

单证从上游实体生成（询盘 / 报价单 / 订单任一类），通过 refs 关联表溯源：
- trade_doc_inquiry_refs / trade_doc_quote_refs / trade_doc_order_refs

端点：
- GET   /api/v1/trade-docs            单证列表（分页 + doc_type/status/order 筛选）
- POST  /api/v1/trade-docs            生成单证（doc_sequences 取号 + 上游快照入 raw_payload）
- GET   /api/v1/trade-docs/{id}       单证详情（含全部上游 refs）
- PATCH /api/v1/trade-docs/{id}       更新（draft 可改 payload）/ 状态流转（draft→issued→void）
"""
from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Customer
from app.db.workstation_links import (
    Order, OrderItem, QuoteOrder, QuoteOrderItem,
    TradeDoc, TradeDocItem, TradeDocOrderRef,
)
from app.db.workstation_models import (
    CustInquiry, CustContact, TenantCompanyProfile,
    TradeDocQuoteRef, TradeDocInquiryRef, TradeDocDocRef,
)
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, DOC_TYPE, CURRENCY, DOC_STATUS
from app.api.ws_common import tenant_id_of, scope_filter, next_doc_no
from app.api.company_profile import seller_block
from app.services.trade_doc_payload import (
    build_render_data, buyer_block, trade_terms_of,
)
from kaas_common.trade_doc import (
    RuleError, assert_draft, assert_derivable, assert_transition, validate_confirm,
    normalize_items, derive_payload, freeze_snapshot,
)

router = APIRouter(prefix="/api/v1", tags=["trade-docs"])

# 状态机判定已单写进共享内核（kaas_common.trade_doc.rules），此处不重复定义。


# ── Schemas ──────────────────────────────────────────────────────────────────

class TradeDocItemIn(BaseModel):
    """行项目（手动开单 / 派生带入）：含产品段、方案价、来源。"""
    product_name: str
    spec_snapshot: Optional[dict] = None
    qty: Optional[float] = 1
    qty_unit: Optional[str] = None
    unit_price: Optional[float] = None
    currency: Optional[str] = None
    line_amount: Optional[float] = None
    group_no: int = 0
    scheme_prices: Optional[dict] = None   # {方案名: {qty?, unit_price, line_amount}}
    source: str = "manual"                 # manual | generated


class TradeDocCreate(BaseModel):
    doc_type: str                            # §10.4 DOC_TYPE
    # 来源：上游(order/quote/inquiry) / 派生(derive_from_doc_id) / 纯手动（都为空）
    order_id: Optional[int] = None
    quote_order_id: Optional[int] = None
    inquiry_id: Optional[int] = None
    derive_from_doc_id: Optional[int] = None   # 派生建单（仅 issued 源）
    apply_scheme: Optional[str] = None         # 派生自 QUO 时：直接应用该方案 qty/单价
    customer_id: Optional[str] = None
    currency: Optional[str] = None
    items: Optional[list[TradeDocItemIn]] = None   # 手动/派生行项目
    raw_payload: Optional[dict] = None       # 手动补充内容（draft 可改）


class TradeDocPatch(BaseModel):
    status: Optional[str] = None
    raw_payload: Optional[dict] = None


class TradeDocConfirmIn(BaseModel):
    """确认（issued）：校验必填 → 冻结；确认后不可修改。"""
    pass


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_doc(d: TradeDoc) -> dict:
    return {
        "id": d.id, "doc_no": d.doc_no, "doc_type": d.doc_type,
        "order_id": d.order_id, "customer_id": d.customer_id,
        "status": d.status, "currency": d.currency,
        "total_amount": float(d.total_amount) if d.total_amount is not None else None,
        "issued_at": d.issued_at.isoformat() if d.issued_at else None,
        "issued_by": d.issued_by,
        "raw_payload": d.raw_payload,
        "created_at": d.created_at.isoformat() if d.created_at else None,
    }


async def _order_snapshot(db, tenant_id, order_id) -> dict:
    o = (await db.execute(
        select(Order).where(Order.tenant_id == tenant_id, Order.id == order_id)
    )).scalar_one_or_none()
    if o is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "ORDER_NOT_FOUND"})
    items = (await db.execute(
        select(OrderItem).where(
            OrderItem.tenant_id == tenant_id, OrderItem.order_id == o.id,
        ).order_by(OrderItem.sort_order, OrderItem.id)
    )).scalars().all()
    return {
        "order_no": o.order_no, "customer_id": o.customer_id,
        "customer_name": o.customer_name, "status": o.status, "currency": o.currency,
        "total_amount": float(o.total_amount) if o.total_amount is not None else None,
        "fx_rate": float(o.fx_rate) if o.fx_rate is not None else None,
        # 贸易条款冻进快照：单据上的条款必须等于开单当时的条款，
        # 而不是"现在去订单表读"（订单改了会污染历史单据）
        "incoterm": o.incoterm, "payment_terms": o.payment_terms,
        "port_of_loading": o.port_of_loading,
        "port_of_destination": o.port_of_destination,
        "shipping_marks": o.shipping_marks,
        "country_of_origin": o.country_of_origin,
        "items": [{
            "product_name": i.product_name, "qty": float(i.qty) if i.qty is not None else None,
            "qty_unit": i.qty_unit,
            "unit_price": float(i.unit_price) if i.unit_price is not None else None,
            "line_amount": float(i.line_amount) if i.line_amount is not None else None,
            # 规格快照必须带：报关/装箱的核心列（规格、HS Code、毛净重）都在里面
            "spec_snapshot": i.spec_snapshot,
        } for i in items],
    }


async def _quote_snapshot(db, tenant_id, quote_id) -> dict:
    q = (await db.execute(
        select(QuoteOrder).where(QuoteOrder.tenant_id == tenant_id, QuoteOrder.id == quote_id)
    )).scalar_one_or_none()
    if q is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "QUOTE_NOT_FOUND"})
    items = (await db.execute(
        select(QuoteOrderItem).where(
            QuoteOrderItem.tenant_id == tenant_id, QuoteOrderItem.quote_order_id == q.id,
        ).order_by(QuoteOrderItem.sort_order, QuoteOrderItem.id)
    )).scalars().all()
    return {
        "quote_no": q.quote_no, "customer_id": q.customer_id,
        "customer_name": q.customer_name, "status": q.status, "currency": q.currency,
        "total_amount": float(q.total_amount) if q.total_amount is not None else None,
        "incoterm": q.incoterm, "payment_terms": q.payment_terms,
        "port_of_loading": q.port_of_loading,
        "port_of_destination": q.port_of_destination,
        "shipping_marks": q.shipping_marks,
        "country_of_origin": q.country_of_origin,
        "items": [{
            "product_name": i.product_name, "qty": float(i.qty) if i.qty is not None else None,
            "qty_unit": i.qty_unit,
            "unit_price": float(i.unit_price) if i.unit_price is not None else None,
            "line_amount": float(i.line_amount) if i.line_amount is not None else None,
            "spec_snapshot": i.spec_snapshot,
        } for i in items],
    }


async def _inquiry_snapshot(db, tenant_id, inquiry_id) -> dict:
    i = (await db.execute(
        select(CustInquiry).where(CustInquiry.tenant_id == tenant_id, CustInquiry.id == inquiry_id)
    )).scalar_one_or_none()
    if i is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "INQUIRY_NOT_FOUND"})
    return {
        "inquiry_id": i.id, "customer_id": i.customer_id, "status": i.status,
        "channel": i.channel, "product_name_raw": i.product_name_raw,
        "quantity": float(i.quantity) if i.quantity is not None else None,
        "quantity_unit": i.quantity_unit, "application": i.application,
    }


# ── 端点 ─────────────────────────────────────────────────────────────────────

@router.get("/trade-docs")
async def list_trade_docs(
    doc_type: Optional[str] = None,
    status: Optional[str] = None,
    order_id: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(TradeDoc).where(TradeDoc.tenant_id == tenant_id)
    if doc_type:
        validate_enum("doc_type", doc_type)
        stmt = stmt.where(TradeDoc.doc_type == doc_type)
    if status:
        validate_enum("doc_status", status)
        stmt = stmt.where(TradeDoc.status == status)
    if order_id:
        stmt = stmt.where(TradeDoc.order_id == order_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(TradeDoc.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_doc(d) for d in rows],
            "total": total, "page": page, "page_size": page_size}


async def _persist_items(db, tenant_id, doc_id, items, currency, doc_type, apply_scheme_key=None):
    """行项目落库（normalize_items 做金额勾稽与规范化，来自内核）。"""
    from decimal import Decimal
    from kaas_common.trade_doc import apply_scheme as kernel_apply_scheme

    raw = [i.model_dump() for i in (items or [])]
    if raw and apply_scheme_key is not None:
        raw = kernel_apply_scheme(raw, apply_scheme_key)
    try:
        rows = normalize_items(raw)   # 金额勾稽 + 规范化（内核）
    except RuleError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail})
    total = Decimal(0)
    for row in rows:
        db.add(TradeDocItem(
            tenant_id=tenant_id, trade_doc_id=doc_id,
            product_name=row.get("product_name"),
            spec_snapshot=row.get("spec_snapshot"),
            qty=Decimal(str(row.get("qty") or 0)),
            qty_unit=row.get("qty_unit"),
            unit_price=(Decimal(str(row["unit_price"])) if row.get("unit_price") is not None else None),
            currency=row.get("currency") or currency,
            line_amount=(Decimal(str(row["line_amount"])) if row.get("line_amount") is not None else None),
            group_no=row.get("group_no") or 0,
            scheme_prices=row.get("scheme_prices"),
            source=row.get("source") or "manual",
            sort_order=row.get("_sort") or 0,
        ))
        if row.get("line_amount") is not None:
            total += Decimal(str(row["line_amount"]))
    return total if rows else None


@router.post("/trade-docs", status_code=201)
async def create_trade_doc(
    body: TradeDocCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    doc_type = validate_enum("doc_type", body.doc_type)
    currency = (validate_enum("currency", body.currency) if body.currency else None) or "USD"

    has_upstream = any([body.order_id, body.quote_order_id, body.inquiry_id])
    if not has_upstream and not body.derive_from_doc_id and not body.items:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "SOURCE_REQUIRED",
            "detail": "开单需提供 items（手动）、derive_from_doc_id（派生）"
                      "或上游来源（order/quote/inquiry）之一",
        })

    payload = {"sources": {}, "custom": dict(body.raw_payload or {})}
    total_amount = None
    order_id = body.order_id
    derive_doc = None

    # ── 派生建单：仅 issued 源（内核硬闸门）────────────────────────────
    if body.derive_from_doc_id:
        derive_doc = (await db.execute(
            select(TradeDoc).where(
                TradeDoc.tenant_id == tenant_id,
                TradeDoc.id == body.derive_from_doc_id,
            )
        )).scalar_one_or_none()
        if derive_doc is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "SOURCE_DOC_NOT_FOUND"})
        try:
            assert_derivable(derive_doc.status, derive_doc.doc_no)
        except RuleError as exc:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": exc.code, "detail": exc.detail})
        payload = derive_payload(
            derive_doc.raw_payload or {}, source_kind=derive_doc.doc_type,
            doc_type=doc_type, manual=body.raw_payload or {},
        )
        if body.customer_id is None:
            body.customer_id = derive_doc.customer_id

    # ── 上游快照（生成时冻结，防关联变更导致历史失真）──────────────────
    if body.order_id:
        snap = await _order_snapshot(db, tenant_id, body.order_id)
        payload["sources"]["order"] = freeze_snapshot(snap)
        total_amount = snap["total_amount"]
        if body.customer_id is None:
            body.customer_id = snap["customer_id"]
    if body.quote_order_id:
        snap = await _quote_snapshot(db, tenant_id, body.quote_order_id)
        payload["sources"]["quote"] = freeze_snapshot(snap)
        if total_amount is None:
            total_amount = snap["total_amount"]
        if body.customer_id is None:
            body.customer_id = snap["customer_id"]
    if body.inquiry_id:
        snap = await _inquiry_snapshot(db, tenant_id, body.inquiry_id)
        payload["sources"]["inquiry"] = freeze_snapshot(snap)

    d = TradeDoc(
        tenant_id=tenant_id, doc_no=await next_doc_no(db, tenant_id, doc_type),
        doc_type=doc_type, order_id=order_id, customer_id=body.customer_id,
        status="draft", currency=currency, total_amount=total_amount,
        raw_payload=payload,
    )
    db.add(d)
    await db.flush()

    # ── 行项目：手动 items / 派生源行项目（apply_scheme 物化）───────────
    items = body.items
    if items is None and derive_doc is not None:
        src_rows = (await db.execute(
            select(TradeDocItem).where(
                TradeDocItem.tenant_id == tenant_id,
                TradeDocItem.trade_doc_id == derive_doc.id,
            ).order_by(TradeDocItem.sort_order, TradeDocItem.id)
        )).scalars().all()
        items = [TradeDocItemIn(
            product_name=r.product_name, spec_snapshot=r.spec_snapshot,
            qty=float(r.qty) if r.qty is not None else None, qty_unit=r.qty_unit,
            unit_price=float(r.unit_price) if r.unit_price is not None else None,
            currency=r.currency,
            line_amount=float(r.line_amount) if r.line_amount is not None else None,
            group_no=r.group_no or 0, scheme_prices=r.scheme_prices, source=r.source,
        ) for r in src_rows]
    if items:
        items_total = await _persist_items(
            db, tenant_id, d.id, items, currency, doc_type,
            apply_scheme_key=body.apply_scheme,
        )
        if total_amount is None:
            total_amount = items_total
            d.total_amount = total_amount
        # ── 金额勾稽：单证合计必须等于行项目合计（信用证不符点防线）──
        elif items_total is not None and abs(Decimal(str(total_amount)) - items_total) > Decimal("0.01"):
            raise HTTPException(status_code=422, detail={
                "error": "amount_mismatch", "code": "AMOUNT_MISMATCH",
                "detail": f"单证合计 {total_amount} ≠ 行项目合计 {items_total}；"
                          "信用证下这是致命不符点，请核对后重试",
            })

    # ── refs 溯源（§6.3 单证类型×生成阶段）───────────────────────────
    if body.order_id:
        db.add(TradeDocOrderRef(
            tenant_id=tenant_id, trade_doc_id=d.id, order_id=body.order_id,
            ref_type="generated_from",
        ))
    if body.quote_order_id:
        db.add(TradeDocQuoteRef(
            tenant_id=tenant_id, trade_doc_id=d.id, quote_order_id=body.quote_order_id,
            ref_type="generated_from",
        ))
    if body.inquiry_id:
        db.add(TradeDocInquiryRef(
            tenant_id=tenant_id, trade_doc_id=d.id, inquiry_id=body.inquiry_id,
            ref_type="generated_from",
        ))
    if derive_doc is not None:
        db.add(TradeDocDocRef(
            tenant_id=tenant_id, trade_doc_id=d.id,
            source_trade_doc_id=derive_doc.id, ref_type="derived_from",
        ))

    await db.commit()
    await db.refresh(d)
    return _row_to_doc(d)


@router.post("/trade-docs/{doc_id}/confirm", status_code=200)
async def confirm_trade_doc(
    doc_id: int,
    body: TradeDocConfirmIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """明确确认环节：校验必填 → issued → 锁死（确认后 PATCH 拒绝）。"""
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})

    rows = (await db.execute(
        select(TradeDocItem).where(
            TradeDocItem.tenant_id == tenant_id, TradeDocItem.trade_doc_id == d.id
        ).order_by(TradeDocItem.sort_order, TradeDocItem.id)
    )).scalars().all()
    items = [{
        "product_name": r.product_name, "qty": r.qty, "unit_price": r.unit_price,
        "line_amount": r.line_amount,
    } for r in rows]

    try:
        assert_draft(d.status)          # 仅 draft 可确认；重复确认/已锁 → 409
        assert_transition(d.status, "issued")
        # customer_id 在 trade_docs 列上，校验时并入 payload（买方识别）
        check_payload = {**(d.raw_payload or {}), "customer_id": d.customer_id}
        result = validate_confirm(d.doc_type, check_payload, items)
    except RuleError as exc:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": exc.code, "detail": exc.detail})
    if not result.ok:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CONFIRM_INVALID",
            "detail": "；".join(result.issues), "issues": result.issues,
        })

    from datetime import datetime, timezone
    d.status = "issued"
    d.issued_at = datetime.now(timezone.utc)
    d.issued_by = str(auth.user_id)
    await db.commit()
    await db.refresh(d)
    return _row_to_doc(d)


@router.get("/trade-docs/{doc_id}")
async def get_trade_doc(
    doc_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    refs = {"orders": [], "quotes": [], "inquiries": [], "docs": []}
    rows = (await db.execute(
        select(TradeDocOrderRef).where(
            TradeDocOrderRef.tenant_id == tenant_id, TradeDocOrderRef.trade_doc_id == d.id)
    )).scalars().all()
    refs["orders"] = [{"order_id": r.order_id, "ref_type": r.ref_type} for r in rows]
    rows = (await db.execute(
        select(TradeDocQuoteRef).where(
            TradeDocQuoteRef.tenant_id == tenant_id, TradeDocQuoteRef.trade_doc_id == d.id)
    )).scalars().all()
    refs["quotes"] = [{"quote_order_id": r.quote_order_id, "ref_type": r.ref_type} for r in rows]
    rows = (await db.execute(
        select(TradeDocInquiryRef).where(
            TradeDocInquiryRef.tenant_id == tenant_id, TradeDocInquiryRef.trade_doc_id == d.id)
    )).scalars().all()
    refs["inquiries"] = [{"inquiry_id": r.inquiry_id, "ref_type": r.ref_type} for r in rows]
    rows = (await db.execute(
        select(TradeDocDocRef).where(
            TradeDocDocRef.tenant_id == tenant_id, TradeDocDocRef.trade_doc_id == d.id)
    )).scalars().all()
    refs["docs"] = [{"source_trade_doc_id": r.source_trade_doc_id, "ref_type": r.ref_type}
                    for r in rows]
    # 行项目一并返回（前端就地编辑/派生展示需要）
    item_rows = (await db.execute(
        select(TradeDocItem).where(
            TradeDocItem.tenant_id == tenant_id, TradeDocItem.trade_doc_id == d.id
        ).order_by(TradeDocItem.sort_order, TradeDocItem.id)
    )).scalars().all()
    items = [{
        "id": r.id, "product_name": r.product_name, "spec_snapshot": r.spec_snapshot,
        "qty": float(r.qty) if r.qty is not None else None, "qty_unit": r.qty_unit,
        "unit_price": float(r.unit_price) if r.unit_price is not None else None,
        "currency": r.currency,
        "line_amount": float(r.line_amount) if r.line_amount is not None else None,
        "group_no": r.group_no, "scheme_prices": r.scheme_prices, "source": r.source,
        "sort_order": r.sort_order,
    } for r in item_rows]
    return {**_row_to_doc(d), "refs": refs, "items": items}


@router.patch("/trade-docs/{doc_id}")
async def update_trade_doc(
    doc_id: int,
    body: TradeDocPatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})

    if body.raw_payload is not None:
        try:
            assert_draft(d.status)   # 确认后锁死（内核状态机）
        except RuleError as exc:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": exc.code, "detail": exc.detail,
            })
        d.raw_payload = body.raw_payload

    if body.status is not None:
        target = validate_enum("doc_status", body.status)
        try:
            assert_transition(d.status, target)   # 内核状态机，同态合法
        except RuleError as exc:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": exc.code,
                "field": "status", "from": d.status, "to": target, "detail": exc.detail,
            })
        d.status = target
        if target == "issued":
            from datetime import datetime, timezone
            d.issued_at = datetime.now(timezone.utc)
            d.issued_by = str(auth.user_id)

    await db.commit()
    await db.refresh(d)
    return _row_to_doc(d)


# ── 渲染数据（前端负责排版，后端只提供数据）─────────────────────────────────

async def _company_profile(db, tenant_id):
    return (await db.execute(
        select(TenantCompanyProfile).where(TenantCompanyProfile.tenant_id == tenant_id)
    )).scalar_one_or_none()


async def _buyer_of(db, tenant_id, customer_id):
    """客户档案 + 主联系人 → 买方区块。customer_id 存的是字符串，这里做容错转换。"""
    if not customer_id:
        return {}
    try:
        cid = int(customer_id)
    except (TypeError, ValueError):
        return {}
    customer = (await db.execute(
        select(Customer).where(Customer.tenant_id == tenant_id, Customer.id == cid)
    )).scalar_one_or_none()
    if customer is None:
        return {}
    contact = (await db.execute(
        select(CustContact).where(
            CustContact.tenant_id == tenant_id, CustContact.customer_id == cid,
        ).order_by(CustContact.is_primary.desc(), CustContact.id)
    )).scalars().first()
    return buyer_block(customer, contact)


def _payload_parts(d: TradeDoc) -> tuple[dict, dict]:
    payload = d.raw_payload or {}
    return payload.get("sources") or {}, payload.get("custom") or {}


@router.get("/trade-docs/{doc_id}/render-data")
async def get_trade_doc_render_data(
    doc_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """返回渲染一份单据所需的全部数据（前端用它排版/预览/打印）。

    为什么由后端装配：数据来源跨 5 张表（单证/客户/联系人/报价/订单）+ 企业主体信息，
    把这套映射放在后端只有一份，前后端不会各自猜一遍字段名。
    """
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})

    profile = await _company_profile(db, tenant_id)
    sources, custom = _payload_parts(d)
    upstream = sources.get("order") or sources.get("quote") or {}

    data = build_render_data(
        doc_type=d.doc_type,
        doc_no=d.doc_no,
        doc_status=d.status,
        currency=d.currency or "USD",
        total_amount=float(d.total_amount) if d.total_amount is not None else None,
        created_at=d.created_at,
        issued_at=d.issued_at,
        seller=seller_block(profile),
        buyer=await _buyer_of(db, tenant_id, d.customer_id),
        bank_info=seller_block(profile),
        sources=sources,
        trade_terms=trade_terms_of(upstream),
        custom=custom,
        defaults={
            "incoterm": profile.default_incoterm if profile else None,
            "payment_terms": profile.default_payment_terms if profile else None,
            "country_of_origin": profile.default_country_of_origin if profile else None,
        },
    )
    return {
        "doc": _row_to_doc(d),
        "data": data,
        # 企业主体未配置时明确告知，避免用户对着空白抬头单据猜原因
        "company_profile_configured": bool(profile and profile.name_en),
    }


@router.post("/trade-docs/{doc_id}/refresh-sources")
async def refresh_trade_doc_sources(
    doc_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """从上游重新带入快照（仅 draft 可调用）。

    场景：报价改了但单据还没签发，允许一键同步；手工在 custom 里改过的字段保留
    （因为 custom 优先级最高）。已签发（issued）单据是法律凭证，彻底冻结。
    """
    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    if d.status != "draft":
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "NOT_DRAFT",
            "detail": "仅 draft 状态可重新带入上游数据（已签发单据已冻结）",
        })

    sources, custom = _payload_parts(d)
    new_sources: dict = {}
    if d.order_id:
        new_sources["order"] = await _order_snapshot(db, tenant_id, d.order_id)
    if "quote" in sources:
        quote_ref = (await db.execute(
            select(TradeDocQuoteRef).where(
                TradeDocQuoteRef.tenant_id == tenant_id,
                TradeDocQuoteRef.trade_doc_id == d.id,
            )
        )).scalars().first()
        if quote_ref is not None:
            new_sources["quote"] = await _quote_snapshot(db, tenant_id, quote_ref.quote_order_id)
    if "inquiry" in sources:
        inquiry_ref = (await db.execute(
            select(TradeDocInquiryRef).where(
                TradeDocInquiryRef.tenant_id == tenant_id,
                TradeDocInquiryRef.trade_doc_id == d.id,
            )
        )).scalars().first()
        if inquiry_ref is not None:
            new_sources["inquiry"] = await _inquiry_snapshot(db, tenant_id, inquiry_ref.inquiry_id)

    if not new_sources:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NO_UPSTREAM",
            "detail": "该单据没有可重新带入的上游来源",
        })

    upstream = new_sources.get("order") or new_sources.get("quote") or {}
    d.raw_payload = {"sources": new_sources, "custom": custom}
    if d.total_amount is None and upstream.get("total_amount") is not None:
        d.total_amount = upstream["total_amount"]

    await db.commit()
    await db.refresh(d)
    return {"doc": _row_to_doc(d), "sources": list(new_sources.keys())}


# ── 中译英（AI 翻译，draft-only）────────────────────────────────────────────

class TradeDocTranslateIn(BaseModel):
    fields: dict[str, str] = {}      # {字段名: 中文/中英混输}
    target: str = "en"


@router.post("/trade-docs/{doc_id}/translate")
async def translate_trade_doc(
    doc_id: int,
    body: TradeDocTranslateIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """单证字段中译英：中文/中英混输 → 外贸正式英文（draft 态才可写回）。

    走 ai_tasks 框架（可绑 Provider/可降级/记 ai_usage）；无 AI 时降级为
    原样回传并标注 path=template，前端提示人工翻译。
    """
    from app.services.ai_tasks import run_ai_task

    tenant_id = tenant_id_of(auth)
    d = (await db.execute(
        select(TradeDoc).where(TradeDoc.tenant_id == tenant_id, TradeDoc.id == doc_id)
    )).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})

    fields = {k: str(v) for k, v in (body.fields or {}).items() if str(v or "").strip()}
    if not fields:
        return {"fields": {}, "path": "none", "detail": "没有可翻译的字段"}

    outcome = await run_ai_task(db, tenant_id, "trade_doc_translate", {"fields": fields})
    result = outcome.get("result") or {}
    # 解析层兜底：未翻译到的键回退原文（不丢数据）
    merged = {k: str(result.get(k) or v) for k, v in fields.items()}

    # draft 态自动写回 raw_payload.custom（与就地编辑同通道；确认后锁死不写）
    if d.status == "draft":
        try:
            assert_draft(d.status)
            custom = dict((d.raw_payload or {}).get("custom") or {})
            custom.update(merged)
            payload = dict(d.raw_payload or {})
            payload["custom"] = custom
            d.raw_payload = payload
            await db.commit()
        except RuleError:
            pass   # 翻译结果仍返回，仅不写回

    return {"fields": merged, "path": outcome.get("path"), "task": outcome.get("task")}

