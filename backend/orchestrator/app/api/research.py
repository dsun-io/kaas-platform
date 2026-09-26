"""市场调研工位 API（情报体系 · 微观）

流程：从「地图源」（线索池）产出中挑选有价值的数据 → 深化（品类/价格/能否供货）。
    · 挑选 = source_ref 指向 lead_candidates.id
    · 深化 = product_category / price_local / market_note / can_supply

为什么有这个文件
----------------
这套接口原先只有线上 Worker（`backend/worker/src/main.py` 挂载的 `chain.py`）实现了，
开发用的 orchestrator 一条都没有 → 本地起 orchestrator 时 /research 页面 8 个请求全 404。
本文件是那套接口的 **SQLAlchemy 移植版**：**路径、返回结构、错误码必须与线上逐字一致**，
因为同一个前端会连两个运行时（dev 连 orchestrator，prod 连 Worker）。

端点：
- GET    /api/v1/research/categories          可选品类（静态常量，**无门禁**）
- GET    /api/v1/research/products            调研集列表（筛选 + 分页）
- POST   /api/v1/research/products            手工录入 / 从线索挑选（201）
- GET    /api/v1/research/stats               按国家/品类聚合（前端统计卡片）
- PATCH  /api/v1/research/products/{id}       深化字段编辑
- DELETE /api/v1/research/products/{id}       从调研集移除（不动地图源线索）
- POST   /api/v1/research/from-leadgen        批量挑选（201，已挑过的跳过不报错）
- GET    /api/v1/research/runs                运行历史

两个容易漏的行为（前端依赖）：
1. 「挑选」与「批量挑选」都要往 `research_runs` 落一条记录
   （`config.action = "pick" / "from_leadgen"`）—— 前端「运行历史」按 `config.action` 渲染。
2. `can_supply` 是**三态**筛选：true / false / unknown(未填 → IS NULL)。
"""
import hashlib
from typing import List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.subs import require_research
from app.api.ws_common import check_write_access, scope_filter, tenant_id_of
from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
from app.db.workstation_models import LeadCandidate, ResearchProduct, ResearchRun

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["research"])

# ── 静态品类（与线上 Worker chain.py:1812 逐字一致，改这里必须同步改那边）──────
RESEARCH_CATEGORIES = [
    "chain_link_fence", "welded_mesh", "gabion", "temporary_fence",
    "security_fence", "farm_fence", "razor_wire", "hinge_joint_fence",
    "accessories", "other",
]

# 从线索挑选时复制的字段（产品 + 店铺信息）
_PICK_FIELDS = (
    "product_name", "product_name_cn", "product_image_url", "spec_raw",
    "spec_normalized", "country", "region", "city",
    "shop_name", "shop_type", "address", "phone", "email", "website",
    "link_url", "can_supply", "supply_notes", "source",
)

# 对外暴露的商品字段（不含 tenant_id / owner_id / owner_scope 这类内部字段）
_PRODUCT_FIELDS = (
    "id", "source_ref", "source",
    "product_name", "product_name_cn", "product_image_url",
    "spec_raw", "spec_normalized", "product_category",
    "country", "region", "city",
    "shop_name", "shop_type", "address", "phone", "email", "website", "link_url",
    "price_local", "price_currency", "market_note",
    "can_supply", "supply_notes", "research_status",
    "created_at", "updated_at",
)


def _dt(v):
    return v.isoformat() if v is not None else None


def _product_to_dict(row: ResearchProduct) -> dict:
    """ORM → 前端契约。

    `price_local` 是 Numeric，转 float 后再下发：前端类型声明是 number，
    交给 JSON 编码器自动处理会依赖实现细节，显式转换更稳。
    """
    out = {f: getattr(row, f, None) for f in _PRODUCT_FIELDS}
    if out.get("price_local") is not None:
        out["price_local"] = float(out["price_local"])
    out["created_at"] = _dt(out.get("created_at"))
    out["updated_at"] = _dt(out.get("updated_at"))
    return out


def _run_to_dict(row: ResearchRun) -> dict:
    """`created_at` 必须是 ISO 字符串：前端做 `created_at.slice(0, 19)`。"""
    return {
        "id": row.id,
        "config": row.config,
        "status": row.status,
        "leads_scanned": row.leads_scanned,
        "products_found": row.products_found,
        "products_kept": row.products_kept,
        "error": row.error,
        "started_at": _dt(row.started_at),
        "finished_at": _dt(row.finished_at),
        "created_at": _dt(row.created_at),
    }


def _config_hash(cfg: dict) -> str:
    """与线上同一套算法（tenant_id + config 去重键）。"""
    return hashlib.sha256(repr(sorted(cfg.items())).encode()).hexdigest()[:32]


def _new_run(tenant_id: str, cfg: dict, **counters) -> ResearchRun:
    """落一条运行记录。

    `tenant_id` 必须显式传入：`research_runs.tenant_id` 是 NOT NULL 且无默认值，
    漏传会在 INSERT 时报完整性错误（表现为 500）。
    """
    return ResearchRun(
        tenant_id=tenant_id,
        config=cfg, config_hash=_config_hash(cfg), status="succeeded", **counters
    )


