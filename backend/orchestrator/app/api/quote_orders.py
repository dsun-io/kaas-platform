"""报价单（quote_orders）—— 现行实现。

为什么新建本模块而不是继续用 `app/api/quotes.py`
-------------------------------------------------
`docs/CURRENT_IMPLEMENTATION_MAP.md` 已把旧的 `quotes.py` 判为**遗留**
（前端零调用 + 线上无此路由）。但"报价单"这一实体是活的：单证工位按
`quote_order_id` 冻结快照（`trade_docs.py::_quote_snapshot`）、订单工位按
`quote_order_id` 转化（`orders.py`）都在读它。所以新能力（多产品行项编辑、
询盘关联、行项整批替换）不在遗留文件上继续叠加，而是本模块承接，旧模块退役
（`main.py` 不再挂载它）。

业务口径（与 `docs/MULTI_PRODUCT_QUOTE_PLAN.md` 一致）
------------------------------------------------------
- **一行 = 一个产品**：一个询盘有多种产品就是多行，不是多张报价单。
- **试算不落库、草稿不落账**：台账只在 `draft → sent`（报价单签发）时写一条。
- **行小计 = 数量 × 单价**，且数量口径是「卷数」（`qty_unit=ROLLS`）：
  单证上 `Amount = Quantity × Unit Price` 是审单第一条硬规则，
  两侧同源才能保证"报价工位汇总 == 单证 TOTAL 行"。
- **行项只在 draft 可改**：签发后是法律凭证，上游改动不得影响它。

端点
----
- `GET    /api/v1/quotes`              列表（含行数；不返回行项明细，避免 N+1）
- `POST   /api/v1/quotes`              新建（可带多行 + 询盘来源；锁汇率快照）
- `GET    /api/v1/quotes/{id}`         详情（含行项）
- `PATCH  /api/v1/quotes/{id}`         改单头 / 状态流转（draft→sent 时入台账）
- `PUT    /api/v1/quotes/{id}/items`   行项**整批替换**（工作台保存语义）
"""
from typing import List, Optional
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Quotation
from app.db.workstation_links import QuoteOrder, QuoteOrderItem
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, CURRENCY, OWNER_SCOPE
from app.domain.spec_hash import compute_spec_hash
from app.repositories.quotations_repo import insert_quotation
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no, lock_fx_rate,
)

router = APIRouter(prefix="/api/v1", tags=["quote-orders"])

# 状态机（§10.4）：draft → sent → accepted / rejected / expired
ORDER_NEXT = {
    "draft": ("sent", "expired"),
    "sent": ("accepted", "rejected", "expired"),
}

# 报价记录台账的来源标记：由报价单签发自动入账（区别于 quotations_db / 手工录入）
LEDGER_SOURCE_QUOTE_ISSUED = "quote_issued"

# 允许写行项的状态。签发之后是法律凭证，任何上游改动都不得影响它。
EDITABLE_STATUS = ("draft",)


# ── Schemas（与 shared/contracts/quote-order.ts 逐字段对齐）──────────────────

class QuoteItemIn(BaseModel):
    sku_id: Optional[int] = None
    product_name: str
    spec_snapshot: Optional[dict] = None
    qty: Decimal
    qty_unit: str = "ROLLS"
    unit_price: Optional[Decimal] = None
    currency: Optional[str] = None
    line_amount: Optional[Decimal] = None
    sort_order: int = 0
    # ── 多产品逐行计算上下文 + 手动干预 ──
    # 行级报价政策覆盖（利润率/综合税费系数等），空则继承报价单共享政策
    policy_override: Optional[dict] = None
    # auto（公式自动）| manual（非标产品手动给价）| overridden（覆盖公式结果）
    price_source: str = "auto"
    cost_override: Optional[Decimal] = None
    price_override: Optional[Decimal] = None
    weight_override: Optional[Decimal] = None
    volume_override: Optional[Decimal] = None
    image_url: Optional[str] = None


class QuoteOrderCreate(BaseModel):
    customer_id: Optional[str] = None
    customer_name: Optional[str] = None
    inquiry_id: Optional[int] = None          # 询盘来源（一个询盘一张报价单）
    currency: str = "USD"
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    owner_scope: str = "private"
    # 贸易条款（202609260001 加正列）：报价谈定的条款要能一路传到订单与单证
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None
    items: List[QuoteItemIn] = []


class QuoteOrderPatch(BaseModel):
    customer_name: Optional[str] = None
    currency: Optional[str] = None
    valid_until: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = None
    incoterm: Optional[str] = None
    payment_terms: Optional[str] = None
    port_of_loading: Optional[str] = None
    port_of_destination: Optional[str] = None
    shipping_marks: Optional[str] = None
    country_of_origin: Optional[str] = None


