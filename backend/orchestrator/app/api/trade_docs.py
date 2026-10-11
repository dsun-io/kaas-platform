"""外贸单证工位 API（WORKSTATION_DESIGN.md §6.3 / §10.7）

单证从上游实体生成（询盘 / 报价单 / 订单任一类）。**溯源口径（2026-10-11 收口）**：
- 主归属（订单 / 报价）= **列** `trade_docs.order_id` / `trade_docs.quote_id`
  （由 `trg_trade_docs_links` 自动派生 `entity_links` 边）
- 列表达不了的关系（单证 ← 询盘、单证 ← 单证派生）= **边表 `entity_links`**
- 旧 refs 表（`trade_doc_*_refs` / `order_quote_refs`）已改名 `*_legacy` 留档，不再读写

端点：
- GET   /api/v1/trade-docs            单证列表（分页 + doc_type/status/order 筛选）
- POST  /api/v1/trade-docs            生成单证（doc_sequences 取号 + 上游快照入 raw_payload）
- GET   /api/v1/trade-docs/{id}       单证详情（含全部上游 refs）
- PATCH /api/v1/trade-docs/{id}       更新（draft 可改 payload）/ 状态流转（draft→issued→void）
"""
from typing import Optional
from decimal import Decimal
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Customer
from app.db.workstation_links import (
    Order, OrderItem, QuoteOrder, QuoteOrderItem,
    TradeDoc, TradeDocItem,
)
from app.db.workstation_models import (
    CustInquiry, CustContact, TenantCompanyProfile, TenantCompanySeal,
)
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, DOC_TYPE, CURRENCY, DOC_STATUS
from app.api.ws_common import (
    tenant_id_of, scope_filter, next_doc_no, resolve_customer_for_doc,
)
from app.api.company_profile import seller_block
from app.services.trade_doc_payload import (
    build_render_data, buyer_block, trade_terms_of,
)
from kaas_common.trade_doc import (
    RuleError, assert_draft, assert_derivable, assert_transition, validate_confirm,
    normalize_items, derive_payload, freeze_snapshot,
    append_audit, protected_custom_fields,
    apply_product_defaults, product_key_of,
    RENDER_KEY, render_fingerprint,
)
from kaas_common.files import apply_default_seal, is_file_ref, to_data_uri
from kaas_common.workstation.entity_links import (
    LINK_INSERT_SQL_NAMED, EdgeError, normalize_edge,
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
    # 业务客户外键（整数）：必须从**已有业务客户**里选，后端强校验（2026-10-11）。
    # 注意：单证表**没有** customer_name 列 —— 买方名字冻结在 raw_payload 快照里，
    # 所以这里没有 customer_name 参数（不编造不存在的列）。
    customer_id: Optional[int] = None
    currency: Optional[str] = None
    items: Optional[list[TradeDocItemIn]] = None   # 手动/派生行项目
    raw_payload: Optional[dict] = None       # 手动补充内容（draft 可改）


class TradeDocPatch(BaseModel):
    status: Optional[str] = None
    raw_payload: Optional[dict] = None
    # 改单时也能认领客户（历史单据的 customer_id 被清洗成 NULL 后要能补回来）。
    # 与 raw_payload 同一条闸门：仅 draft 可改 —— 签发后是法律凭证，买方不许再动。
    customer_id: Optional[int] = None


class TradeDocConfirmIn(BaseModel):
    """确认（issued）：校验必填 → 冻结；确认后不可修改。"""
    pass


# ── Helpers ──────────────────────────────────────────────────────────────────

def _reject_protected_custom(custom) -> None:
    """手工内容（custom）不得覆盖受保护字段：**金额与行项**只能来自上游快照或系统计算。

    背景：装配顺序是「上游快照 → 企业主体 → 默认条款 → custom 最后覆盖」，
    所以 custom 能盖掉任何键 —— 包括 `total_amount` / `items`。一份对外单据的金额
    若可被手填内容改写，单证与订单就对不上，而银行/海关正是按这两项审单。
    共享内核在渲染层还会再挡一次（历史脏数据也骗不了单据）。
    """
    blocked = protected_custom_fields(custom)
    if blocked:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CUSTOM_FIELD_PROTECTED",
            "fields": blocked,
            "detail": "以下字段只能来自上游快照或系统计算，不接受手工覆盖："
                      + "、".join(blocked),
        })


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

    # 业务客户强校验（放在**所有继承之后**）：手动传的、上游快照继承的、派生继承的
    # customer_id 都要过同一道闸门 —— 否则上游一个已软删的客户会顺着开单传下来。
    # 手工内容边界放在最后：派生路径也会把 manual 并进 payload["custom"]。
    _reject_protected_custom(payload.get("custom"))
    customer = await resolve_customer_for_doc(db, tenant_id, body.customer_id, auth)

    d = TradeDoc(
        tenant_id=tenant_id, doc_no=await next_doc_no(db, tenant_id, doc_type),
        doc_type=doc_type, order_id=order_id,
        customer_id=customer.id if customer is not None else None,
        status="draft", currency=currency, total_amount=total_amount,
        raw_payload=payload,
        # 单据与客户同团队（管理员替别家团队开单时不能把单据留在自己团队）
        team_id=customer.team_id if customer is not None else auth.team_id,
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
        from kaas_common.workstation.amount_rules import check_amount_reconciliation, AmountMismatchError
        try:
            check_amount_reconciliation(total_amount, items_total)
        except AmountMismatchError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "amount_mismatch", "code": "AMOUNT_MISMATCH",
                "detail": str(exc),
            })

    # ── 主归属列（读侧以列为准）─────────────────────────────────────
    # 订单 / 报价关系**只写列**：`trg_trade_docs_links` 随后自动派生边表，
    # 旧 refs 表已退场（202610110014 改名 `_legacy` 留档），这里不再手写。
    # 守两条约束：`ck_docs_has_customer`（必须有客户）、`ck_doc_single_parent`（报价/订单二选一）。
    if d.customer_id is not None:
        if body.order_id:
            d.order_id = body.order_id
        elif body.quote_order_id:
            d.quote_id = body.quote_order_id

    # ── 列表达不了的关系 → 显式写边表（§6.3 单证类型×生成阶段）─────────
    # 询盘没有列可挂（`trade_docs` 只有 order_id / quote_id），派生源同理 ——
    # 这两类关系原先落在 `trade_doc_inquiry_refs` / `trade_doc_doc_refs`，
    # 现在统一进 `entity_links`，与触发器派生出来的订单/报价边同表同源。
    # 派生关系的 `ref_type` 历史字面量是 `derived_from`（内核词表里没有），
    # 写入用 `revision_of`、原字面量进 `meta.origin_ref_type` —— 读取时还原，见 `_link_ref_type`。
    await _insert_links(db, tenant_id, d.id, [
        ("inquiry", body.inquiry_id, "generated_from", None),
        ("trade_doc", derive_doc.id if derive_doc is not None else None,
         "revision_of", {"origin_ref_type": "derived_from"}),
    ])

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
    now = datetime.now(timezone.utc)
    # C 方案：签发时冻结「渲染输入指纹」（见 kaas_common.trade_doc.render_fingerprint）。
    # 必须在改状态/签发时间**之前**算：装配层把单据日期取成 `issued_at or created_at`，
    # 签发前后算出的输入天然差一个日期字段 —— 该字段已被内核排除，见那里的理由。
    render_meta = await _freeze_render_fingerprint(doc_id, auth, db, now)

    d.status = "issued"
    d.issued_at = now
    d.issued_by = str(auth.user_id)
    # 与 `_audit` 同风格：**顶层保留键**，客户端自带的 `_render` 一律被这里覆盖
    payload = dict(d.raw_payload or {})
    payload[RENDER_KEY] = render_meta
    d.raw_payload = payload
    await db.commit()
    await db.refresh(d)
    return _row_to_doc(d)


