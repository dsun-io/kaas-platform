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
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import Quotation
from app.db.workstation_links import QuoteOrder, QuoteOrderItem
from app.db.workstation_models import CustInquiry
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, CURRENCY, OWNER_SCOPE
from app.domain.spec_hash import compute_spec_hash
from app.repositories.quotations_repo import insert_quotation
from kaas_common.workstation.number_rules import (
    NumberError,
    build_number,
    normalize_number,
)
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no, lock_fx_rate,
    resolve_customer_for_doc,
)

router = APIRouter(prefix="/api/v1", tags=["quote-orders"])

# 状态机（§10.4）：draft → sent → accepted / rejected / expired
from kaas_common.workstation.state_machines import QUOTE_NEXT as ORDER_NEXT  # noqa: E402

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
    # 内部分解快照（成本/利润）——签发/保存时从算价引擎 internal 视图带来；
    # 仅 internal 账号可读（出口剔除），customer 视角本字段不存在
    cost_breakdown: Optional[dict] = None


class QuoteOrderCreate(BaseModel):
    # 业务客户外键（整数）：必须从**已有业务客户**里选，后端强校验（2026-10-11）。
    # 以前是自由文本，脏值导致客户详情页聚合不出该客户的报价单。
    customer_id: Optional[int] = None
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
    # ── 202610100003 订单/运输补字段 ──
    destination_country: Optional[str] = None
    destination_region: Optional[str] = None
    carrier: Optional[str] = None
    freight_valid_from: Optional[str] = None
    freight_valid_to: Optional[str] = None


class QuoteOrderPatch(BaseModel):
    # 报价单号：仅在还没有生成 PI/合同等后续单证时可改（前端二次确认）
    quote_no: Optional[str] = None
    # 改单时也能换客户（历史单据的 customer_id 被清洗成 NULL 后要能人工认领回来）
    customer_id: Optional[int] = None
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
    destination_country: Optional[str] = None
    destination_region: Optional[str] = None
    carrier: Optional[str] = None
    freight_valid_from: Optional[str] = None
    freight_valid_to: Optional[str] = None


class QuoteItemsReplace(BaseModel):
    items: List[QuoteItemIn]


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _quote_no_editable(db, tenant_id: str, quote_id: int) -> bool:
    """报价单号是否可改：还没生成后续单证（PI/合同等）或订单时才可以。

    报价单自身自动生成的 `quotation` 单证不算下游（用户口径：生成报价单后仍可改，
    生成 PI 之后才锁定）。
    """
    from app.db.workstation_links import Order, TradeDoc
    downstream_doc = (await db.execute(
        select(TradeDoc.id).where(
            TradeDoc.tenant_id == tenant_id,
            TradeDoc.quote_id == quote_id,
            TradeDoc.doc_type != "quotation",
        ).limit(1)
    )).scalar_one_or_none()
    if downstream_doc is not None:
        return False
    downstream_order = (await db.execute(
        select(Order.id).where(
            Order.tenant_id == tenant_id,
            Order.quote_id == quote_id,
        ).limit(1)
    )).scalar_one_or_none()
    return downstream_order is None


async def _quote_no_editable_map(db, tenant_id: str, quote_ids: list[int]) -> set[int]:
    """批量版：返回可改号的报价单 id 集合。"""
    ids = [i for i in quote_ids if i is not None]
    if not ids:
        return set()
    from app.db.workstation_links import Order, TradeDoc
    locked: set[int] = set()
    rows = (await db.execute(
        select(TradeDoc.quote_id).where(
            TradeDoc.tenant_id == tenant_id,
            TradeDoc.quote_id.in_(ids),
            TradeDoc.doc_type != "quotation",
        ).distinct()
    )).scalars().all()
    locked.update(int(x) for x in rows if x is not None)
    rows = (await db.execute(
        select(Order.quote_id).where(
            Order.tenant_id == tenant_id,
            Order.quote_id.in_(ids),
        ).distinct()
    )).scalars().all()
    locked.update(int(x) for x in rows if x is not None)
    return set(ids) - locked


def _row_to_quote(q: QuoteOrder, item_count: int = 0) -> dict:
    from kaas_common.workstation.quote_serializers import row_to_quote
    return row_to_quote(q, item_count)


def _row_to_item(it: QuoteOrderItem, auth: AuthContext | None = None) -> dict:
    from kaas_common.workstation.quote_serializers import row_to_item

    d = row_to_item(it)
    # 内外视图红线（UNCERTAIN #19）：成本分解只对平台员工透出，
    # customer 账号在**接口层**就剥掉，不靠前端隐藏。
    if auth is None or auth.account_type != "internal":
        d.pop("cost_breakdown", None)
    return d


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
            cost_breakdown=row.cost_breakdown,
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