# ── Schemas ──────────────────────────────────────────────────────────────────

class ResearchCreate(BaseModel):
    """手工录入，或从线索挑选（给 source_ref 时自动回填线索上的产品/店铺字段）。"""
    source_ref: Optional[int] = None
    source: Optional[str] = None
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    product_category: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    shop_name: Optional[str] = None
    shop_type: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    link_url: Optional[str] = None
    price_local: Optional[float] = None
    price_currency: Optional[str] = None
    market_note: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None


class ResearchPatch(BaseModel):
    """深化字段。

    注意：沿用线上语义 —— 只更新「传了且非 null」的字段。
    因此传 `null` 表示"不修改"，而不是"清空"。
    """
    product_name: Optional[str] = None
    product_name_cn: Optional[str] = None
    product_image_url: Optional[str] = None
    spec_raw: Optional[str] = None
    spec_normalized: Optional[dict] = None
    product_category: Optional[str] = None
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    shop_name: Optional[str] = None
    shop_type: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    link_url: Optional[str] = None
    price_local: Optional[float] = None
    price_currency: Optional[str] = None
    market_note: Optional[str] = None
    can_supply: Optional[bool] = None
    supply_notes: Optional[str] = None
    research_status: Optional[str] = None


class PickFromLeadgen(BaseModel):
    lead_ids: List[int]


# ── 端点 ─────────────────────────────────────────────────────────────────────

@router.get("/research/categories", summary="可选品类（静态）")
async def research_categories(
    auth: AuthContext = Depends(get_auth_context),
):
    """品类下拉。和线上一样**不走订阅门禁**（否则未订阅时页面连下拉都空）。"""
    return {"items": RESEARCH_CATEGORIES}