async def _freeze_render_fingerprint(doc_id: int, auth, db, now) -> dict:
    """装配这张单据的渲染数据并算指纹（签发时冻结，写进 `raw_payload["_render"]`）。

    为什么"装配后再摘要"而不是只摘要 `raw_payload`：客户看到的是**装配结果** ——
    企业主体抬头、客户档案（买方）、上游快照、行项、产品图 `data:` URI、默认公章、
    产品基础信息回落，这些大多**不在** payload 里。只摘要 payload 会漏掉它们，
    事后"拿同一行重新装配"就对不上账，指纹也就失去意义。

    装配失败**不阻断签发**（签发是业务动作，不能被指纹计算拖垮）：如实记
    `input_sha256: null` + `note: input_unavailable`，绝不伪造一个看起来正常的摘要。
    """
    from datetime import timezone
    frozen_at = now.astimezone(timezone.utc).isoformat()
    try:
        assembled = await get_trade_doc_render_data(doc_id, auth, db)
        return render_fingerprint(assembled.get("data"), frozen_at=frozen_at)
    except Exception as exc:  # noqa: BLE001
        print(f"[trade-docs] 渲染指纹装配失败（签发继续，指纹标注不可用）："
              f"{type(exc).__name__}: {exc}")
        return render_fingerprint(None, frozen_at=frozen_at)


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
    # 上游 refs 一律来自**列 + 边表**（旧 `trade_doc_*_refs` 已改名留档、不再读）
    refs = await _doc_upstream_links(db, tenant_id, d)
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
        new_payload = dict(body.raw_payload or {})
        new_custom = new_payload.get("custom") or {}
        _reject_protected_custom(new_custom)
        # 审计留痕（谁在什么时候改了什么）：从**库里的旧 payload** 续写；
        # 客户端自带的 `_audit` 一律丢弃 —— 否则调用方能伪造或清空自己的审计。
        d.raw_payload = append_audit(
            new_payload,
            previous_payload=d.raw_payload or {},
            actor_id=str(auth.user_id),
            before_custom=(d.raw_payload or {}).get("custom") or {},
            after_custom=new_custom,
            at=datetime.now(timezone.utc).isoformat(),
        )

    if body.customer_id is not None:
        # 认领/更换买方：同样走强校验；仅 draft 可改（与 raw_payload 同一条闸门）
        try:
            assert_draft(d.status)
        except RuleError as exc:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": exc.code, "detail": exc.detail,
            })
        customer = await resolve_customer_for_doc(db, tenant_id, body.customer_id, auth)
        d.customer_id = customer.id
        d.team_id = customer.team_id

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
    """客户档案 + 主联系人 → 买方区块。

    `customer_id` 在迁移 202610110009 之后是 BIGINT（历史遗留脏文本已清洗成 NULL），
    这里的容错转换只为兜住"清洗前就存在的进程内旧对象"，正常路径上不会再触发。
    """
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