class QuoteItemsReplace(BaseModel):
    items: List[QuoteItemIn]


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_quote(q: QuoteOrder, item_count: int = 0) -> dict:
    return {
        "id": q.id, "quote_no": q.quote_no,
        "customer_id": q.customer_id, "customer_name": q.customer_name,
        "inquiry_id": q.inquiry_id,
        "status": q.status, "currency": q.currency,
        "total_amount": float(q.total_amount) if q.total_amount is not None else None,
        "valid_until": q.valid_until.isoformat() if q.valid_until else None,
        "notes": q.notes,
        "fx_rate": float(q.fx_rate) if q.fx_rate is not None else None,
        "fx_rate_date": q.fx_rate_date.isoformat() if q.fx_rate_date else None,
        "created_at": q.created_at.isoformat() if q.created_at else None,
        "owner_id": q.owner_id, "owner_scope": q.owner_scope,
        "item_count": item_count,
        "incoterm": q.incoterm, "payment_terms": q.payment_terms,
        "port_of_loading": q.port_of_loading,
        "port_of_destination": q.port_of_destination,
        "shipping_marks": q.shipping_marks,
        "country_of_origin": q.country_of_origin,
    }


def _row_to_item(it: QuoteOrderItem) -> dict:
    return {
        "id": it.id, "quote_order_id": it.quote_order_id, "sku_id": it.sku_id,
        "product_name": it.product_name, "spec_snapshot": it.spec_snapshot,
        "qty": float(it.qty) if it.qty is not None else None,
        "qty_unit": it.qty_unit,
        "unit_price": float(it.unit_price) if it.unit_price is not None else None,
        "currency": it.currency,
        "line_amount": float(it.line_amount) if it.line_amount is not None else None,
        "sort_order": it.sort_order,
        "policy_override": it.policy_override,
        "price_source": it.price_source,
        "cost_override": float(it.cost_override) if it.cost_override is not None else None,
        "price_override": float(it.price_override) if it.price_override is not None else None,
        "weight_override": float(it.weight_override) if it.weight_override is not None else None,
        "volume_override": float(it.volume_override) if it.volume_override is not None else None,
        "image_url": it.image_url,
        "created_at": it.created_at.isoformat() if it.created_at else None,
    }


def _build_items(tenant_id: str, currency: str, rows: List[QuoteItemIn]) -> tuple[list, Decimal]:
    """行项 → ORM 对象 + 单头合计。

    合计口径：**行小计优先取前端算好的 `line_amount`**（它等于 卷数 × 单卷外币价，
    与单证 Amount 同源）；只有没给时才用 数量 × 单价 补算。
    这样"报价工位汇总"和"单证 TOTAL"用的是同一批数字，不会出现差 1 分。
    """
    items: list = []
    total = Decimal("0")
    for row in rows:
        line = row.line_amount
        if line is None and row.unit_price is not None:
            line = row.qty * row.unit_price
        if line is not None:
            line = Decimal(line)
        items.append(QuoteOrderItem(
            tenant_id=tenant_id, sku_id=row.sku_id,
            product_name=row.product_name, spec_snapshot=row.spec_snapshot,
            qty=row.qty, qty_unit=row.qty_unit or "ROLLS",
            unit_price=row.unit_price,
            currency=validate_enum("currency", row.currency) if row.currency else currency,
            line_amount=line, sort_order=row.sort_order,
            policy_override=row.policy_override,
            price_source=row.price_source,
            cost_override=row.cost_override,
            price_override=row.price_override,
            weight_override=row.weight_override,
            volume_override=row.volume_override,
            image_url=row.image_url,
        ))
        if line is not None:
            total += line
    return items, total


async def _item_count_map(db, tenant_id: str, quote_ids: List[int]) -> dict:
    """一次查出多张报价单的行数（列表页要显示"含 N 个产品"，不能 N+1 次查询）。"""
    if not quote_ids:
        return {}
    rows = (await db.execute(
        select(QuoteOrderItem.quote_order_id, func.count())
        .where(
            QuoteOrderItem.tenant_id == tenant_id,
            QuoteOrderItem.quote_order_id.in_(quote_ids),
        )
        .group_by(QuoteOrderItem.quote_order_id)
    )).all()
    return {r[0]: r[1] for r in rows}


async def _items_of(db, tenant_id: str, quote_id: int) -> list:
    return (await db.execute(
        select(QuoteOrderItem)
        .where(
            QuoteOrderItem.tenant_id == tenant_id,
            QuoteOrderItem.quote_order_id == quote_id,
        )
        .order_by(QuoteOrderItem.sort_order, QuoteOrderItem.id)
    )).scalars().all()


