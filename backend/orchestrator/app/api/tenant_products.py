"""租户级产品定义 API：产品 CRUD（租户级配置化）。

权限矩阵（**未完成**）：
- is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
- is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import TenantProduct
from app.core.auth import AuthContext, get_auth_context
from app.services.export_quote.tenant_products import spec_from_dict, spec_to_dict

router = APIRouter(prefix="/api/v1", tags=["tenant-products"])


class TenantProductIn(BaseModel):
    product_key: str
    product_name: str
    product_name_en: Optional[str] = None
    category_code: Optional[str] = None
    cost_field: str = "raw_price"
    cost_basis: str = "pretax"
    cost_unit: Optional[str] = None
    profit_mode: str = "margin_on_price"
    profit_value: float = 0.06
    misc_fee_rate: float = 0.03
    spec: dict
    is_active: bool = True


class TenantProductOut(BaseModel):
    id: int
    product_key: str
    product_name: str
    product_name_en: Optional[str]
    category_code: Optional[str]
    cost_field: str
    cost_basis: str
    cost_unit: Optional[str]
    profit_mode: str
    profit_value: float
    misc_fee_rate: float
    is_system: bool
    is_active: bool
    created_at: Optional[str]


def _row_to_out(r: TenantProduct) -> TenantProductOut:
    return TenantProductOut(
        id=r.id, product_key=r.product_key, product_name=r.product_name,
        product_name_en=r.product_name_en, category_code=r.category_code,
        cost_field=r.cost_field, cost_basis=r.cost_basis, cost_unit=r.cost_unit,
        profit_mode=r.profit_mode,
        profit_value=float(r.profit_value) if r.profit_value is not None else 0.06,
        misc_fee_rate=float(r.misc_fee_rate) if r.misc_fee_rate is not None else 0.03,
        is_system=bool(r.is_system), is_active=bool(r.is_active),
        created_at=r.created_at.isoformat() if r.created_at else None,
    )


@router.get("/tenant-products", response_model=list[TenantProductOut])
async def list_tenant_products(
    tenant_id: Optional[str] = None,
    is_active: Optional[bool] = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> list[TenantProductOut]:
    q = select(TenantProduct).order_by(desc(TenantProduct.created_at))
    if tenant_id:
        q = q.where(TenantProduct.tenant_id == tenant_id)
    if is_active is not None:
        q = q.where(TenantProduct.is_active == is_active)
    rows = (await db.execute(q.limit(limit))).scalars().all()
    return [_row_to_out(r) for r in rows]


@router.post("/tenant-products", status_code=201)
async def create_tenant_product(
    body: TenantProductIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> TenantProductOut:
    # 验证 spec 能转 ProductSpec
    try:
        spec_from_dict(body.spec)
    except Exception as exc:
        raise HTTPException(status_code=422, detail={"error": "invalid_spec", "message": str(exc)})
    row = TenantProduct(
        tenant_id=auth.tenant_id or "default",
        product_key=body.product_key,
        product_name=body.product_name,
        product_name_en=body.product_name_en,
        category_code=body.category_code,
        cost_field=body.cost_field,
        cost_basis=body.cost_basis,
        cost_unit=body.cost_unit,
        profit_mode=body.profit_mode,
        profit_value=body.profit_value,
        misc_fee_rate=body.misc_fee_rate,
        spec=body.spec,
        is_system=False,
        is_active=body.is_active,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.put("/tenant-products/{product_id}")
async def update_tenant_product(
    product_id: int,
    body: TenantProductIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> TenantProductOut:
    row = (await db.execute(
        select(TenantProduct).where(TenantProduct.id == product_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "PRODUCT_NOT_FOUND"})
    if row.is_system:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "message": "系统级产品仅平台管理员可编辑"})
    try:
        spec_from_dict(body.spec)
    except Exception as exc:
        raise HTTPException(status_code=422, detail={"error": "invalid_spec", "message": str(exc)})
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(row, k, v)
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.delete("/tenant-products/{product_id}", status_code=204)
async def delete_tenant_product(
    product_id: int,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> None:
    row = (await db.execute(
        select(TenantProduct).where(TenantProduct.id == product_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "PRODUCT_NOT_FOUND"})
    if row.is_system:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "message": "系统级产品不可删除"})
    await db.delete(row)
    await db.commit()
    return None