# ── 关系（边表）读写 ─────────────────────────────────────────────────────────
# 为什么需要这一段：旧 refs 表按"一个关系一张表"建，`trade_doc_inquiry_refs`
# （单证 ← 询盘）与 `trade_doc_doc_refs`（单证 ← 单证派生）记录的是**列表达不了**
# 的关系 —— `trade_docs` 只有 `order_id` / `quote_id` 两列，询盘与派生源没有列，
# 触发器也就无从派生。所以这两类关系改为显式写边表 `entity_links`，
# 与"列自动派生"的订单/报价关系**共用同一张表**，读侧只有一个来源。

_DOC_LINK_SRC = "trade_doc"


async def _insert_links(db, tenant_id: str, src_id: int, targets) -> None:
    """把若干 (dst_type, dst_id, rel_type, meta) 关系写进边表（幂等，重复建立不报错）。

    越界防线 `ENTITY_TYPES` / `rel_type` 校验走共享内核 `normalize_edge`：
    边表没有外键（多态设计的已知代价），校验是唯一的"防呆"。
    `meta` 承载关系自身的属性（如派生关系原本的 `ref_type` 字面量）。
    """
    for dst_type, dst_id, rel_type, meta in targets:
        if not dst_id:
            continue          # 空父对象：不写边（与旧 refs 表"没有就不写行"一致）
        try:
            edge = normalize_edge(_DOC_LINK_SRC, src_id, dst_type, dst_id, rel_type,
                                  meta=meta)
        except EdgeError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": exc.code, "detail": exc.detail})
        await db.execute(text(LINK_INSERT_SQL_NAMED), {
            "tenant_id": tenant_id, "src_type": edge["src_type"], "src_id": edge["src_id"],
            "dst_type": edge["dst_type"], "dst_id": edge["dst_id"],
            "rel_type": edge["rel_type"], "meta": edge["meta"], "created_by": None,
        })


