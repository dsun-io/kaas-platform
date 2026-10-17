"""租户级产品定义 API：产品 CRUD（租户级配置化）。

权限矩阵（**未完成**）：
- is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
- is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc, or_
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
    # P13（202610170002）：团队差异（spec_delta 形态）；null = 直接用基线
    override: Optional[dict] = None
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


def _spec_fingerprint(spec: dict) -> str:
    from app.services.export_quote.spec_delta import spec_fingerprint
    return spec_fingerprint(spec)


def _validate_override(body: TenantProductIn) -> None:
    """差异形状闸门：能合并（基线 + 差异 → ProductSpec）才允许落库。

    SpecDeltaError（未知版本/字段/结构矛盾）→ 422；hash 不匹配在此**不**校验
    （写入的是当前基线的差异，hash 以写入时基线计算并留档）。
    """
    if not body.override:
        return
    from app.services.export_quote.effective_spec import resolve_effective_product
    from app.services.export_quote.spec_delta import SpecDeltaError
    try:
        resolve_effective_product(body.spec, body.override)
    except SpecDeltaError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "invalid_override", "message": str(exc),
        })


@router.get("/tenant-products", response_model=list[TenantProductOut])
async def list_tenant_products(
    tenant_id: Optional[str] = None,
    is_active: Optional[bool] = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> list[TenantProductOut]:
    """产品列表：本租户的产品 + 系统级产品（所有租户可见）。

    `tenant_id` 显式传入时以它为准（平台侧排查用），否则只回本租户 ——
    避免跨租户读到别家产品定义。口径与 Worker ws_products.py 一致。
    """
    tid = tenant_id or auth.tenant_id or "default"
    q = select(TenantProduct).where(
        or_(TenantProduct.tenant_id == tid, TenantProduct.is_system.is_(True))
    ).order_by(desc(TenantProduct.created_at))
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
    _validate_override(body)
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
        override=body.override,
        # 差异落库时留档基线指纹（审计/快速比对；读路径以 override 内 hash 为准）
        base_spec_hash=_spec_fingerprint(body.spec) if body.override else None,
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
    if row.tenant_id != (auth.tenant_id or "default"):
        # 别家的产品一律 404（不泄露存在性），与 Worker ws_products.py 同口径
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "PRODUCT_NOT_FOUND"})
    try:
        spec_from_dict(body.spec)
    except Exception as exc:
        raise HTTPException(status_code=422, detail={"error": "invalid_spec", "message": str(exc)})
    _validate_override(body)
    for k, v in body.model_dump(exclude_unset=True).items():
        if k == "base_spec_hash":
            continue  # 只读留档字段，不允许请求体直写
        setattr(row, k, v)
    # 基线或差异变化时刷新留档指纹
    row.base_spec_hash = _spec_fingerprint(body.spec) if body.override else None
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
    if row.tenant_id != (auth.tenant_id or "default"):
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "PRODUCT_NOT_FOUND"})
    await db.delete(row)
    await db.commit()
    return None
