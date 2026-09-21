"""客户开发工位 + 线索池 API（最终设计 §五；P2 开发工位 / P3 线索池）

流程（§5.2）：
    提交配置 → AI 校验（可关）→ 创建 run → 抓取 → 硬过滤 → AI 评分（可关）→ 写入线索池

端点：
- POST /api/v1/leadgen/validate        配置校验（AI 可关，纯本地检查降级）
- POST /api/v1/leadgen/runs            创建运行（异步执行抓取管线）
- GET  /api/v1/leadgen/runs            运行记录列表
- GET  /api/v1/leadgen/runs/{id}       运行详情
- POST /api/v1/leadgen/leads           手动录入线索（补漏/外部来源）
- GET  /api/v1/leads                   线索池列表（筛选/排序/分页 + 商情预留字段）
- GET  /api/v1/leads/{id}              线索详情（含触达/询盘历史时间线）
- PATCH /api/v1/leads/{id}             更新线索（owner=开发工位；outreach_status/inquiry_status 禁改）

抓取源（fetcher 注册表，可插拔）：
- demo：内置演示数据集（无外部依赖，标记 source='demo'，生产接 Google Places 后替换）
- csv：CSV 批量导入（沿用 intel 工位先例）

第一版口子（设计 §5.5）：商情排序返回 demand_index/blank_index=null 字段，
不阻塞主链路。
"""
import csv
import hashlib
import io
from datetime import datetime, timezone
from typing import List, Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import select, func, update

from app.db.session import get_db_session
from app.db.workstation_models import (
    LeadCandidate, LeadgenRun, IntelDemandIndex, CustInquiry,
)
from app.core.auth import AuthContext, get_auth_context
from app.services.ai_tasks import run_ai_task
from app.api.ws_common import tenant_id_of, scope_filter, check_write_access
from app.api.subs import require_leadgen

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1", tags=["leadgen"])

# ── 静态地区列表（§5.1 下拉）───────────────────────────────────────────────
REGIONS = [
    {"code": "US-TX", "name": "Texas, USA"}, {"code": "US-CA", "name": "California, USA"},
    {"code": "US-FL", "name": "Florida, USA"}, {"code": "US-NY", "name": "New York, USA"},
    {"code": "CA-ON", "name": "Ontario, Canada"}, {"code": "AU-NSW", "name": "NSW, Australia"},
    {"code": "GB-ENG", "name": "England, UK"}, {"code": "DE-NW", "name": "NRW, Germany"},
    {"code": "FR-IDF", "name": "Île-de-France, France"}, {"code": "AE-DU", "name": "Dubai, UAE"},
    {"code": "SA-RD", "name": "Riyadh, Saudi Arabia"}, {"code": "ZA-GP", "name": "Gauteng, South Africa"},
    {"code": "BR-SP", "name": "São Paulo, Brazil"}, {"code": "MX-CMX", "name": "CDMX, Mexico"},
]

# ── demo 抓取源（无外部依赖；接 Google Places 后注册新 fetcher 替换）────────
DEMO_DATASET = [
    ("Lone Star Fence Co", "US", "Texas", "Houston", "fencing contractor"),
    ("Gulf Coast Wire Mesh", "US", "Texas", "Galveston", "wire mesh distributor"),
    ("SunState Fencing", "US", "Florida", "Orlando", "fence installation"),
    ("Pacific Mesh Supply", "US", "California", "Fresno", "industrial mesh supplier"),
    ("Maple Fence Pro", "CA", "Ontario", "Toronto", "fence contractor"),
    ("Outback Fencing Pty", "AU", "NSW", "Newcastle", "rural fencing"),
    ("Thames Garden Fence", "GB", "England", "Reading", "garden fencing retail"),
    ("Rheinland Zaunbau", "DE", "NRW", "Düsseldorf", "zaunbau contractor"),
    ("Desert Fence LLC", "AE", "Dubai", "Dubai", "fencing supplier"),
    ("Muro Seguro SA", "MX", "CDMX", "Mexico City", "construction materials"),
    ("Highveld Fence Works", "ZA", "Gauteng", "Pretoria", "security fencing"),
    ("Samba Alambrado", "BR", "São Paulo", "Campinas", "alambrado distributor"),
]