@router.get("/research/products", summary="调研集列表")
async def research_list(
    country: Optional[str] = None,
    city: Optional[str] = None,
    product_category: Optional[str] = None,
    can_supply: Optional[str] = Query(None, description="true / false / unknown"),
    research_status: Optional[str] = None,
    search: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(ResearchProduct).where(ResearchProduct.tenant_id == tenant_id)

    if country:
        stmt = stmt.where(ResearchProduct.country == country)
    if city:
        stmt = stmt.where(ResearchProduct.city == city)
    if product_category:
        stmt = stmt.where(ResearchProduct.product_category == product_category)
    if research_status:
        stmt = stmt.where(ResearchProduct.research_status == research_status)
    # 三态：unknown 表示"尚未判定"（字段为空）
    if can_supply == "true":
        stmt = stmt.where(ResearchProduct.can_supply.is_(True))
    elif can_supply == "false":
        stmt = stmt.where(ResearchProduct.can_supply.is_(False))
    elif can_supply == "unknown":
        stmt = stmt.where(ResearchProduct.can_supply.is_(None))
    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            ResearchProduct.product_name.ilike(like)
            | ResearchProduct.product_name_cn.ilike(like)
            | ResearchProduct.shop_name.ilike(like)
        )

    stmt = scope_filter(stmt, ResearchProduct, auth)
    total = (await db.execute(
        select(func.count()).select_from(stmt.subquery())
    )).scalar_one()
    rows = (await db.execute(
        stmt.order_by(ResearchProduct.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )).scalars().all()

    return {"items": [_product_to_dict(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@router.get("/research/stats", summary="按国家/品类聚合")
async def research_stats(
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    """前端统计卡片 + 国家下拉。

    返回的 `by_country` / `by_category` **必须是数组**：
    前端直接取 `.length`，为 undefined 时整页崩。
    """
    tenant_id = tenant_id_of(auth)
    base = select(ResearchProduct).where(ResearchProduct.tenant_id == tenant_id)

    total = (await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar_one()

    supply_yes = (await db.execute(
        select(func.count()).select_from(
            base.where(ResearchProduct.can_supply.is_(True)).subquery()
        )
    )).scalar_one()

    by_country_rows = (await db.execute(
        select(
            ResearchProduct.country.label("country"),
            func.count().label("total"),
            func.count().filter(ResearchProduct.can_supply.is_(True)).label("can_supply"),
        )
        .where(ResearchProduct.tenant_id == tenant_id,
               ResearchProduct.country.is_not(None))
        .group_by(ResearchProduct.country)
        .order_by(func.count().desc())
        .limit(50)
    )).all()

    # 品类聚合不在 SQL 里 coalesce：把同一个表达式再写一遍进 GROUP BY 会生成
    # **不同的绑定参数**，PostgreSQL 会认定「SELECT 的表达式没出现在 GROUP BY 里」
    # 而直接报错。按真实列分组，空品类在 Python 侧补 unclassified 更稳。
    by_category_rows = (await db.execute(
        select(
            ResearchProduct.product_category,
            func.count().label("total"),
        )
        .where(ResearchProduct.tenant_id == tenant_id)
        .group_by(ResearchProduct.product_category)
        .order_by(func.count().desc())
    )).all()

    return {
        "total": total,
        "can_supply_yes": supply_yes,
        "by_country": [
            {"country": r.country, "total": r.total, "can_supply": r.can_supply}
            for r in by_country_rows
        ],
        "by_category": [
            {"product_category": r.product_category or "unclassified",
             "total": r.total}
            for r in by_category_rows
        ],
    }


@router.post("/research/products", status_code=201, summary="手工录入 / 从线索挑选")
async def research_create(
    body: ResearchCreate,
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    data = body.model_dump(exclude_none=True)
    source_ref = data.pop("source_ref", None)

    if source_ref is not None:
        dup = (await db.execute(
            select(ResearchProduct.id).where(
                ResearchProduct.tenant_id == tenant_id,
                ResearchProduct.source_ref == source_ref,
            )
        )).scalar_one_or_none()
        if dup is not None:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "ALREADY_PICKED", "research_id": dup})

        lead = (await db.execute(
            select(LeadCandidate).where(
                LeadCandidate.id == source_ref,
                LeadCandidate.tenant_id == tenant_id,
            )
        )).scalar_one_or_none()
        if lead is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "LEAD_NOT_FOUND"})

        # 只回填「请求里没给」的字段，显式传入的值优先
        for f in _PICK_FIELDS:
            if data.get(f) is None and getattr(lead, f, None) is not None:
                data[f] = getattr(lead, f)
        data.setdefault("shop_name", lead.company_name)
        data["source_ref"] = source_ref
        if not data.get("source"):
            data["source"] = lead.source

    row = ResearchProduct(
        tenant_id=tenant_id, owner_id=str(auth.user_id), owner_scope="tenant", **data
    )
    db.add(row)
    db.add(_new_run(
        tenant_id,
        {"action": "pick", "source_ref": source_ref},
        leads_scanned=1 if source_ref is not None else 0,
        products_found=1, products_kept=1, created_by=str(auth.user_id),
    ))
    await db.commit()
    await db.refresh(row)
    return _product_to_dict(row)


@router.patch("/research/products/{research_id}", summary="深化字段编辑")
async def research_patch(
    research_id: int,
    body: ResearchPatch,
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    """含「能否提供」—— 这一项由**人**判定，不由 AI 推断。"""
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(
        select(ResearchProduct).where(
            ResearchProduct.id == research_id,
            ResearchProduct.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "RESEARCH_NOT_FOUND"})
    check_write_access(row, auth)

    for k, v in body.model_dump(exclude_none=True).items():
        if hasattr(row, k):
            setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _product_to_dict(row)


@router.delete("/research/products/{research_id}", summary="从调研集移除")
async def research_delete(
    research_id: int,
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    """只删本工位记录，**不动地图源线索**。"""
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(
        select(ResearchProduct).where(
            ResearchProduct.id == research_id,
            ResearchProduct.tenant_id == tenant_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "RESEARCH_NOT_FOUND"})
    check_write_access(row, auth)

    await db.execute(
        sa_delete(ResearchProduct).where(ResearchProduct.id == research_id)
    )
    await db.commit()
    return {"deleted": research_id}


@router.post("/research/from-leadgen", status_code=201, summary="从地图源批量挑选")
async def research_from_leadgen(
    body: PickFromLeadgen,
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    """已挑选过的**跳过而非报错** —— 批量操作里报错会让整批白做。"""
    if not body.lead_ids:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "EMPTY_SELECTION"})

    tenant_id = tenant_id_of(auth)
    leads = (await db.execute(
        select(LeadCandidate).where(
            LeadCandidate.tenant_id == tenant_id,
            LeadCandidate.id.in_(body.lead_ids),
        )
    )).scalars().all()

    picked = (await db.execute(
        select(ResearchProduct.source_ref).where(
            ResearchProduct.tenant_id == tenant_id,
            ResearchProduct.source_ref.in_([x.id for x in leads]),
        )
    )).scalars().all()
    picked_set = {x for x in picked if x is not None}

    created, skipped = 0, 0
    for lead in leads:
        if lead.id in picked_set:
            skipped += 1
            continue
        data = {f: getattr(lead, f) for f in _PICK_FIELDS
                if getattr(lead, f, None) is not None}
        data["shop_name"] = lead.company_name
        data["source_ref"] = lead.id
        db.add(ResearchProduct(
            tenant_id=tenant_id, owner_id=str(auth.user_id),
            owner_scope="tenant", **data,
        ))
        created += 1

    db.add(_new_run(
        tenant_id,
        {"action": "from_leadgen", "lead_ids": sorted(body.lead_ids)},
        leads_scanned=len(leads), products_found=len(leads), products_kept=created,
        created_by=str(auth.user_id),
    ))
    await db.commit()
    logger.info("research_picked_from_leadgen", created=created, skipped=skipped)
    return {"scanned": len(leads), "created": created, "skipped": skipped}


@router.get("/research/runs", summary="运行历史")
async def research_runs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(require_research),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    base = select(ResearchRun).where(ResearchRun.tenant_id == tenant_id)
    total = (await db.execute(
        select(func.count()).select_from(base.subquery())
    )).scalar_one()
    rows = (await db.execute(
        base.order_by(ResearchRun.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    )).scalars().all()
    return {"items": [_run_to_dict(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}
