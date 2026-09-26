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

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_links import (
    Order, OrderItem, QuoteOrder, QuoteOrderItem,
    TradeDoc, TradeDocOrderRef,
)
from app.db.workstation_models import (
    CustInquiry, TradeDocQuoteRef, TradeDocInquiryRef,
)
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, DOC_TYPE, CURRENCY, DOC_STATUS
from app.api.ws_common import tenant_id_of, scope_filter, next_doc_no

router = APIRouter(prefix="/api/v1", tags=["trade-docs"])

DOC_NEXT = {"draft": ("issued", "void"), "issued": ("void",)}


# ── Schemas ──────────────────────────────────────────────────────────────────

class TradeDocCreate(BaseModel):
    doc_type: str                            # §10.4 DOC_TYPE
    order_id: Optional[int] = None           # 上游来源（至少一个）
    quote_order_id: Optional[int] = None
    inquiry_id: Optional[int] = None
    customer_id: Optional[str] = None
    currency: Optional[str] = None
    raw_payload: Optional[dict] = None       # 手动补充内容（draft 可改）


class TradeDocPatch(BaseModel):
    status: Optional[str] = None
    raw_payload: Optional[dict] = None


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
        "items": [{
            "product_name": i.product_name, "qty": float(i.qty) if i.qty is not None else None,
            "qty_unit": i.qty_unit,
            "unit_price": float(i.unit_price) if i.unit_price is not None else None,
            "line_amount": float(i.line_amount) if i.line_amount is not None else None,
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
        "items": [{
            "product_name": i.product_name, "qty": float(i.qty) if i.qty is not None else None,
            "qty_unit": i.qty_unit,
            "unit_price": float(i.unit_price) if i.unit_price is not None else None,
            "line_amount": float(i.line_amount) if i.line_amount is not None else None,
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


@router.post("/trade-docs", status_code=201)
async def create_trade_doc(
    body: TradeDocCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    if not any([body.order_id, body.quote_order_id, body.inquiry_id]):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "SOURCE_REQUIRED",
            "detail": "单证需至少一个上游来源：order_id / quote_order_id / inquiry_id",
        })
    doc_type = validate_enum("doc_type", body.doc_type)
    currency = (validate_enum("currency", body.currency) if body.currency else None) or "USD"

    # 上游快照入 raw_payload（生成时冻结，防关联变更导致历史失真）
    payload = {"sources": {}, "custom": body.raw_payload or {}}
    total_amount = None
    order_id = body.order_id
    if body.order_id:
        snap = await _order_snapshot(db, tenant_id, body.order_id)
        payload["sources"]["order"] = snap
        total_amount = snap["total_amount"]
        if body.customer_id is None:
            body.customer_id = snap["customer_id"]
    if body.quote_order_id:
        snap = await _quote_snapshot(db, tenant_id, body.quote_order_id)
        payload["sources"]["quote"] = snap
        if total_amount is None:
            total_amount = snap["total_amount"]
        if body.customer_id is None:
            body.customer_id = snap["customer_id"]
    if body.inquiry_id:
        snap = await _inquiry_snapshot(db, tenant_id, body.inquiry_id)
        payload["sources"]["inquiry"] = snap

    d = TradeDoc(
        tenant_id=tenant_id, doc_no=await next_doc_no(db, tenant_id, doc_type),
        doc_type=doc_type, order_id=order_id, customer_id=body.customer_id,
        status="draft", currency=currency, total_amount=total_amount,
        raw_payload=payload,
    )
    db.add(d)
    await db.flush()

    # refs 溯源（§6.3 单证类型×生成阶段）
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
    refs = {"orders": [], "quotes": [], "inquiries": []}
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
    return {**_row_to_doc(d), "refs": refs}


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
        if d.status != "draft":
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "NOT_DRAFT",
                "detail": "仅 draft 状态可修改内容",
            })
        d.raw_payload = body.raw_payload

    if body.status is not None:
        target = validate_enum("doc_status", body.status)
        allowed = DOC_NEXT.get(d.status, ())
        if target != d.status and target not in allowed:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "field": "status", "from": d.status, "to": target, "allowed": list(allowed),
            })
        d.status = target
        if target == "issued":
            from datetime import datetime, timezone
            d.issued_at = datetime.now(timezone.utc)
            d.issued_by = str(auth.user_id)

    await db.commit()
    await db.refresh(d)
    return _row_to_doc(d)