async def _fetch_demo(config: dict) -> List[dict]:
    industry = (config.get("industry") or "").lower()
    qty = min(int(config.get("quantity") or 10), len(DEMO_DATASET))
    region = (config.get("region") or "").upper()
    leads = []
    for idx, (name, country, region_name, city, ind) in enumerate(DEMO_DATASET):
        if region and region_name.upper() not in region and region.split("-")[-1] not in region_name.upper():
            continue
        leads.append({
            "place_id": f"demo-{idx:04d}",
            "company_name": name, "country": country,
            "region": region_name, "city": city,
            "industry": industry or ind, "source": "demo",
            "email": f"contact@{name.lower().replace(' ', '')}.example.com",
            "website": f"https://{name.lower().replace(' ', '')}.example.com",
            "google_rating": round(3.5 + (idx % 15) / 10, 1),
            "google_reviews": 10 + idx * 7,
            "raw": {"demo": True, "dataset_index": idx},
        })
        if len(leads) >= qty:
            break
    return leads


async def _fetch_csv(content: bytes) -> List[dict]:
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    required = {"company_name", "country"}
    if not required.issubset(set(reader.fieldnames or [])):
        raise ValueError(f"CSV 需包含列：{sorted(required)}（可选：region/city/email/website/industry/place_id）")
    leads = []
    for i, row in enumerate(reader):
        leads.append({
            "place_id": (row.get("place_id") or "").strip() or None,
            "company_name": (row.get("company_name") or "").strip(),
            "country": (row.get("country") or "").strip(),
            "region": (row.get("region") or "").strip() or None,
            "city": (row.get("city") or "").strip() or None,
            "email": (row.get("email") or "").strip() or None,
            "website": (row.get("website") or "").strip() or None,
            "industry": (row.get("industry") or "").strip() or None,
            "source": "csv", "raw": {"csv_row": i + 1},
        })
        if not leads[-1]["company_name"]:
            leads.pop()
    return leads


FETCHERS = {"demo": _fetch_demo, "csv": _fetch_csv}


# ── 硬过滤规则（§5.2；AI 关闭时的评分也走这里）─────────────────────────────
def _hard_filter(leads: List[dict]) -> List[dict]:
    kept, seen = [], set()
    for lead in leads:
        name = (lead.get("company_name") or "").strip()
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        kept.append(lead)
    return kept


# ── Schemas ──────────────────────────────────────────────────────────────────

class LeadgenConfig(BaseModel):
    region: str
    industry: str
    icp: Optional[str] = None
    quantity: int = 10
    source: str = "demo"                 # demo | csv（后续 google_places）


class LeadCreate(BaseModel):
    company_name: str
    country: Optional[str] = None
    region: Optional[str] = None
    city: Optional[str] = None
    address: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    email: Optional[str] = None
    industry: Optional[str] = None
    place_id: Optional[str] = None
    opening_line: Optional[str] = None
    owner_scope: str = "private"


class LeadPatch(BaseModel):
    company_name: Optional[str] = None
    email: Optional[str] = None
    website: Optional[str] = None
    phone: Optional[str] = None
    industry: Optional[str] = None
    fit_score: Optional[int] = None
    opening_line: Optional[str] = None
    notes_raw: Optional[dict] = None     # 合并入 raw 字段
    owner_scope: Optional[str] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_lead(l: LeadCandidate) -> dict:
    return {
        "id": l.id, "place_id": l.place_id, "company_name": l.company_name,
        "country": l.country, "region": l.region, "city": l.city,
        "address": l.address, "phone": l.phone, "website": l.website,
        "email": l.email, "industry": l.industry, "source": l.source,
        "google_rating": float(l.google_rating) if l.google_rating is not None else None,
        "google_reviews": l.google_reviews,
        "fit_score": l.fit_score, "fit_reasons": l.fit_reasons,
        "opening_line": l.opening_line,
        "outreach_status": l.outreach_status, "inquiry_status": l.inquiry_status,
        "leadgen_run_id": l.leadgen_run_id,
        # P6 商情预留：数据接入前恒为 null（§5.5 接口返回 null 字段）
        "demand_index": None, "blank_index": None,
        "created_at": l.created_at.isoformat() if l.created_at else None,
        "owner_id": l.owner_id, "owner_scope": l.owner_scope,
    }