async def _get_quote_or_404(db, tenant_id, quote_id, auth) -> QuoteOrder:
    stmt = select(QuoteOrder).where(
        QuoteOrder.tenant_id == tenant_id, QuoteOrder.id == quote_id,
    )
    stmt = scope_filter(stmt, QuoteOrder, auth)
    q = (await db.execute(stmt)).scalar_one_or_none()
    if q is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "QUOTE_NOT_FOUND"})
    return q


def _parse_dt(value: Optional[str]):
    return datetime.fromisoformat(value) if value else None


async def _record_quote_issued(db: AsyncSession, q: QuoteOrder, auth: AuthContext) -> None:
    """报价单签发 → 向「报价记录」台账入账（**一张单一条**）。

    为什么只在此处写：台账只记业务节点（报价单签发 / 订单成交），
    算价试算不落账 —— 否则台账会被垃圾流水淹没。

    为什么是整单一条（已确认的粒度）：
    - 台账按客户 + 产品类目组织，而一张报价单可含多个类目，拆行会丢上下文；
    - 行项明细放进 product_spec 快照，条数不膨胀、明细仍可追溯。

    为什么用 other 类目：整单记录不属于单一产品类目，用既有的 other 档
    而不是新增枚举值（避免动契约）。
    """
    if not q.customer_id:
        # 台账按客户归属；没有客户无法入账。不阻断签发，只跳过。
        return

    items = await _items_of(db, q.tenant_id, q.id)
    total = float(q.total_amount) if q.total_amount is not None else None
    snapshot = {
        "doc": "quotation",
        "quote_no": q.quote_no,
        "customer_name": q.customer_name,
        "currency": q.currency,
        "total_amount": total,
        "fx_rate": float(q.fx_rate) if q.fx_rate is not None else None,
        "incoterm": q.incoterm,
        "items": [
            {
                "product_name": i.product_name,
                "qty": float(i.qty) if i.qty is not None else None,
                "qty_unit": i.qty_unit,
                "unit_price": float(i.unit_price) if i.unit_price is not None else None,
                "line_amount": float(i.line_amount) if i.line_amount is not None else None,
            }
            for i in items
        ],
    }
    spec_hash = compute_spec_hash(snapshot)

    # 幂等：同一张报价单只入账一次。
    # 状态机虽已限制 draft→sent 只能走一次，但重试/重复提交仍可能触发，
    # 而台账是 INSERT-only 的事实表，脏数据清不掉。
    exists = (await db.execute(
        select(func.count()).select_from(Quotation).where(
            Quotation.tenant_id == q.tenant_id,
            Quotation.source == LEDGER_SOURCE_QUOTE_ISSUED,
            Quotation.spec_hash == spec_hash,
        )
    )).scalar_one()
    if exists:
        return

    await insert_quotation(
        session=db, tenant_id=q.tenant_id, customer_id=q.customer_id,
        product_category="other", product_spec=snapshot, spec_hash=spec_hash,
        unit_price=total, currency=q.currency or "USD", unit="单",
        discount=None, min_quantity=None,
        source=LEDGER_SOURCE_QUOTE_ISSUED,
        notes=f"由报价单 {q.quote_no} 签发自动入账（整单一条）",
        # created_by 列是 VARCHAR，而 user_id 是整数 —— 必须显式转字符串。
        # （旧 quotes.py 里同一处漏了转换，因为前端零调用从未触发过，属潜伏缺陷。）
        created_by=str(getattr(auth, "user_id", None) or "") or None,
    )


# ── 端点 ─────────────────────────────────────────────────────────────────────

