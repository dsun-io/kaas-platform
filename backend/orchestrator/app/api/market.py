"""产品市场对照（market）工位 API。

定位：给业务一张「哪个地区买什么、当地怎么叫、走哪个港口」的对照表。
全部是**平台级参考数据**（地区×产品、品名本地化、用途、港口），不是租户私有账本。

为什么有这个文件
----------------
这套接口原先只有线上 Worker 实现（`backend/worker/src/main.py:660-750`），
orchestrator 里一条都没有 → 本地起 orchestrator 时 /market 页面 5 个请求全 404。
本文件是那套接口的 SQLAlchemy 移植版：**路径与返回结构必须与线上逐字一致**
（同一前端会连两个运行时），特别注意它们返回的是**裸数组**，不是 `{"items": [...]}`。

端点：
- GET  /api/v1/market/regions                        地区代码列表（["US-TX", ...]）
- GET  /api/v1/market/regions/{region_code}/products 该地区产品（含 specs 嵌套数组）
- GET  /api/v1/market/name-lookup?q=&region_code=    品名/别名反查
- POST /api/v1/market/name-mappings                  新增品名对照（前端暂未用）
- GET  /api/v1/market/usages                         用途字典
- GET  /api/v1/market/ports?country_code=&port_type= 港口档案

数据可见性（与线上的一处**有意差异**）
------------------------------------
线上 Worker 固定用 tenant_id='default' 查询，所有租户共享同一份参考数据。
本实现按「本租户 + 平台级 default」取数：租户可以覆盖自己的数据，
同时仍然看得到平台 seed 的数据（`backend/.tools/seed_ports.py` 就是写进 default 的）。
在 default 租户下，行为与线上完全一致。

本工位**不受订阅门禁**（与线上一致）：入口挂在 /intel 工位内部，靠 adminOnly 控制。
"""
from typing import List, Optional

import structlog
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy import distinct, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.ws_common import DEFAULT_TENANT, tenant_id_of
from app.core.auth import AuthContext, get_auth_context
from app.db.market_models import (
    MarketPort, MarketProductNameMapping, MarketProductUsage,
    MarketRegionProduct, MarketRegionProductSpec,
)
from app.db.session import get_db_session

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1/market", tags=["market"])


def _tenant_scope(auth) -> tuple:
    """参考数据的可见范围：本租户 + 平台级 default。"""
    tid = tenant_id_of(auth)
    return (tid,) if tid == DEFAULT_TENANT else (tid, DEFAULT_TENANT)


def _dt(v):
    return v.isoformat() if v is not None else None


def _num(v):
    """Numeric → float：前端类型声明是 number。"""
    return float(v) if v is not None else None


def _mapping_to_dict(m: MarketProductNameMapping) -> dict:
    return {
        "id": m.id, "category_id": m.category_id,
        "region_code": m.region_code, "lang": m.lang,
        "local_name": m.local_name,
        # alt_names 必须是 **null 或数组**：前端有值即调 .map()
        "alt_names": m.alt_names,
        "hs_code": m.hs_code, "is_verified": m.is_verified,
        "confidence": m.confidence, "source": m.source,
        "created_at": _dt(m.created_at), "updated_at": _dt(m.updated_at),
    }


def _port_to_dict(p: MarketPort) -> dict:
    return {
        "id": p.id, "name_cn": p.name_cn, "name_en": p.name_en,
        "un_locode": p.un_locode, "country_code": p.country_code, "city": p.city,
        "lat": _num(p.lat), "lng": _num(p.lng),
        "port_type": p.port_type, "position_desc": p.position_desc,
        "characteristics": p.characteristics,
        "berth_depth_m": _num(p.berth_depth_m),
        "max_vessel_size": p.max_vessel_size,
        "suitable_cargo": p.suitable_cargo,
        "suitable_shipping_modes": p.suitable_shipping_modes,
        "connected_corridors": p.connected_corridors,
        "throughput_rank": p.throughput_rank,
        "congestion_level": p.congestion_level,
        "major_carriers": p.major_carriers,
        "avg_dwell_days": _num(p.avg_dwell_days),
        "port_charges_level": p.port_charges_level,
    }


def _region_product_to_dict(r: MarketRegionProduct) -> dict:
    return {
        "id": r.id, "region_code": r.region_code, "category_id": r.category_id,
        "demand_level": r.demand_level, "popularity_rank": r.popularity_rank,
        "cert_requirements": r.cert_requirements, "standards": r.standards,
        "seasonality": r.seasonality,
        "source": r.source, "confidence": r.confidence,
    }


# ── Schemas ──────────────────────────────────────────────────────────────────

class NameMappingCreate(BaseModel):
    category_id: Optional[int] = None
    region_code: str
    lang: str
    local_name: str
    alt_names: Optional[List[str]] = None
    hs_code: Optional[str] = None
    source: str = "manual"
    confidence: Optional[str] = None
    is_verified: bool = False