async def _get_lead_or_404(db, tenant_id, lead_id, auth) -> LeadCandidate:
    stmt = select(LeadCandidate).where(
        LeadCandidate.tenant_id == tenant_id, LeadCandidate.id == lead_id)
    stmt = scope_filter(stmt, LeadCandidate, auth)
    lead = (await db.execute(stmt)).scalar_one_or_none()
    if lead is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "LEAD_NOT_FOUND"})
    return lead


async def _run_pipeline(db, tenant_id: str, run: LeadgenRun, csv_content: Optional[bytes]):
    """抓取管线：抓取 → 硬过滤 → AI 评分（可关）→ 写入线索池（place_id 幂等）。"""
    from sqlalchemy.dialects.postgresql import insert as pg_insert
    config = dict(run.config)
    source = config.get("source", "demo")
    try:
        fetcher = FETCHERS.get(source)
        if fetcher is None:
            raise ValueError(f"未知抓取源：{source}")
        raw_leads = await fetcher(csv_content) if source == "csv" else await fetcher(config)
        kept = _hard_filter(raw_leads)

        scored = []
        for lead in kept:
            # AI 评分（可关，未启用走硬规则模板）；失败不阻塞，fit_score 可空
            try:
                outcome = await run_ai_task(db, tenant_id, "lead_scoring", lead)
                result = outcome["result"]
                lead["fit_score"] = result.get("fit_score")
                lead["fit_reasons"] = result.get("reasons")
            except Exception as e:
                logger.warning("lead_scoring_failed", error=str(e))
            # 开场白（AI 可关模板兜底）
            try:
                outcome = await run_ai_task(db, tenant_id, "opening_line", lead)
                lead["opening_line"] = outcome["result"].get("opening_line")
            except Exception as e:
                logger.warning("opening_line_failed", error=str(e))
            scored.append(lead)

        inserted = 0
        for lead in scored:
            row = pg_insert(LeadCandidate).values(
                tenant_id=tenant_id,
                place_id=lead.get("place_id"),
                company_name=lead["company_name"],
                country=lead.get("country"), region=lead.get("region"),
                city=lead.get("city"), address=lead.get("address"),
                phone=lead.get("phone"), website=lead.get("website"),
                email=lead.get("email"), industry=lead.get("industry"),
                source=lead.get("source"),
                google_rating=lead.get("google_rating"),
                google_reviews=lead.get("google_reviews"),
                fit_score=lead.get("fit_score"),
                fit_reasons=lead.get("fit_reasons"),
                opening_line=lead.get("opening_line"),
                leadgen_run_id=run.id, raw=lead.get("raw"),
                owner_id=run.created_by, owner_scope="tenant",  # 线索池全员共享
            ).on_conflict_do_nothing(
                index_elements=["tenant_id", "place_id"]
            ).returning(LeadCandidate.id)
            if (await db.execute(row)).first() is not None:
                inserted += 1

        run.status = "succeeded"
        run.leads_found = len(raw_leads)
        run.leads_kept = inserted
    except Exception as e:
        run.status = "failed"
        run.error = str(e)[:1000]
        logger.error("leadgen_run_failed", run_id=run.id, error=str(e))
    finally:
        run.finished_at = datetime.now(timezone.utc)
        await db.commit()


# ── 配置校验 ─────────────────────────────────────────────────────────────────