def _date_or_none(value: Optional[str]):
    """ISO 字符串 → date（DATE 列用；空 → None）。"""
    dt = _parse_dt(value)
    return dt.date() if dt is not None else None


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
        session=db, tenant_id=q.tenant_id,
        # 报价记录台账（quotations）的 customer_id **仍是 TEXT**（历史设计，本次不动），
        # 而报价单的 customer_id 已改成 BIGINT（202610110009）—— 不转字符串的话
        # asyncpg 会因为"整数参数写进 text 列"直接报错，签发报价单就失败了。
        customer_id=str(q.customer_id),
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
    customer_id: Optional[int] = None,
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
    editable_ids = await _quote_no_editable_map(db, tenant_id, [q.id for q in rows])
    return {
        "items": [
            {**_row_to_quote(q, counts.get(q.id, 0)),
             "quote_no_editable": q.id in editable_ids}
            for q in rows
        ],
        "total": total, "page": page, "page_size": page_size,
    }


async def _next_quote_no(db, tenant_id: str, customer) -> str:
    """报价单号：`QUO-国家-客户-时间戳`（同秒冲突加后缀）。"""
    for suffix in range(1, 21):
        candidate = build_number("quotation", customer, suffix=suffix)
        exists = (await db.execute(
            select(QuoteOrder.id).where(
                QuoteOrder.tenant_id == tenant_id,
                QuoteOrder.quote_no == candidate,
            ).limit(1)
        )).scalar_one_or_none()
        if exists is None:
            return candidate
    return build_number("quotation", customer) + "-X"


async def _next_inquiry_no(db, tenant_id: str, customer) -> str:
    """询盘号：`INQ-国家-客户-时间戳`（报价页自动建询盘时使用）。"""
    for suffix in range(1, 21):
        candidate = build_number("inquiry", customer, suffix=suffix)
        exists = (await db.execute(
            select(CustInquiry.id).where(
                CustInquiry.tenant_id == tenant_id,
                CustInquiry.inquiry_no == candidate,
            ).limit(1)
        )).scalar_one_or_none()
        if exists is None:
            return candidate
    return build_number("inquiry", customer) + "-X"


async def _resolve_or_create_inquiry(
    db, tenant_id: str, customer, auth: AuthContext,
    inquiry_id: Optional[int], items, owner_scope: str,
) -> int:
    """报价单的询盘来源：

    · 选了询盘 → 校验归属并把「未报价」自动推进为「已报价」（已关闭不自动改）；
    · 没选询盘 → **自动给这个客户建一条询盘**（用户口径：直接使用报价页生成
      报价时，不存在询盘就自动创建），状态直接落「已报价」。
    """
    if inquiry_id is not None:
        inq = (await db.execute(
            select(CustInquiry).where(
                CustInquiry.tenant_id == tenant_id,
                CustInquiry.id == inquiry_id,
                CustInquiry.customer_id == customer.id,
            )
        )).scalar_one_or_none()
        if inq is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "INQUIRY_NOT_FOUND",
                "detail": "所选询盘不存在或不属于该客户",
            })
    else:
        inq = CustInquiry(
            tenant_id=tenant_id, customer_id=customer.id,
            inquiry_no=await _next_inquiry_no(db, tenant_id, customer),
            channel="quote", status="unquoted",
            product_name_raw=(items[0].product_name if items else None),
            created_by=str(auth.user_id), owner_id=str(auth.user_id),
            owner_scope=owner_scope, team_id=customer.team_id or auth.team_id,
        )
        db.add(inq)
        await db.flush()
    # 报价事件联动：未报价 → 已报价；已关闭保持关闭（关闭只能手动重开）
    if inq.status == "unquoted":
        inq.status = "quoted"
    return inq.id


