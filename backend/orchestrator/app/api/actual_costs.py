"""实际采购成本 API：录入/查询/换算单件↔总成本。

与报价计算链完全隔离：这里只服务「利润核算」，永不参与报价。
"""
from datetime import date
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.actual_cost import ActualProcurementCost, resolve_actual_unit_cost
from app.core.auth import AuthContext, get_auth_context

router = APIRouter(prefix="/api/v1", tags=["actual-costs"])


class ActualCostIn(BaseModel):
    product_key: str
    supplier_name: Optional[str] = None
    effective_from: Optional[str] = None
    effective_to: Optional[str] = None
    unit_cost_actual: Optional[float] = None
    total_cost_actual: Optional[float] = None
    qty_snapshot: Optional[float] = None
    qty_unit: Optional[str] = None
    cost_basis: str = "pretax"
    input_vat_rate_snapshot: Optional[float] = None
    currency: str = "CNY"
    notes: Optional[str] = None


class ActualCostOut(BaseModel):
    id: int
    product_key: str
    supplier_name: Optional[str]
    effective_from: Optional[str]
    effective_to: Optional[str]
    unit_cost_actual: Optional[float]
    total_cost_actual: Optional[float]
    qty_snapshot: Optional[float]
    qty_unit: Optional[str]
    cost_basis: str
    input_vat_rate_snapshot: Optional[float]
    currency: str
    notes: Optional[str]
    created_at: Optional[str]


def _row_to_out(r: ActualProcurementCost) -> ActualCostOut:
    return ActualCostOut(
        id=r.id,
        product_key=r.product_key,
        supplier_name=r.supplier_name,
        effective_from=r.effective_from.isoformat() if r.effective_from else None,
        effective_to=r.effective_to.isoformat() if r.effective_to else None,
        unit_cost_actual=float(r.unit_cost_actual) if r.unit_cost_actual is not None else None,
        total_cost_actual=float(r.total_cost_actual) if r.total_cost_actual is not None else None,
        qty_snapshot=float(r.qty_snapshot) if r.qty_snapshot is not None else None,
        qty_unit=r.qty_unit,
        cost_basis=r.cost_basis,
        input_vat_rate_snapshot=float(r.input_vat_rate_snapshot) if r.input_vat_rate_snapshot is not None else None,
        currency=r.currency,
        notes=r.notes,
        created_at=r.created_at.isoformat() if r.created_at else None,
    )


@router.get("/actual-costs", response_model=list[ActualCostOut])
async def list_actual_costs(
    product_key: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> list[ActualCostOut]:
    q = select(ActualProcurementCost).order_by(desc(ActualProcurementCost.created_at))
    if product_key:
        q = q.where(ActualProcurementCost.product_key == product_key)
    rows = (await db.execute(q.limit(limit))).scalars().all()
    return [_row_to_out(r) for r in rows]


@router.post("/actual-costs", status_code=201)
async def create_actual_cost(
    body: ActualCostIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> ActualCostOut:
    if body.unit_cost_actual is None and body.total_cost_actual is None:
        raise HTTPException(
            status_code=422,
            detail={"error": "missing_cost", "message": "unit_cost_actual 与 total_cost_actual 至少填一个"},
        )
    if body.cost_basis not in ("pretax", "incl_tax"):
        raise HTTPException(
            status_code=422,
            detail={"error": "invalid_cost_basis", "message": "cost_basis 只能是 pretax 或 incl_tax"},
        )
    row = ActualProcurementCost(
        tenant_id=auth.tenant_id or "default",
        product_key=body.product_key,
        supplier_name=body.supplier_name,
        effective_from=date.fromisoformat(body.effective_from) if body.effective_from else None,
        effective_to=date.fromisoformat(body.effective_to) if body.effective_to else None,
        unit_cost_actual=Decimal(str(body.unit_cost_actual)) if body.unit_cost_actual is not None else None,
        total_cost_actual=Decimal(str(body.total_cost_actual)) if body.total_cost_actual is not None else None,
        qty_snapshot=Decimal(str(body.qty_snapshot)) if body.qty_snapshot is not None else None,
        qty_unit=body.qty_unit,
        cost_basis=body.cost_basis,
        input_vat_rate_snapshot=Decimal(str(body.input_vat_rate_snapshot)) if body.input_vat_rate_snapshot is not None else None,
        currency=body.currency,
        notes=body.notes,
        created_by=getattr(auth, "user_id", None),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


class ActualCostResolveIn(BaseModel):
    unit_cost_actual: Optional[float] = None
    total_cost_actual: Optional[float] = None
    qty: Optional[float] = None
    cost_basis: str = "pretax"
    input_vat_rate: Optional[float] = None


class ActualCostResolveOut(BaseModel):
    unit_cost_actual: Optional[float]
    total_cost_actual: Optional[float]
    unit_cost_pretax: Optional[float]


@router.post("/actual-costs/resolve", response_model=ActualCostResolveOut)
async def resolve_actual_cost(
    body: ActualCostResolveIn,
    auth: AuthContext = Depends(get_auth_context),
) -> ActualCostResolveOut:
    """单件/总成本互算 + 含税→税前换算（供前端录入时实时预览）。"""
    unit = Decimal(str(body.unit_cost_actual)) if body.unit_cost_actual is not None else None
    total = Decimal(str(body.total_cost_actual)) if body.total_cost_actual is not None else None
    qty = Decimal(str(body.qty)) if body.qty is not None else None
    if unit is None and total is not None and qty and qty > 0:
        unit = total / qty
    if total is None and unit is not None and qty and qty > 0:
        total = unit * qty
    unit_pretax = unit
    if body.cost_basis == "incl_tax" and unit is not None and body.input_vat_rate is not None:
        rate = Decimal(str(body.input_vat_rate))
        if rate < 1:
            unit_pretax = unit * (Decimal(1) - rate)
    return ActualCostResolveOut(
        unit_cost_actual=float(unit) if unit is not None else None,
        total_cost_actual=float(total) if total is not None else None,
        unit_cost_pretax=float(unit_pretax) if unit_pretax is not None else None,
    )
