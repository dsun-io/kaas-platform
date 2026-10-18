"""产品成本历史 API（需求 11）。

用户口径（2026-10-18）：
  · 产品成本**手动输入**；每次输入存该产品的成本历史；
  · 以后无法获取成本时，按历史算参考成本：
    同产品+同规格最近一次 → 近 30 天中位数 → 无参考；
  · 「定价数据」页面改为「成本历史」。

端点：
- GET  /api/v1/product-costs       列表 + 参考成本（按 product_key / spec_hash 过滤）
- POST /api/v1/product-costs       手工补录一条成本

写入路径（报价保存）由 `record_cost_history()` 统一处理，本文件同时导出。
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
from app.db.workstation_models import ProductCostHistory
from app.api.ws_common import tenant_id_of
from kaas_common.workstation.cost_rules import cost_spec_hash, reference_cost
from kaas_common.workstation.scope import is_admin_role

router = APIRouter(prefix="/api/v1", tags=["product-costs"])


class ProductCostIn(BaseModel):
    product_key: str
    spec_snapshot: Optional[dict] = None
    cost_pretax: float
    cost_incl: Optional[float] = None
    currency: str = "CNY"
    note: Optional[str] = None
    source: str = "manual"


def _row_out(row: ProductCostHistory) -> dict:
    return {
        "id": row.id,
        "product_key": row.product_key,
        "spec_snapshot": row.spec_snapshot,
        "spec_hash": row.spec_hash,
        "cost_pretax": float(row.cost_pretax),
        "cost_incl": float(row.cost_incl) if row.cost_incl is not None else None,
        "currency": row.currency,
        "source": row.source,
        "quote_order_id": row.quote_order_id,
        "note": row.note,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _team_filter(stmt, model, auth: AuthContext):
    """租户 + 本团队（未分组历史可读）；平台管理员看本租户全部。"""
    stmt = stmt.where(model.tenant_id == tenant_id_of(auth))
    if is_admin_role(auth.role):
        return stmt
    conds = [model.team_id.is_(None)]
    if getattr(auth, "team_id", None) is not None:
        conds.append(model.team_id == auth.team_id)
    return stmt.where(or_(*conds))


@router.get("/product-costs")
async def list_product_costs(
    product_key: Optional[str] = None,
    spec_hash: Optional[str] = None,
    limit: int = Query(50, ge=1, le=200),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    stmt = select(ProductCostHistory)
    stmt = _team_filter(stmt, ProductCostHistory, auth)
    if product_key:
        stmt = stmt.where(ProductCostHistory.product_key == product_key)
    rows = (await db.execute(
        stmt.order_by(ProductCostHistory.created_at.desc()).limit(200)
    )).scalars().all()
    ref = reference_cost(
        [_row_out(r) for r in rows], spec_hash=spec_hash,
    )
    items = [_row_out(r) for r in rows[:limit]]
    return {"items": items, "total": len(rows), "reference": ref}


@router.post("/product-costs", status_code=201)
async def create_product_cost(
    body: ProductCostIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    if body.cost_pretax is None or body.cost_pretax < 0:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_COST",
            "detail": "税前成本必须 ≥ 0",
        })
    product_key = (body.product_key or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "PRODUCT_REQUIRED",
            "detail": "必须指定产品",
        })
    spec_snapshot = body.spec_snapshot or {}
    row = ProductCostHistory(
        tenant_id=tenant_id_of(auth),
        team_id=getattr(auth, "team_id", None),
        product_key=product_key,
        spec_snapshot=spec_snapshot,
        spec_hash=cost_spec_hash(spec_snapshot),
        cost_pretax=body.cost_pretax,
        cost_incl=body.cost_incl,
        currency=body.currency or "CNY",
        source=body.source or "manual",
        note=body.note,
        created_by=str(auth.user_id),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_out(row)


async def record_cost_history(db: AsyncSession, tenant_id: str, team_id, items,
                              quote_order_id: int, created_by: str) -> int:
    """报价保存时把**手改过成本**的行写进成本历史（同单同规格同成本 1 小时内去重）。"""
    written = 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    for it in items or []:
        cost = getattr(it, "cost_override", None)
        if cost is None:
            continue
        snapshot = getattr(it, "spec_snapshot", None) or {}
        if not isinstance(snapshot, dict):
            continue
        product_key = snapshot.get("product_key")
        if not product_key:
            continue
        specs = snapshot.get("specs") or {}
        spec_hash = cost_spec_hash(specs)
        exists = (await db.execute(
            select(ProductCostHistory.id).where(
                ProductCostHistory.tenant_id == tenant_id,
                ProductCostHistory.product_key == product_key,
                ProductCostHistory.spec_hash == spec_hash,
                ProductCostHistory.cost_pretax == cost,
                ProductCostHistory.created_at >= cutoff,
            ).limit(1)
        )).scalar_one_or_none()
        if exists is not None:
            continue
        db.add(ProductCostHistory(
            tenant_id=tenant_id, team_id=team_id, product_key=product_key,
            spec_snapshot=snapshot.get("specs") or specs,
            spec_hash=spec_hash,
            cost_pretax=cost,
            currency="CNY",
            source="quote",
            quote_order_id=quote_order_id,
            created_by=created_by,
        ))
        written += 1
    return written
