"""自有出运台账 API（WORKSTATION_DESIGN.md §10.6 / §10.7）

区别于 intel_shipments（海关情报）。shipments 记我们自己的出运，
关键字段做快照冗余（客户名/收货人/货物），目标是查数据能还原当时具体情况。

端点：
- GET   /api/v1/shipments             出运列表（分页 + status 筛选 + 可见范围）
- POST  /api/v1/shipments             新建出运（SHP 单号；带 order_id 自动快照 + 关联）
- GET   /api/v1/shipments/{id}        出运详情
- PATCH /api/v1/shipments/{id}        更新字段 / 状态流转（booking→in_transit→arrived→customs→delivered）

出运后回写（§10.6）：order_shipment_refs 建关联；订单 producing → shipped。
"""
from typing import Optional
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_links import Order, OrderItem, OrderShipmentRef
from app.db.workstation_models import Shipment
from app.core.auth import AuthContext, get_auth_context
from app.domain.enums import validate_enum, SHIPMENT_STATUS, BL_TYPE, OWNER_SCOPE
from app.api.ws_common import (
    tenant_id_of, scope_filter, check_write_access, next_doc_no,
)
# 出运状态机真源：共享内核（Worker 的 ws_shipments.py 用同一份，杜绝「本地能流转、
# 线上 409」）。本模块原先自持一份 SHIPMENT_NEXT，2026-10-10 上收。
from kaas_common.workstation.state_machines import SHIPMENT_NEXT, can_transition

router = APIRouter(prefix="/api/v1", tags=["shipments"])


# ── Schemas ──────────────────────────────────────────────────────────────────

class ShipmentCreate(BaseModel):
    order_id: Optional[int] = None           # 关联订单（自动快照客户/货物 + 建关联）
    customer_id: Optional[int] = None
    consignee: Optional[str] = None
    notify_party: Optional[str] = None
    cargo_desc: Optional[str] = None
    cargo_qty: Optional[Decimal] = None
    cargo_qty_unit: Optional[str] = None
    cargo_weight_kg: Optional[Decimal] = None
    cargo_volume_cbm: Optional[Decimal] = None
    pol: Optional[str] = None
    pod: Optional[str] = None
    pol_name: Optional[str] = None
    pod_name: Optional[str] = None
    vessel: Optional[str] = None
    voyage: Optional[str] = None
    container_no: Optional[str] = None
    so_no: Optional[str] = None
    booking_no: Optional[str] = None
    bl_no: Optional[str] = None
    bl_type: Optional[str] = None            # original | telex | seaway
    etd: Optional[str] = None
    eta: Optional[str] = None
    atd: Optional[str] = None
    ata: Optional[str] = None
    freight_remark: Optional[str] = None
    owner_scope: str = "private"


class ShipmentPatch(BaseModel):
    consignee: Optional[str] = None
    notify_party: Optional[str] = None
    cargo_desc: Optional[str] = None
    bl_no: Optional[str] = None
    bl_type: Optional[str] = None
    etd: Optional[str] = None
    eta: Optional[str] = None
    atd: Optional[str] = None
    ata: Optional[str] = None
    vessel: Optional[str] = None
    voyage: Optional[str] = None
    container_no: Optional[str] = None
    so_no: Optional[str] = None
    booking_no: Optional[str] = None
    status: Optional[str] = None
    freight_remark: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_date(value: Optional[str]):
    from datetime import date
    return date.fromisoformat(value) if value else None


def _row_to_shipment(s: Shipment) -> dict:
    def f(v):
        return float(v) if v is not None else None
    return {
        "id": s.id, "shipment_no": s.shipment_no, "order_id": s.order_id,
        "customer_id": s.customer_id, "customer_name": s.customer_name,
        "consignee": s.consignee, "notify_party": s.notify_party,
        "cargo_desc": s.cargo_desc, "cargo_qty": f(s.cargo_qty),
        "cargo_qty_unit": s.cargo_qty_unit, "cargo_weight_kg": f(s.cargo_weight_kg),
        "cargo_volume_cbm": f(s.cargo_volume_cbm),
        "pol": s.pol, "pod": s.pod, "pol_name": s.pol_name, "pod_name": s.pod_name,
        "vessel": s.vessel, "voyage": s.voyage, "container_no": s.container_no,
        "so_no": s.so_no, "booking_no": s.booking_no, "bl_no": s.bl_no,
        "bl_type": s.bl_type,
        "etd": s.etd.isoformat() if s.etd else None,
        "eta": s.eta.isoformat() if s.eta else None,
        "atd": s.atd.isoformat() if s.atd else None,
        "ata": s.ata.isoformat() if s.ata else None,
        "status": s.status, "freight_remark": s.freight_remark,
        "created_at": s.created_at.isoformat() if s.created_at else None,
        "owner_id": s.owner_id, "owner_scope": s.owner_scope,
    }


async def _get_shipment_or_404(db, tenant_id, shipment_id, auth) -> Shipment:
    stmt = select(Shipment).where(
        Shipment.tenant_id == tenant_id, Shipment.id == shipment_id,
    )
    stmt = scope_filter(stmt, Shipment, auth)
    s = (await db.execute(stmt)).scalar_one_or_none()
    if s is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "SHIPMENT_NOT_FOUND"})
    return s