async def _active_links(db, tenant_id: str, src_id: int, dst_type: str) -> list:
    """读本单证 → `dst_type` 的有效边（`deleted_at IS NULL`，按 id 稳定排序）。

    旧 refs 表每 (单证, 关系) 一行有效关系，这里同样只取有效边 —— 软删的边属于
    "关系变更史"（原由 A 生成、后改 B），不该出现在详情里。

    连 `meta` 一起取：它保留**关系自身**的原始语义（如派生关系原来的
    `ref_type='derived_from'`），读侧据此还原旧字段值（见 `_link_ref_type`）。
    """
    rows = (await db.execute(
        text(
            "SELECT dst_id, rel_type, meta FROM entity_links"
            " WHERE tenant_id = :tenant_id AND src_type = 'trade_doc'"
            "   AND src_id = :src_id AND dst_type = :dst_type AND deleted_at IS NULL"
            " ORDER BY id"
        ),
        {"tenant_id": tenant_id, "src_id": src_id, "dst_type": dst_type},
    )).mappings().all()
    return [{"dst_id": r["dst_id"], "rel_type": r["rel_type"], "meta": r["meta"]}
            for r in rows]


def _link_ref_type(link: dict) -> str:
    """边 → 旧 refs 的 `ref_type` 字面量（字段级等价，前端契约不变）。

    `trade_doc_doc_refs` 的 `ref_type` 历史取值是 `'derived_from'`，而内核
    `REL_TYPES` 里没有这个取值（词表是刻意收口的，不为了兼容而扩容）——
    写入时映射成语义等价的 `revision_of`，原始字面量存进 `meta.origin_ref_type`，
    在这里还原。没有 meta 的边（触发器派生、或旧数据）直接用 `rel_type`。
    """
    meta = link.get("meta") or {}
    return meta.get("origin_ref_type") or link["rel_type"]


