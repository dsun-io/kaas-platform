"""Intel Workstation API — 商情雷达进出口数据端点"""
from typing import Optional, List
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile, File
from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import (
    IntelShipment, IntelEntity, IntelProductCategory,
    IntelSource, IntelTradeStat, IntelDataChannel,
    IntelAdapterRun, IntelKeywordRule, IntelMatch,
)
from app.core.permissions import require_permission
from app.core.auth import AuthContext, get_auth_context
from app.services.intel.comtrade_collector import ComtradeCollector
from app.services.intel.shipment_importer import ShipmentImporter

router = APIRouter(prefix="/api/v1/intel", tags=["intel"])


# ── Schemas ──

from pydantic import BaseModel


class IntelShipmentCreate(BaseModel):
    shipper: str
    ship_date: Optional[datetime] = None
    carrier: Optional[str] = None
    notify_party: Optional[str] = None
    origin_port: Optional[str] = None
    origin_country: Optional[str] = None
    dest_port: Optional[str] = None
    dest_country: Optional[str] = None
    consignee: str
    product_desc: str
    product_desc_norm: Optional[str] = None
    hs_code: Optional[str] = None
    category_id: Optional[int] = None
    qty: Optional[float] = None
    qty_unit: Optional[str] = None
    gross_weight_kg: Optional[float] = None
    net_weight_kg: Optional[float] = None
    volume_cbm: Optional[float] = None
    container_no: Optional[str] = None
    container_type: Optional[str] = None
    bl_no: Optional[str] = None
    voyage_no: Optional[str] = None
    declared_value: Optional[float] = None
    currency: Optional[str] = None
    marks: Optional[str] = None
    remarks: Optional[str] = None
    shipment_type: Optional[str] = None
    incoterm: Optional[str] = None
    freight_prepaid: Optional[bool] = None
    source_channel: str = "manual_excel"
    source_ref: Optional[str] = None
    raw_data: Optional[dict] = None


class IntelShipmentResponse(BaseModel):
    id: int
    tenant_id: str
    shipper: str
    ship_date: Optional[datetime]
    carrier: Optional[str]
    notify_party: Optional[str]
    origin_port: Optional[str]
    origin_country: Optional[str]
    dest_port: Optional[str]
    dest_country: Optional[str]
    consignee: str
    product_desc: str
    product_desc_norm: Optional[str]
    hs_code: Optional[str]
    category_id: Optional[int]
    qty: Optional[float]
    qty_unit: Optional[str]
    gross_weight_kg: Optional[float]
    net_weight_kg: Optional[float]
    volume_cbm: Optional[float]
    container_no: Optional[str]
    container_type: Optional[str]
    bl_no: Optional[str]
    voyage_no: Optional[str]
    declared_value: Optional[float]
    currency: Optional[str]
    marks: Optional[str]
    remarks: Optional[str]
    shipment_type: Optional[str]
    incoterm: Optional[str]
    freight_prepaid: Optional[bool]
    source_channel: str
    source_ref: Optional[str]
    is_verified: bool
    created_by: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class IntelShipmentListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: List[IntelShipmentResponse]


class IntelTradeStatResponse(BaseModel):
    id: int
    hs_code: str
    period: str
    reporter_country: Optional[str]
    partner_country: str
    trade_flow: str
    qty: Optional[float]
    qty_unit: Optional[str]
    value_usd: Optional[float]

    class Config:
        from_attributes = True


class IntelAdapterRunResponse(BaseModel):
    id: int
    status: str
    started_at: datetime
    finished_at: Optional[datetime]
    items_processed: int
    items_inserted: int
    error_message: Optional[str]

    class Config:
        from_attributes = True


class ComtradeCollectRequest(BaseModel):
    reporter_country: str
    period: str  # YYYY-MM
    trade_flow: str = "import"


# ── Shipment Endpoints ──


@router.get("/shipments", response_model=IntelShipmentListResponse)
async def list_shipments(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    shipper: Optional[str] = None,
    consignee: Optional[str] = None,
    dest_country: Optional[str] = None,
    origin_country: Optional[str] = None,
    hs_code: Optional[str] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
):
    """列出进出口数据（支持筛选）"""
    await require_permission(request, "intel:shipments:read")

    query = select(IntelShipment).where(IntelShipment.tenant_id == auth.tenant_id)

    if shipper:
        query = query.where(IntelShipment.shipper.ilike(f"%{shipper}%"))
    if consignee:
        query = query.where(IntelShipment.consignee.ilike(f"%{consignee}%"))
    if dest_country:
        query = query.where(IntelShipment.dest_country.ilike(f"%{dest_country}%"))
    if origin_country:
        query = query.where(IntelShipment.origin_country.ilike(f"%{origin_country}%"))
    if hs_code:
        query = query.where(IntelShipment.hs_code.ilike(f"{hs_code}%"))
    if date_from:
        query = query.where(IntelShipment.ship_date >= date_from)
    if date_to:
        query = query.where(IntelShipment.ship_date <= date_to)

    # Count total
    count_query = select(func.count()).select_from(query.subquery())
    total = await db.scalar(count_query)

    # Paginate
    query = query.order_by(IntelShipment.ship_date.desc().nullslast())
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    items = result.scalars().all()

    return {
        "total": total or 0,
        "page": page,
        "page_size": page_size,
        "items": items,
    }