@router.post("/quotes", status_code=201)
async def create_quote_order(
    body: QuoteOrderCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    currency = validate_enum("currency", body.currency) or "USD"
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"

    # 业务客户强校验：不存在 / 已软删 / 别家团队 → 404 CUSTOMER_NOT_FOUND
    # 且**必填**：报价是业务链条的根（报价 → 订单 → 单证），没有客户就没法在客户页
    # 按客户聚合。与 worker 端同口径（缺 → 422 CUSTOMER_REQUIRED），两端必须一致。
    if body.customer_id is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CUSTOMER_REQUIRED",
            "detail": "创建报价必须选择业务客户",
        })
    customer = await resolve_customer_for_doc(db, tenant_id, body.customer_id, auth)

    items, total = _build_items(tenant_id, currency, body.items)
    # 空单也允许创建（工作台"先建单、再逐行加产品"的自然用法），
    # 但合计留空而不是 0 —— 0 会被当成"报过价、价是 0"。
    inquiry_id = await _resolve_or_create_inquiry(
        db, tenant_id, customer, auth, body.inquiry_id, items, owner_scope,
    )
    rate, rate_date = await lock_fx_rate(db, currency)
    q = QuoteOrder(
        tenant_id=tenant_id, quote_no=await _next_quote_no(db, tenant_id, customer),
        customer_id=customer.id if customer is not None else None,
        # 客户名快照：未显式传时按客户档案自动填（单据显示"开单当时的客户名"，
        # 客户日后改名不会回改历史单据）
        customer_name=body.customer_name or (customer.name if customer is not None else None),
        inquiry_id=inquiry_id,
        status="draft", currency=currency, total_amount=total if items else None,
        valid_until=_parse_dt(body.valid_until), notes=body.notes,
        fx_rate=rate, fx_rate_date=rate_date,
        created_by=str(auth.user_id),
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        # 单据与客户同团队：选了哪个团队的客户，单据就落哪个团队
        # （管理员可以替别家团队开单，此时不能把单据留在自己的团队）
        team_id=customer.team_id if customer is not None else auth.team_id,
        incoterm=body.incoterm, payment_terms=body.payment_terms,
        port_of_loading=body.port_of_loading,
        port_of_destination=body.port_of_destination,
        shipping_marks=body.shipping_marks,
        country_of_origin=body.country_of_origin,
        freight_valid_from=_date_or_none(body.freight_valid_from),
        freight_valid_to=_date_or_none(body.freight_valid_to),
    )
    db.add(q)
    await db.flush()  # 取 q.id 挂行项
    for it in items:
        it.quote_order_id = q.id
        db.add(it)
    await db.commit()
    await db.refresh(q)
    return _row_to_quote(q, len(items))


@router.get("/quotes/reference-price")
async def quote_reference_price(
    customer_id: int,
    product_name: str,
    spec: Optional[str] = None,
    days: int = Query(180, ge=1, le=730),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """历史参考价（UNCERTAIN #19 · 实时报价的回落参考）。

    聚合**同客户 + 同产品**近 N 天已落库报价行项的单价（可选再按
    `spec_snapshot` JSONB 语义相等做规格精确匹配）——无今日行情时给报价员的
    参考区间。可见范围与报价单列表同口径（`scope_filter`：自己 + 同团队，
    管理员全量）。
    """
    tenant_id = tenant_id_of(auth)
    stmt = (
        select(
            func.count().label("count"),
            func.avg(QuoteOrderItem.unit_price).label("avg"),
            func.min(QuoteOrderItem.unit_price).label("min"),
            func.max(QuoteOrderItem.unit_price).label("max"),
            func.percentile_cont(0.5)
            .within_group(QuoteOrderItem.unit_price)
            .label("median"),
            func.max(QuoteOrder.created_at).label("last_at"),
        )
        .select_from(QuoteOrderItem)
        .join(QuoteOrder, QuoteOrderItem.quote_order_id == QuoteOrder.id)
        .where(
            QuoteOrderItem.tenant_id == tenant_id,
            QuoteOrder.customer_id == customer_id,
            QuoteOrderItem.product_name == product_name,
            QuoteOrderItem.unit_price.isnot(None),
            QuoteOrder.created_at
            >= datetime.now(timezone.utc) - timedelta(days=days),
        )
    )
    if spec:
        try:
            spec_json = json.loads(spec)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=422,
                detail={"error": "validation_error", "message": "spec must be a JSON object"},
            )
        stmt = stmt.where(QuoteOrderItem.spec_snapshot == spec_json)
    stmt = scope_filter(stmt, QuoteOrder, auth)

    row = (await db.execute(stmt)).one()
    return {
        "customer_id": customer_id,
        "product_name": product_name,
        "days": days,
        "spec_matched": spec is not None,
        "count": row.count,
        "avg": float(row.avg) if row.avg is not None else None,
        "min": float(row.min) if row.min is not None else None,
        "max": float(row.max) if row.max is not None else None,
        "median": float(row.median) if row.median is not None else None,
        "last_at": row.last_at.isoformat() if row.last_at else None,
    }