@router.post("/leadgen/validate")
async def validate_config(
    body: LeadgenConfig,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """AI 校验（任务绑定可关，关则纯本地格式检查）。"""
    tenant_id = tenant_id_of(auth)
    local = await run_ai_task(db, tenant_id, "config_validation", body.model_dump())
    return local


# ── 运行记录 ─────────────────────────────────────────────────────────────────

@router.post("/leadgen/runs", status_code=201)
async def create_run(
    body: LeadgenConfig,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """触发一次抓取（JSON，source != csv）。"""
    return await _create_run_common(body, None, auth, db)


@router.post("/leadgen/runs/from-csv", status_code=201)
async def create_run_csv(
    csv_file: UploadFile = File(...),
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """CSV 导入式抓取（multipart）。"""
    config = {"region": "", "industry": "", "icp": None,
              "quantity": 0, "source": "csv",
              "filename": csv_file.filename or "leads.csv"}
    csv_content = await csv_file.read()
    return await _create_run_common(LeadgenConfig(**config), csv_content, auth, db)


async def _create_run_common(
    body: LeadgenConfig,
    csv_content: Optional[bytes],
    auth: AuthContext,
    db: AsyncSession,
) -> dict:
    if body.source == "csv" and csv_content is None:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "CSV_REQUIRED",
            "detail": "source=csv 需上传 CSV 文件（POST /leadgen/runs/from-csv）"})
    config = body.model_dump()
    config_hash = hashlib.sha256(
        repr(sorted(config.items())).encode()).hexdigest()[:32]

    # 幂等：同 config 已有 run（任意状态，config_hash 唯一约束保证）直接返回
    existing = (await db.execute(
        select(LeadgenRun).where(
            LeadgenRun.tenant_id == tenant_id_of(auth),
            LeadgenRun.config_hash == config_hash,
        )
    )).scalar_one_or_none()
    if existing is not None:
        await db.refresh(existing)
        return {"id": existing.id, "status": existing.status,
                "leads_found": existing.leads_found,
                "leads_kept": existing.leads_kept,
                "error": existing.error, "deduplicated": True}

    run = LeadgenRun(
        tenant_id=tenant_id_of(auth), config=config, config_hash=config_hash,
        status="running", started_at=datetime.now(timezone.utc),
        created_by=str(auth.user_id),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)

    await _run_pipeline(db, tenant_id_of(auth), run, csv_content)
    await db.refresh(run)
    return {
        "id": run.id, "status": run.status, "config_hash": config_hash,
        "leads_found": run.leads_found, "leads_kept": run.leads_kept,
        "error": run.error, "deduplicated": False,
    }


@router.get("/leadgen/runs")
async def list_runs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    stmt = select(LeadgenRun).where(LeadgenRun.tenant_id == tenant_id)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    stmt = stmt.order_by(LeadgenRun.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [{
        "id": r.id, "config": r.config, "status": r.status,
        "leads_found": r.leads_found, "leads_kept": r.leads_kept,
        "error": r.error,
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    } for r in rows], "total": total, "page": page, "page_size": page_size}


@router.get("/leadgen/runs/{run_id}")
async def get_run(
    run_id: int,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    run = (await db.execute(
        select(LeadgenRun).where(
            LeadgenRun.tenant_id == tenant_id, LeadgenRun.id == run_id)
    )).scalar_one_or_none()
    if run is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "RUN_NOT_FOUND"})
    leads = (await db.execute(
        select(LeadCandidate).where(
            LeadCandidate.tenant_id == tenant_id,
            LeadCandidate.leadgen_run_id == run.id,
        ).order_by(LeadCandidate.fit_score.desc().nullslast())
    )).scalars().all()
    return {
        "id": run.id, "config": run.config, "status": run.status,
        "leads_found": run.leads_found, "leads_kept": run.leads_kept,
        "error": run.error,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "leads": [_row_to_lead(l) for l in leads],
    }


# ── 线索池 ───────────────────────────────────────────────────────────────────

@router.post("/leads/scan-replied")
async def scan_replied(
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """P5 询盘接入：手动触发扫描（定时任务每 15 分钟自动跑）。"""
    from app.jobs.lead_scan import scan_replied_leads
    return await scan_replied_leads(db, tenant_id_of(auth))


@router.get("/leadgen/regions")
async def list_regions():
    return {"items": REGIONS}


@router.post("/leads", status_code=201)
async def create_lead(
    body: LeadCreate,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    if body.place_id:
        existing = (await db.execute(
            select(LeadCandidate).where(
                LeadCandidate.tenant_id == tenant_id,
                LeadCandidate.place_id == body.place_id)
        )).scalar_one_or_none()
        if existing is not None:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DUPLICATE_PLACE",
                "detail": f"place_id 已存在（lead#{existing.id}）"})
    lead = LeadCandidate(
        tenant_id=tenant_id, place_id=body.place_id,
        company_name=body.company_name, country=body.country,
        region=body.region, city=body.city, address=body.address,
        phone=body.phone, website=body.website, email=body.email,
        industry=body.industry, source="manual",
        opening_line=body.opening_line,
        owner_id=str(auth.user_id),
        owner_scope="tenant",
    )
    db.add(lead)
    await db.commit()
    await db.refresh(lead)
    return _row_to_lead(lead)


