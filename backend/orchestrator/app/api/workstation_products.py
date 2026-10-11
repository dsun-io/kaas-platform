"""租户开通报价工位权限矩阵 API：选择启用产品（多对多）。

权限矩阵：
- is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
- is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.models import TenantProduct, TenantWorkstationProduct
from app.core.auth import AuthContext, get_auth_context
from app.api.subs import require_quote

router = APIRouter(prefix="/api/v1", tags=["workstation-products"])


class WorkstationProductIn(BaseModel):
    product_key: str
    is_enabled: bool = True


class WorkstationProductOut(BaseModel):
    product_key: str
    product_name: str
    is_system: bool
    is_enabled: bool


@router.get("/workstation-products", response_model=list[WorkstationProductOut])
async def list_workstation_products(
    workstation: str = "quote",
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
    _sub: AuthContext = Depends(require_quote),
) -> list[WorkstationProductOut]:
    """列出该租户在指定工位启用的产品（含系统级产品）。

    未订阅报价工位 → 404 SUBSCRIPTION_REQUIRED（工位订阅校验，见
    docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md §权限设计）。
    """
    tenant_id = auth.tenant_id or "default"
    # 1. 系统级产品（所有租户可见）
    system_products = (await db.execute(
        select(TenantProduct).where(TenantProduct.is_system == True)  # noqa: E712
    )).scalars().all()
    # 2. 租户级产品
    tenant_products = (await db.execute(
        select(TenantProduct).where(
            TenantProduct.tenant_id == tenant_id,
            TenantProduct.is_system == False,  # noqa: E712
            TenantProduct.is_active == True,  # noqa: E712
        )
    )).scalars().all()
    # 3. 启用状态
    enabled_rows = (await db.execute(
        select(TenantWorkstationProduct).where(
            TenantWorkstationProduct.tenant_id == tenant_id,
            TenantWorkstationProduct.workstation == workstation,
        )
    )).scalars().all()
    enabled_map = {r.product_key: r.is_enabled for r in enabled_rows}

    out: list[WorkstationProductOut] = []
    for p in list(system_products) + list(tenant_products):
        out.append(WorkstationProductOut(
            product_key=p.product_key,
            product_name=p.product_name,
            is_system=bool(p.is_system),
            is_enabled=enabled_map.get(p.product_key, True),
        ))
    return out


@router.post("/workstation-products", status_code=201)
async def set_workstation_product(
    body: WorkstationProductIn,
    workstation: str = "quote",
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
    _sub: AuthContext = Depends(require_quote),
) -> WorkstationProductOut:
    """启用/停用产品（幂等 upsert）。未订阅报价工位 → 404，且不写任何数据。"""
    tenant_id = auth.tenant_id or "default"
    # 验证产品存在：本租户的产品或系统级产品（别家的产品不算，防跨租户启用）
    product = (await db.execute(
        select(TenantProduct).where(
            TenantProduct.product_key == body.product_key,
            or_(TenantProduct.tenant_id == tenant_id, TenantProduct.is_system.is_(True)),
        ).order_by(TenantProduct.is_system.desc()).limit(1)
    )).scalars().first()
    if product is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "PRODUCT_NOT_FOUND"})

    row = (await db.execute(
        select(TenantWorkstationProduct).where(
            TenantWorkstationProduct.tenant_id == tenant_id,
            TenantWorkstationProduct.workstation == workstation,
            TenantWorkstationProduct.product_key == body.product_key,
        )
    )).scalar_one_or_none()
    if row is None:
        row = TenantWorkstationProduct(
            tenant_id=tenant_id, workstation=workstation,
            product_key=body.product_key, is_enabled=body.is_enabled,
        )
        db.add(row)
    else:
        row.is_enabled = body.is_enabled
    await db.commit()
    return WorkstationProductOut(
        product_key=body.product_key, product_name=product.product_name,
        is_system=bool(product.is_system), is_enabled=body.is_enabled,
    )