async def _doc_upstream_links(db, tenant_id: str, d: TradeDoc) -> dict:
    """详情端点用的上游 refs（字段名与旧 refs 表读取**逐字相同**，前端契约不变）。

    优先级：**列**（主归属，权威）> 边表（历史行/列被清洗的情况）。
    为什么需要兜底而不是只读列：`trade_docs.quote_id` 的回填在迁移 012 里刻意
    跳过了 `customer_id IS NULL` 的历史行（`NOT VALID` 约束会在 UPDATE 时重新校验）。
    那些行的归属只在边表里 —— 只读列会让它们的"报价 → 单证"关系凭空消失。
    """
    quotes = await _active_links(db, tenant_id, d.id, "quote")
    orders = await _active_links(db, tenant_id, d.id, "order")
    if d.quote_id is not None:
        quote_row = next((r for r in quotes if r["dst_id"] == d.quote_id), None)
        quotes = [{"dst_id": d.quote_id, "rel_type": "generated_from",
                   "meta": quote_row["meta"] if quote_row else None}]
    if d.order_id is not None:
        order_row = next((r for r in orders if r["dst_id"] == d.order_id), None)
        orders = [{"dst_id": d.order_id, "rel_type": "generated_from",
                   "meta": order_row["meta"] if order_row else None}]
    inquiries = await _active_links(db, tenant_id, d.id, "inquiry")
    docs = await _active_links(db, tenant_id, d.id, "trade_doc")
    return {
        "orders": [{"order_id": r["dst_id"], "ref_type": _link_ref_type(r)} for r in orders],
        "quotes": [{"quote_order_id": r["dst_id"], "ref_type": _link_ref_type(r)}
                   for r in quotes],
        "inquiries": [{"inquiry_id": r["dst_id"], "ref_type": _link_ref_type(r)}
                      for r in inquiries],
        "docs": [{"source_trade_doc_id": r["dst_id"], "ref_type": _link_ref_type(r)}
                 for r in docs],
    }


async def _resolve_doc_quote_id(db, tenant_id: str, d: TradeDoc):
    """本单证的报价来源（`refresh-sources` 用）：列优先，边表兜底。

    与旧实现（`SELECT ... FROM trade_doc_quote_refs ... LIMIT 1`）等价：
    旧表每 (单证, ref_type) 唯一，最多一行；这里取**最早**的有效报价边，
    列有值时直接信列（触发器已保证列与边一致）。
    """
    if d.quote_id is not None:
        return d.quote_id
    links = await _active_links(db, tenant_id, d.id, "quote")
    return links[0]["dst_id"] if links else None


async def _resolve_product_photos(db, tenant_id: str, data: dict) -> dict:
    """把单证 `product_photos` 里的 `{file_id}` 引用解析成图片源（data URI）。

    为什么在装配层做：渲染器的图片白名单只认 `data:` 与 `http(s)`（防注入设计，不放开），
    而 `{file_id}` 不是图片源 —— 解析放在喂给渲染器之前，**渲染器一行都不用改**。
    取不到字节（例如本侧没有对象存储、或文件已下线）就**跳过该条**，不印一个坏图。
    """
    photos = data.get("product_photos")
    if not isinstance(photos, list) or not photos:
        return data
    from app.api.files import load_file_bytes  # 局部导入避免模块级循环依赖

    resolved = []
    for entry in photos:
        if not is_file_ref(entry):
            resolved.append(entry)          # 已是图片源（data:/http(s)）→ 原样透传
            continue
        row = (await db.execute(text(
            "SELECT name, content_type, file_name, content, object_key, storage FROM file_objects"
            " WHERE tenant_id=:t AND id=:id AND is_current"
        ), {"t": tenant_id, "id": int(entry["file_id"])})).mappings().first()
        if row is None:
            continue
        blob = await load_file_bytes(dict(row))   # inline 读列 / s3 预签名回源
        if blob is None:
            continue
        resolved.append({
            "image": to_data_uri(row["content_type"], blob, row["file_name"]),
            "caption": entry.get("caption") or row["name"],
        })
    data["product_photos"] = resolved
    return data


# ── 默认公章带入（单据没显式给 company_stamp 时的回落）────────────────────────
# 判定（字段名/覆盖优先级/空值处理）在**共享内核**：G1 只允许一份 ——
# `kaas_common/files/seal.py`（Pyodide 可加载，与 Worker 同一函数对象）。
#   1. 单据 `custom` 显式含 `company_stamp`（含空串）⇒ 不覆盖；
#   2. 否则租户默认章（`is_default`）转 `data:` URI 填入；
#   3. 都没有 ⇒ 不注入、不伪造空图。
# 本文件只保留"怎么取到默认章那一行"（本侧走 SQLAlchemy session）。