@router.get("/leads")
async def list_leads(
    outreach_status: Optional[str] = None,
    inquiry_status: Optional[str] = None,
    search: Optional[str] = None,
    min_score: Optional[int] = Query(None, ge=0, le=100),
    sort: str = Query("score", pattern="^(score|recent|name)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """线索池列表。P6 商情排序口子：sort=score 时若商情数据就绪可按 blank_index
    排序——当前 intel_demand_index 为空，等价 fit_score 排序（§5.5 布局预留）。"""
    tenant_id = tenant_id_of(auth)
    stmt = select(LeadCandidate).where(LeadCandidate.tenant_id == tenant_id)
    if outreach_status:
        stmt = stmt.where(LeadCandidate.outreach_status == outreach_status)
    if inquiry_status:
        stmt = stmt.where(LeadCandidate.inquiry_status == inquiry_status)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(func.lower(LeadCandidate.company_name).like(func.lower(like)))
    if min_score is not None:
        stmt = stmt.where(LeadCandidate.fit_score >= min_score)
    stmt = scope_filter(stmt, LeadCandidate, auth)
    total = (await db.execute(select(func.count()).select_from(stmt.subquery()))).scalar_one()
    if sort == "recent":
        stmt = stmt.order_by(LeadCandidate.created_at.desc())
    elif sort == "name":
        stmt = stmt.order_by(LeadCandidate.company_name)
    else:
        stmt = stmt.order_by(LeadCandidate.fit_score.desc().nullslast(),
                             LeadCandidate.created_at.desc())
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)
    rows = (await db.execute(stmt)).scalars().all()
    return {"items": [_row_to_lead(l) for l in rows],
            "total": total, "page": page, "page_size": page_size}


@router.get("/leads/{lead_id}")
async def get_lead(
    lead_id: int,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    tenant_id = tenant_id_of(auth)
    lead = await _get_lead_or_404(db, tenant_id, lead_id, auth)
    # 触达历史（触达工位写入，本工位只读）
    from app.db.workstation_models import OutreachMessage
    messages = (await db.execute(
        select(OutreachMessage).where(
            OutreachMessage.tenant_id == tenant_id,
            OutreachMessage.lead_id == lead.id,
        ).order_by(OutreachMessage.created_at.desc())
    )).scalars().all()
    # 询盘历史（询盘工位写入，本工位只读）
    inquiries = (await db.execute(
        select(CustInquiry).where(
            CustInquiry.tenant_id == tenant_id, CustInquiry.lead_id == lead.id,
        ).order_by(CustInquiry.created_at.desc())
    )).scalars().all()
    return {
        **_row_to_lead(lead),
        "outreach_history": [{
            "id": m.id, "subject": m.subject, "status": m.status,
            "sent_at": m.sent_at.isoformat() if m.sent_at else None,
        } for m in messages],
        "inquiry_history": [{
            "id": i.id, "status": i.status, "channel": i.channel,
            "created_at": i.created_at.isoformat() if i.created_at else None,
        } for i in inquiries],
    }


@router.patch("/leads/{lead_id}")
async def update_lead(
    lead_id: int,
    body: LeadPatch,
    auth: AuthContext = Depends(require_leadgen),
    db: AsyncSession = Depends(get_db_session),
):
    """线索池 owner=开发工位。outreach_status / inquiry_status 是其他工位
    的写入接口，本端点拒绝修改（跨工位禁止写，§不变量）。"""
    tenant_id = tenant_id_of(auth)
    lead = await _get_lead_or_404(db, tenant_id, lead_id, auth)
    check_write_access(lead, auth)
    for field in ("company_name", "email", "website", "phone", "industry",
                  "fit_score", "opening_line"):
        value = getattr(body, field)
        if value is not None:
            setattr(lead, field, value)
    if body.owner_scope is not None:
        from app.domain.enums import validate_enum
        lead.owner_scope = validate_enum("owner_scope", body.owner_scope)
    if body.notes_raw is not None:
        merged = dict(lead.raw or {})
        merged.update(body.notes_raw)
        lead.raw = merged
    await db.commit()
    await db.refresh(lead)
    return _row_to_lead(lead)