# ── 端点（返回裸数组，与线上一致）────────────────────────────────────────────

@router.get("/regions", summary="地区代码列表")
async def list_regions(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    rows = (await db.execute(
        select(distinct(MarketRegionProduct.region_code))
        .where(MarketRegionProduct.tenant_id.in_(_tenant_scope(auth)))
        .order_by(MarketRegionProduct.region_code)
    )).scalars().all()
    return list(rows)


@router.get("/regions/{region_code}/products", summary="该地区的产品对照")
async def list_region_products(
    region_code: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """一个产品可能有多条规格，展平成多行后在 Python 侧聚回嵌套结构。

    `specs` **必须存在**（空数组也行）：前端直接取 `.length`。
    """
    rows = (await db.execute(
        select(MarketRegionProduct, MarketRegionProductSpec)
        .outerjoin(
            MarketRegionProductSpec,
            MarketRegionProductSpec.market_product_id == MarketRegionProduct.id,
        )
        .where(
            MarketRegionProduct.tenant_id.in_(_tenant_scope(auth)),
            MarketRegionProduct.region_code == region_code.upper(),
        )
        .order_by(MarketRegionProduct.popularity_rank.asc().nulls_last())
    )).all()

    products: dict = {}
    for region_product, spec in rows:
        item = products.get(region_product.id)
        if item is None:
            item = _region_product_to_dict(region_product)
            item["specs"] = []
            products[region_product.id] = item
        if spec is not None and spec.spec_key:
            item["specs"].append({
                "key": spec.spec_key, "value": spec.spec_value,
                "unit": spec.unit, "rank": spec.frequency_rank,
            })
    return list(products.values())


@router.get("/name-lookup", summary="品名 / 别名反查")
async def name_lookup(
    q: str = Query(..., min_length=1),
    region_code: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """`q` 同时匹配正式品名与别名数组。

    别名匹配沿用线上的 EXISTS 写法（`jsonb_array_elements_text`），
    语义与 Worker 完全一致；不用 `::text ILIKE` 是因为那会把 JSON 结构字符
    也纳入匹配，`"` 和 `[` 会造成误命中。
    """
    like = f"%{q}%"
    stmt = select(MarketProductNameMapping).where(
        MarketProductNameMapping.tenant_id.in_(_tenant_scope(auth)),
        or_(
            MarketProductNameMapping.local_name.ilike(like),
            text(
                "EXISTS (SELECT 1 FROM jsonb_array_elements_text("
                "COALESCE(market_product_name_mappings.alt_names, '[]'::jsonb)) AS t "
                "WHERE t ILIKE :alt_like)"
            ).bindparams(alt_like=like),
        ),
    )
    if region_code:
        stmt = stmt.where(
            MarketProductNameMapping.region_code == region_code.upper())
    stmt = stmt.order_by(
        MarketProductNameMapping.is_verified.desc(),
        MarketProductNameMapping.created_at.desc(),
    ).limit(50)

    rows = (await db.execute(stmt)).scalars().all()
    return [_mapping_to_dict(m) for m in rows]


@router.post("/name-mappings", status_code=status.HTTP_201_CREATED,
             summary="新增品名对照")
async def create_name_mapping(
    body: NameMappingCreate,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    row = MarketProductNameMapping(
        tenant_id=tenant_id_of(auth),
        category_id=body.category_id,
        region_code=body.region_code.upper(),
        lang=body.lang,
        local_name=body.local_name,
        alt_names=body.alt_names or [],
        hs_code=body.hs_code,
        source=body.source,
        confidence=body.confidence,
        is_verified=body.is_verified,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _mapping_to_dict(row)


@router.get("/usages", summary="产品用途字典")
async def list_usages(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    rows = (await db.execute(
        select(MarketProductUsage)
        .where(MarketProductUsage.tenant_id.in_(_tenant_scope(auth)))
        .order_by(MarketProductUsage.usage_code)
    )).scalars().all()
    return [
        {"id": u.id, "usage_code": u.usage_code,
         "usage_name": u.usage_name, "description": u.description}
        for u in rows
    ]


@router.get("/ports", summary="港口档案")
async def list_ports(
    country_code: Optional[str] = None,
    port_type: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    stmt = select(MarketPort).where(
        MarketPort.tenant_id.in_(_tenant_scope(auth)))
    if country_code:
        stmt = stmt.where(MarketPort.country_code == country_code.upper())
    if port_type:
        stmt = stmt.where(MarketPort.port_type == port_type)
    stmt = stmt.order_by(MarketPort.country_code, MarketPort.name_en)

    rows = (await db.execute(stmt)).scalars().all()
    return [_port_to_dict(p) for p in rows]