# ── 端点 ─────────────────────────────────────────────────────────────────────

@router.get("/shipments")
async def list_shipments(
    status: Optional[str] = None,
    order_id: Optional[int] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(Shipment).where(Shipment.tenant_id == tenant_id)
    if status:
        validate_enum("shipment_status", status)
        stmt = stmt.where(Shipment.status == status)
    if order_id:
        stmt = stmt.where(Shipment.order_id == order_id)
    stmt = scope_filter(stmt, Shipment, auth)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(Shipment.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_shipment(s) for s in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("/shipments", status_code=201)
async def create_shipment(
    body: ShipmentCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    owner_scope = validate_enum("owner_scope", body.owner_scope) or "private"
    bl_type = validate_enum("bl_type", body.bl_type) if body.bl_type else None

    customer_name = None
    order = None
    cargo_desc, cargo_qty, cargo_qty_unit = body.cargo_desc, body.cargo_qty, body.cargo_qty_unit

    if body.order_id is not None:
        stmt = select(Order).where(
            Order.tenant_id == tenant_id, Order.id == body.order_id,
        )
        stmt = scope_filter(stmt, Order, auth)
        order = (await db.execute(stmt)).scalar_one_or_none()
        if order is None:
            raise HTTPException(status_code=404, detail={"error": "not_found", "code": "ORDER_NOT_FOUND"})
        check_write_access(order, auth)
        customer_name = order.customer_name
        if cargo_desc is None or cargo_qty is None:
            # 货物快照：从订单行项汇总（未手动覆盖时）
            items = (await db.execute(
                select(OrderItem).where(
                    OrderItem.tenant_id == tenant_id, OrderItem.order_id == order.id,
                ).order_by(OrderItem.sort_order, OrderItem.id)
            )).scalars().all()
            if cargo_desc is None:
                names = [i.product_name for i in items if i.product_name]
                cargo_desc = ", ".join(names) if names else None
            if cargo_qty is None:
                total_qty = sum((i.qty for i in items if i.qty is not None), Decimal("0"))
                cargo_qty = total_qty if items else None
                if cargo_qty_unit is None and items:
                    cargo_qty_unit = items[0].qty_unit

    s = Shipment(
        tenant_id=tenant_id, shipment_no=await next_doc_no(db, tenant_id, "shipment"),
        order_id=body.order_id, customer_id=body.customer_id,
        customer_name=customer_name,
        consignee=body.consignee, notify_party=body.notify_party,
        cargo_desc=cargo_desc, cargo_qty=cargo_qty, cargo_qty_unit=cargo_qty_unit,
        cargo_weight_kg=body.cargo_weight_kg, cargo_volume_cbm=body.cargo_volume_cbm,
        pol=body.pol, pod=body.pod, pol_name=body.pol_name, pod_name=body.pod_name,
        vessel=body.vessel, voyage=body.voyage, container_no=body.container_no,
        so_no=body.so_no, booking_no=body.booking_no, bl_no=body.bl_no, bl_type=bl_type,
        etd=_parse_date(body.etd), eta=_parse_date(body.eta),
        atd=_parse_date(body.atd), ata=_parse_date(body.ata),
        status="booking", freight_remark=body.freight_remark,
        owner_id=str(auth.user_id), owner_scope=owner_scope,
        team_id=auth.team_id,
    )
    db.add(s)
    await db.flush()

    if order is not None:
        # §10.6 回写：订单↔出运关联；producing → shipped
        db.add(OrderShipmentRef(
            tenant_id=tenant_id, order_id=order.id, shipment_id=s.id,
            ref_type="actual_shipment",
        ))
        if order.status == "producing":
            order.status = "shipped"

    await db.commit()
    await db.refresh(s)
    return _row_to_shipment(s)


@router.get("/shipments/{shipment_id}")
async def get_shipment(
    shipment_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    s = await _get_shipment_or_404(db, tenant_id, shipment_id, auth)
    return _row_to_shipment(s)


@router.patch("/shipments/{shipment_id}")
async def update_shipment(
    shipment_id: int,
    body: ShipmentPatch,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    s = await _get_shipment_or_404(db, tenant_id, shipment_id, auth)
    check_write_access(s, auth)

    for field in ("consignee", "notify_party", "cargo_desc", "bl_no", "vessel",
                  "voyage", "container_no", "so_no", "booking_no", "freight_remark"):
        value = getattr(body, field)
        if value is not None:
            setattr(s, field, value)
    for field in ("etd", "eta", "atd", "ata"):
        value = getattr(body, field)
        if value is not None:
            setattr(s, field, _parse_date(value))
    if body.bl_type is not None:
        s.bl_type = validate_enum("bl_type", body.bl_type)

    if body.status is not None:
        target = validate_enum("shipment_status", body.status)
        if not can_transition("shipment", s.status, target):
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ILLEGAL_TRANSITION",
                "field": "status", "from": s.status, "to": target,
                "allowed": list(SHIPMENT_NEXT.get(s.status, ())),
            })
        s.status = target

    await db.commit()
    await db.refresh(s)
    return _row_to_shipment(s)