@router.get("/shipments/{shipment_id}", response_model=IntelShipmentResponse)
async def get_shipment(
    shipment_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """获取单条进出口数据详情"""
    await require_permission(request, "intel:shipments:read")

    result = await db.execute(
        select(IntelShipment).where(
            and_(
                IntelShipment.id == shipment_id,
                IntelShipment.tenant_id == auth.tenant_id,
            )
        )
    )
    shipment = result.scalar_one_or_none()
    if not shipment:
        raise HTTPException(status_code=404, detail="Shipment not found")
    return shipment


@router.post("/shipments", response_model=IntelShipmentResponse, status_code=201)
async def create_shipment(
    data: IntelShipmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """手动录入进出口数据"""
    await require_permission(request, "intel:shipments:write")

    shipment = IntelShipment(
        tenant_id=auth.tenant_id,
        shipper=data.shipper,
        ship_date=data.ship_date,
        carrier=data.carrier,
        notify_party=data.notify_party,
        origin_port=data.origin_port,
        origin_country=data.origin_country,
        dest_port=data.dest_port,
        dest_country=data.dest_country,
        consignee=data.consignee,
        product_desc=data.product_desc,
        product_desc_norm=data.product_desc_norm,
        hs_code=data.hs_code,
        category_id=data.category_id,
        qty=data.qty,
        qty_unit=data.qty_unit,
        gross_weight_kg=data.gross_weight_kg,
        net_weight_kg=data.net_weight_kg,
        volume_cbm=data.volume_cbm,
        container_no=data.container_no,
        container_type=data.container_type,
        bl_no=data.bl_no,
        voyage_no=data.voyage_no,
        declared_value=data.declared_value,
        currency=data.currency,
        marks=data.marks,
        remarks=data.remarks,
        shipment_type=data.shipment_type,
        incoterm=data.incoterm,
        freight_prepaid=data.freight_prepaid,
        source_channel=data.source_channel,
        source_ref=data.source_ref,
        raw_data=data.raw_data,
        created_by=str(auth.user_id),
    )
    db.add(shipment)
    await db.flush()
    await db.refresh(shipment)
    return shipment


# ── Import Endpoints ──


@router.post("/import/csv")
async def import_csv(
    request: Request,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """从 CSV 文件批量导入进出口数据"""
    await require_permission(request, "intel:shipments:write")

    content = await file.read()
    importer = ShipmentImporter(
        db=db,
        tenant_id=auth.tenant_id,
        created_by=str(auth.user_id),
    )

    result = await importer.import_csv(
        file_content=content,
        source_channel="manual_csv",
        source_ref=file.filename,
    )

    return result


# ── Trade Stats Endpoints ──


@router.get("/trade-stats", response_model=List[IntelTradeStatResponse])
async def list_trade_stats(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
    hs_code: Optional[str] = None,
    period: Optional[str] = None,
    partner_country: Optional[str] = None,
    trade_flow: Optional[str] = None,
    limit: int = Query(100, le=500),
):
    """列出贸易统计数据"""
    await require_permission(request, "intel:shipments:read")

    query = select(IntelTradeStat).where(IntelTradeStat.tenant_id == auth.tenant_id)

    if hs_code:
        query = query.where(IntelTradeStat.hs_code == hs_code)
    if period:
        query = query.where(IntelTradeStat.period == period)
    if partner_country:
        query = query.where(IntelTradeStat.partner_country.ilike(f"%{partner_country}%"))
    if trade_flow:
        query = query.where(IntelTradeStat.trade_flow == trade_flow)

    query = query.order_by(IntelTradeStat.period.desc()).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


@router.post("/collect/comtrade")
async def collect_comtrade(
    data: ComtradeCollectRequest,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """触发 UN Comtrade 数据采集"""
    await require_permission(request, "intel:shipments:write")

    collector = ComtradeCollector(db=db, tenant_id=auth.tenant_id)

    try:
        result = await collector.collect(
            reporter_country=data.reporter_country,
            period=data.period,
            trade_flow=data.trade_flow,
        )
        return result
    finally:
        await collector.close()


# ── Adapter Runs Endpoints ──


@router.get("/adapter-runs", response_model=List[IntelAdapterRunResponse])
async def list_adapter_runs(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
    status: Optional[str] = None,
    limit: int = Query(50, le=200),
):
    """列出采集任务运行日志"""
    await require_permission(request, "intel:shipments:read")

    query = select(IntelAdapterRun).where(IntelAdapterRun.tenant_id == auth.tenant_id)

    if status:
        query = query.where(IntelAdapterRun.status == status)

    query = query.order_by(IntelAdapterRun.started_at.desc()).limit(limit)
    result = await db.execute(query)
    return result.scalars().all()


# ── Data Channels Endpoints ──


@router.get("/channels")
async def list_channels(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """列出数据渠道（免费/付费）"""
    await require_permission(request, "intel:shipments:read")

    result = await db.execute(
        select(IntelDataChannel).where(IntelDataChannel.tenant_id == auth.tenant_id)
    )
    channels = result.scalars().all()

    # Return with frontend-friendly format
    return {
        "free_channels": [
            {
                "id": c.id,
                "name": c.name,
                "type": c.channel_type,
                "enabled": c.is_enabled,
            }
            for c in channels if c.tier == "free"
        ],
        "paid_channels": [
            {
                "id": c.id,
                "name": c.name,
                "type": c.channel_type,
                "enabled": c.is_enabled,
                "message": "未开通" if not c.is_enabled else "已开通",
            }
            for c in channels if c.tier == "paid"
        ],
    }