@router.get("/quotes/cost-reference")
async def quote_cost_reference(
    product_key: str,
    spec: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """成本参考价 —— **直接从历史报价行项提取**，不再单独存成本历史表。

    用户 2026-10-18 裁决：历史报价本身就是成本历史；成本信息从
    `quote_order_items.cost_override + spec_snapshot`（含完整产品参数）提取即可。

    规则：
      1. 同产品 + **同规格参数**（`spec_snapshot.specs` JSONB 相等）→ 最近一次成本；
      2. 否则 → 近 30 天同产品所有手动成本的中位数；
      3. 都没有 → `reference=null`（回退产品定义里的成本）。
    """
    try:
        specs = json.loads(spec)
    except json.JSONDecodeError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_SPEC",
            "detail": "spec 必须是 JSON 对象",
        })
    if not isinstance(specs, dict):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_SPEC",
            "detail": "spec 必须是 JSON 对象",
        })

    tenant_id = tenant_id_of(auth)
    base = (
        select(QuoteOrderItem, QuoteOrder)
        .join(QuoteOrder, QuoteOrderItem.quote_order_id == QuoteOrder.id)
        .where(
            QuoteOrderItem.tenant_id == tenant_id,
            QuoteOrderItem.spec_snapshot["product_key"].astext == product_key,
            QuoteOrderItem.cost_override.isnot(None),
        )
    )
    base = scope_filter(base, QuoteOrder, auth)

    same = (await db.execute(
        base.where(QuoteOrderItem.spec_snapshot["specs"] == specs)
        .order_by(QuoteOrder.created_at.desc(), QuoteOrderItem.id.desc())
        .limit(1)
    )).first()
    if same is not None:
        item, quote = same
        snapshot = item.spec_snapshot or {}
        return {
            "reference": {
                "cost": float(item.cost_override),
                "cost_unit": snapshot.get("cost_unit") or "",
                "source": "latest",
                "sample_count": 1,
                "as_of": quote.created_at.isoformat() if quote.created_at else None,
                "quote_no": quote.quote_no,
                "spec_snapshot": snapshot,
            }
        }

    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    rows = (await db.execute(
        base.where(QuoteOrder.created_at >= cutoff)
        .order_by(QuoteOrder.created_at.desc(), QuoteOrderItem.id.desc())
    )).all()
    if not rows:
        return {"reference": None}
    costs = sorted(float(item.cost_override) for item, _ in rows)
    n = len(costs)
    median = costs[n // 2] if n % 2 else (costs[n // 2 - 1] + costs[n // 2]) / 2
    latest_item, latest_quote = rows[0]
    snapshot = latest_item.spec_snapshot or {}
    return {
        "reference": {
            "cost": median,
            "cost_unit": snapshot.get("cost_unit") or "",
            "source": "median_30d",
            "sample_count": n,
            "as_of": latest_quote.created_at.isoformat() if latest_quote.created_at else None,
            "quote_no": latest_quote.quote_no,
            "spec_snapshot": snapshot,
        }
    }


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
    payload["quote_no_editable"] = await _quote_no_editable(db, tenant_id, q.id)
    payload["items"] = [_row_to_item(i, auth) for i in items]
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

    if body.quote_no is not None and body.quote_no != q.quote_no:
        try:
            new_no = normalize_number(body.quote_no)
        except NumberError as exc:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "INVALID_QUOTE_NO",
                "detail": str(exc),
            })
        if not await _quote_no_editable(db, tenant_id, q.id):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "QUOTE_NO_LOCKED",
                "detail": "该报价已生成 PI/合同等后续单证（或已转订单），报价单号已锁定",
            })
        taken = (await db.execute(
            select(QuoteOrder.id).where(
                QuoteOrder.tenant_id == tenant_id,
                QuoteOrder.quote_no == new_no,
                QuoteOrder.id != q.id,
            ).limit(1)
        )).scalar_one_or_none()
        if taken is not None:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "QUOTE_NO_TAKEN",
                "detail": f"报价单号「{new_no}」已被占用，请换一个",
            })
        q.quote_no = new_no

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
    if body.customer_id is not None:
        # 换客户：同样走强校验；快照与团队一并跟着客户走
        customer = await resolve_customer_for_doc(db, tenant_id, body.customer_id, auth)
        q.customer_id = customer.id
        q.team_id = customer.team_id
        if body.customer_name is None:
            # 未显式给名字时按新客户档案刷新快照 —— 否则单据上还印着上一个客户名
            q.customer_name = customer.name
    for field in ("customer_name", "notes", "incoterm", "payment_terms",
                  "port_of_loading", "port_of_destination", "shipping_marks",
                  "country_of_origin"):
        value = getattr(body, field)
        if value is not None:
            setattr(q, field, value)
    if body.valid_until is not None:
        q.valid_until = _parse_dt(body.valid_until)
    if body.freight_valid_from is not None:
        q.freight_valid_from = _date_or_none(body.freight_valid_from)
    if body.freight_valid_to is not None:
        q.freight_valid_to = _date_or_none(body.freight_valid_to)

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
    await db.flush()
    # 空行集合 → 合计留空（不是 0）
    q.total_amount = total if items else None
    await db.commit()

    rows = await _items_of(db, tenant_id, q.id)
    return {"id": q.id, "total_amount": float(q.total_amount) if q.total_amount is not None else None,
            "items": [_row_to_item(i, auth) for i in rows]}