async def _default_seal_row(db, tenant_id: str):
    """租户默认公章行（默认章唯一，由部分唯一索引兜底）；没有则 None。"""
    return (await db.execute(
        select(TenantCompanySeal).where(
            TenantCompanySeal.tenant_id == tenant_id,
            TenantCompanySeal.is_default.is_(True),
        ).order_by(TenantCompanySeal.id).limit(1)
    )).scalars().first()


async def _apply_default_seal(db, tenant_id: str, data: dict, custom) -> dict:
    """装配层最后一步：只在单据**没**显式给 `company_stamp` 时才查库（省无谓查询）。"""
    if isinstance(custom, dict) and "company_stamp" in custom:
        return data
    return apply_default_seal(data, custom, await _default_seal_row(db, tenant_id))


# ── 产品基础信息带入（一次维护、重复使用）────────────────────────────────────
# 判定（填哪些字段/覆盖优先级/空值处理）在**共享内核**：G1 只允许一份 ——
# `kaas_common/trade_doc/product_defaults.py`。
# 本文件只保留"怎么取到产品档案"（本侧走 SQLAlchemy session），并做**注册表校验**：
# 注册表（代码里的 ProductSpec）才是"有哪些产品"的唯一来源，info 只是它的补充。


async def _product_info_of(db, tenant_id: str, product_key: str):
    """产品档案 `info`；产品不在注册表 / 没维护过 → None。"""
    from app.services.export_quote.products import has as has_product  # 惰性：不拖累模块加载
    if not has_product(product_key):
        return None
    row = (await db.execute(text(
        "SELECT info FROM product_profiles WHERE tenant_id=:t AND product_key=:k"
    ), {"t": tenant_id, "k": product_key})).mappings().first()
    if row is None:
        return None
    info = row["info"]
    # 形状容错：正常路径上 JSONB 列回来就是 dict，但历史/直连驱动可能给 JSON 文本。
    # 与 Worker 侧同一口径（两端都收两种形状），避免"字段在、值是字符串"而静默不生效。
    if isinstance(info, str):
        import json
        try:
            info = json.loads(info)
        except (TypeError, ValueError):
            return None
    return dict(info) if isinstance(info, dict) else None


async def _apply_product_defaults(db, tenant_id: str, doc_type: str, data: dict, custom) -> dict:
    """装配层：单据**显式关联了产品**才查档案（没关联 → 一次查询都不发，回归旧行为）。"""
    key = product_key_of(custom)
    if not key:
        return data
    info = await _product_info_of(db, tenant_id, key)
    return apply_product_defaults(data, custom, doc_type, info)


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
    # 单证引用产品图：把 `{file_id}` 解析成图片源（渲染器只认 data:/http(s)，不放开白名单）
    data = await _resolve_product_photos(db, tenant_id, data)
    # 单据没显式给 company_stamp → 自动带出租户默认公章（同样转 data URI）
    data = await _apply_default_seal(db, tenant_id, data, custom)
    # 单据关联了产品 → 把产品档案的基础信息补进仍为空的行项（见共享内核 product_defaults）
    data = await _apply_product_defaults(db, tenant_id, d.doc_type, data, custom)
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
        # 报价来源：**列优先、边表兜底**（旧实现读 `trade_doc_quote_refs` LIMIT 1）。
        # 列是主归属；`customer_id IS NULL` 的历史行当年没被回填（见 `_doc_upstream_links`），
        # 它们的报价只在边表里 —— 少了兜底这些行会立刻 422 NO_UPSTREAM。
        quote_id = await _resolve_doc_quote_id(db, tenant_id, d)
        if quote_id is not None:
            new_sources["quote"] = await _quote_snapshot(db, tenant_id, quote_id)
    if "inquiry" in sources:
        inquiry_links = await _active_links(db, tenant_id, d.id, "inquiry")
        if inquiry_links:
            new_sources["inquiry"] = await _inquiry_snapshot(
                db, tenant_id, inquiry_links[0]["dst_id"])

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