@router.get("/quotes")
async def list_quotes(
    status: Optional[str] = None,
    customer_id: Optional[str] = None,
    inquiry_id: Optional[int] = None,
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
    if inquiry_id is not None:
        stmt = stmt.where(QuoteOrder.inquiry_id == inquiry_id)
    stmt = scope_filter(stmt, QuoteOrder, auth)

    total = (await db.execute(
        select(func.count()).select_from(stmt.subquery())
    )).scalar_one()
    rows = (await db.execute(
        stmt.order_by(QuoteOrder.created_at.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )).scalars().all()

    counts = await _item_count_map(db, tenant_id, [q.id for q in rows])
    return {
        "items": [_row_to_quote(q, counts.get(q.id, 0)) for q in rows],
        "total": total, "page": page, "page_size": page_size,
    }


@router.post("/quotes", status_code=201)
async def create_quote_order(
    body: QuoteOrderCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    currency = validate_enum("currency", body.currency) or "USD"
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"

    items, total = _build_items(tenant_id, currency, body.items)
    # 空单也允许创建（工作台"先建单、再逐行加产品"的自然用法），
    # 但合计留空而不是 0 —— 0 会被当成"报过价、价是 0"。
    rate, rate_date = await lock_fx_rate(db, currency)

    q = QuoteOrder(
        tenant_id=tenant_id, quote_no=await next_doc_no(db, tenant_id, "quotation"),
        customer_id=body.customer_id, customer_name=body.customer_name,
        inquiry_id=body.inquiry_id,
        status="draft", currency=currency, total_amount=total if items else None,
        valid_until=_parse_dt(body.valid_until), notes=body.notes,
        fx_rate=rate, fx_rate_date=rate_date,
        created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        incoterm=body.incoterm, payment_terms=body.payment_terms,
        port_of_loading=body.port_of_loading,
        port_of_destination=body.port_of_destination,
        shipping_marks=body.shipping_marks,
        country_of_origin=body.country_of_origin,
    )
    db.add(q)
    await db.flush()  # 取 q.id 挂行项
    for it in items:
        it.quote_order_id = q.id
        db.add(it)
    await db.commit()
    await db.refresh(q)
    return _row_to_quote(q, len(items))


@router.get("/quotes/{quote_id}")
async def get_quote_order(
    quote_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    q = await _get_quote_or_404(db, tenant_id, quote_id, auth)
    items = await _items_of(db, tenant_id, q.id)
    payload = _row_to_quote(q, len(items))
    payload["items"] = [_row_to_item(i) for i in items]
    return payload


@router.patch("/quotes/{quote_id}")
async def update_quote_order(
    quote_id: int,
    body: QuoteOrderPatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    q = await _get_quote_or_404(db, tenant_id, quote_id, auth)
    check_write_access(q, auth)

    if body.status is not None and body.status != q.status:
        validate_enum("quote_status", body.status)
        allowed = ORDER_NEXT.get(q.status, ())
        if body.status not in allowed:
            raise HTTPException(status_code=400, detail={
                "error": "invalid_transition", "code": "INVALID_STATUS_TRANSITION",
                "detail": f"{q.status} → {body.status} 不是合法流转（允许：{allowed}）",
            })
        q.status = body.status

    if body.currency is not None:
        q.currency = validate_enum("currency", body.currency) or q.currency
    for field in ("customer_name", "notes", "incoterm", "payment_terms",
                  "port_of_loading", "port_of_destination", "shipping_marks",
                  "country_of_origin"):
        value = getattr(body, field)
        if value is not None:
            setattr(q, field, value)
    if body.valid_until is not None:
        q.valid_until = _parse_dt(body.valid_until)

    # 签发与入账必须**同一个事务**：
    # 先 commit 再入账的话，入账失败会留下"状态已 sent、台账里没有"的不一致 ——
    # 而用户看到的是一次 500，会以为签发失败又去点一次。
    if body.status == "sent":
        await db.flush()
        await _record_quote_issued(db, q, auth)

    await db.commit()
    await db.refresh(q)

    return _row_to_quote(q)


@router.put("/quotes/{quote_id}/items")
async def replace_quote_items(
    quote_id: int,
    body: QuoteItemsReplace,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """行项整批替换：工作台"保存"的语义（整单一次提交，不留半截脏行）。

    为什么是替换而不是逐行增删改：多产品工作台里行的增删改是**一次编辑动作**，
    逐行接口会让"改到一半失败"留下前后不一致的报价单（部分新、部分旧），
    而报价单是要拿出去报价的。
    """
    tenant_id = tenant_id_of(auth)
    q = await _get_quote_or_404(db, tenant_id, quote_id, auth)
    check_write_access(q, auth)

    if q.status not in EDITABLE_STATUS:
        raise HTTPException(status_code=409, detail={
            "error": "not_editable", "code": "QUOTE_NOT_EDITABLE",
            "detail": f"报价单已处于 {q.status}，签发后不可再改行项"
                      "（要改请另开一张，历史单据必须可追溯）",
        })

    old = await _items_of(db, tenant_id, q.id)
    for row in old:
        await db.delete(row)
    await db.flush()

    items, total = _build_items(tenant_id, q.currency, body.items)
    for it in items:
        it.quote_order_id = q.id
        db.add(it)
    # 空行集合 → 合计留空（不是 0）
    q.total_amount = total if items else None
    await db.commit()

    rows = await _items_of(db, tenant_id, q.id)
    return {"id": q.id, "total_amount": float(q.total_amount) if q.total_amount is not None else None,
            "items": [_row_to_item(i) for i in rows]}
