"""Kaas v2 · 客户定价数据（定价键 → 成本）

业务口径
--------
「定价数据」只回答一个问题：**这个客户、这个规格组合，成本是多少？**

- 规格组合由**产品定义声明的「定价键」**决定，不是让人自由填一堆规格字段。
  例：牛栏网成本只随「边丝径 × 镀锌量」变 → 定价键 2 维 → 2×2 = 4 行。
- 界面展示的是产品定价键的**完整组合矩阵**：客户配过的显示配置值，
  没配过的显示产品定义里的内联兜底值并标注来源，所以矩阵永远是完整的、
  可以直接拿去报价，不会出现「界面上没这一行、报价里却在用这个价」。
- 数值连续性：新增定价数据**不会**改变任何已有报价 —— 没配过的组合，
  引擎回退到产品定义里的内联成本（与旧行为逐分钱一致）。

权限
----
- 客户/免费用户：只能读写自己的定价数据（tenant/customer 来自 AuthContext）。
- 租户管理员：`?scope=all` 可以看到本租户下**所有客户**的配置，便于排查谁还没配价。

安全约束
--------
- tenant/customer 永远从 AuthContext 取，不信任前端传入（body 里带了就拒绝）。
- 历史不删：每次保存 INSERT 新版本，并把同键的旧版本置为 inactive。
"""
from datetime import date, datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext, get_auth_context
from app.core.auth_utils import require_customer_match, require_tenant_match
from app.db.session import get_db_session
from app.deps.rbac import require_tenant_admin
from app.repositories.cost_items_repo import (
    deactivate_pricing_key_items,
    insert_cost_item,
)
from app.services.export_quote.models import extend_product
from app.services.export_quote.products import get as get_product
from app.services.pricing_table import (
    KIND,
    key_of_values,
    load_matrix,
    load_option_extensions,
    make_spec_hash,
)

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["pricing_data"])

# 成本单位 → cost_type（与 customer_cost_items.cost_type 的既有取值保持一致）
_UNIT_TO_COST_TYPE = {
    "元/kg": "cost_per_kg",
    "kg": "cost_per_kg",
    "元/卷": "cost_per_roll",
    "元/捆": "cost_per_bundle",
    "元/平方米": "cost_per_sqm",
    "元/个": "fixed",
    "元/根": "fixed",
}


def _parse_date(value) -> Optional[datetime]:
    """解析日期字符串为 UTC datetime；None/空串返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    try:
        d = date.fromisoformat(str(value)[:10])
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _resolve_identity(request: Request, auth: AuthContext, body: Optional[dict] = None):
    """从 AuthContext 取 tenant/customer，并拒绝 body 里夹带的身份参数。"""
    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Missing tenant context")

    customer_id: str = auth.customer_id_str or tenant_id
    if body is not None:
        require_tenant_match(auth, body.get("tenant_id"))
        require_customer_match(auth, body.get("customer_id"))
    return tenant_id, customer_id


def _get_product_or_404(product_key: str):
    try:
        return get_product(product_key)
    except Exception:
        raise HTTPException(status_code=404, detail=f"未知产品: {product_key}")


@router.get("/pricing-data", summary="定价数据（按产品定价键的完整矩阵）")
async def list_pricing_data(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """返回某产品定价键的完整组合矩阵。

    - 默认 `scope=own`：只返回当前客户自己的配置。
    - `scope=all`（需租户管理员）：额外返回租户下所有客户的配置，按客户分组。
    """
    product_key = (request.query_params.get("product_key") or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail="product_key is required")
    product = _get_product_or_404(product_key)

    scope = (request.query_params.get("scope") or "own").strip()
    if scope not in ("own", "all"):
        raise HTTPException(status_code=422, detail="scope must be own or all")

    tenant_id, customer_id = _resolve_identity(request, auth)

    if scope == "all":
        # 跨客户查看属内部视图，必须租户管理员；客户/免费用户只能看自己的
        require_tenant_admin(request)
        exts = await load_option_extensions(db, tenant_id, None, product)
        return await load_matrix(
            db, tenant_id, None, extend_product(product, exts)
        )

    # 客户自己加过的档位要出现在矩阵里（否则刚录的成本看不见）
    exts = await load_option_extensions(db, tenant_id, customer_id, product)
    return await load_matrix(
        db, tenant_id, customer_id, extend_product(product, exts)
    )


@router.post("/pricing-data", summary="保存某个定价键组合的成本（新版本）")
async def create_pricing_data(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """保存一个定价键组合的成本。

    同一事务内：
    1. 按「产品定价键 + 取值」拼出查价键；
    2. 把该客户同键的旧版本置为 inactive（保留历史）；
    3. INSERT 一条新记录。

    INSERT-only 而非 UPDATE：成本价会变，但已经发出去的报价必须能复现当时的成本。
    """
    body = await request.json()
    tenant_id, customer_id = _resolve_identity(request, auth, body)

    product_key = str(body.get("product_key") or "").strip()
    if not product_key:
        raise HTTPException(status_code=422, detail="product_key is required")
    product = _get_product_or_404(product_key)

    if not product.pricing_key:
        raise HTTPException(
            status_code=422,
            detail=f"产品 {product_key} 未声明定价键，无法保存定价数据",
        )

    values = body.get("values")
    if not isinstance(values, dict) or not values:
        raise HTTPException(status_code=422, detail="values is required")

    key = key_of_values(product, values)
    if not key:
        raise HTTPException(
            status_code=422,
            detail=f"values 缺少定价键维度；需要: {[d['field'] for d in product.pricing_key]}",
        )

    amount = body.get("amount")
    if amount is None or not isinstance(amount, (int, float)) or amount <= 0:
        raise HTTPException(status_code=422, detail="amount must be > 0")

    unit = str(body.get("unit") or "").strip() or (
        product.cost_unit.split("/")[-1] if product.cost_unit else "kg"
    )
    cost_type = _UNIT_TO_COST_TYPE.get(unit)
    if cost_type is None:
        raise HTTPException(
            status_code=422,
            detail=f"unit 必须是以下之一: {sorted(set(_UNIT_TO_COST_TYPE.keys()))}",
        )

    spec_hash = make_spec_hash(product.key, key)
    effective_from = _parse_date(body.get("effective_from"))

    # 客户自己加的档位，显示名由界面给（如「镀锌60g/㎡」）。
    # 它不写进产品定义 —— 产品定义是全局的，客户加档位是客户自己的事。
    raw_labels = body.get("labels")
    labels = {
        str(k): str(v) for k, v in raw_labels.items()
    } if isinstance(raw_labels, dict) else {}

    try:
        await deactivate_pricing_key_items(db, tenant_id, customer_id, spec_hash)
        item = await insert_cost_item(
            session=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            product_category=product.name,
            spec_hash=spec_hash,
            cost_type=cost_type,
            amount=float(amount),
            currency=(body.get("currency") or "CNY").strip(),
            unit=unit,
            product_spec_id=None,  # 定价键成本不依赖老规格表
            product_spec_json={
                "kind": KIND,
                "product_key": product.key,
                "pricing_key": key,
                "values": values,
                "labels": labels,
            },
            effective_from=effective_from,
            source="manual",
            notes=body.get("notes"),
            created_by=str(auth.user_id),
        )
        await db.commit()

        logger.info(
            "pricing_data_saved",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
            product_key=product.key,
            pricing_key=key,
            amount=float(amount),
            item_id=item.id,
        )
        return {
            "id": item.id,
            "product_key": product.key,
            "key": key,
            "values": values,
            "amount": float(item.amount),
            "unit": item.unit,
            "effective_from": item.effective_from.isoformat() if item.effective_from else None,
            "status": item.status,
        }
    except Exception:
        await db.rollback()
        raise


@router.patch("/pricing-data/{item_id}", summary="修改某条定价数据")
async def update_pricing_data(
    item_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """改金额/单位/生效日期/备注。改「规格组合」请用 POST 建新版本。"""
    body = await request.json()
    tenant_id, customer_id = _resolve_identity(request, auth, body)

    from app.repositories.cost_items_repo import get_cost_item_by_id, update_cost_item

    updates: dict = {}
    if "amount" in body:
        amount = body.get("amount")
        if not isinstance(amount, (int, float)) or amount <= 0:
            raise HTTPException(status_code=422, detail="amount must be > 0")
        updates["amount"] = float(amount)
    if "unit" in body:
        unit = str(body.get("unit") or "").strip()
        cost_type = _UNIT_TO_COST_TYPE.get(unit)
        if cost_type is None:
            raise HTTPException(status_code=422, detail="unit 取值不合法")
        updates["cost_type"] = cost_type
        updates["unit"] = unit
    if "effective_from" in body:
        updates["effective_from"] = _parse_date(body["effective_from"])
    if "effective_to" in body:
        updates["effective_to"] = _parse_date(body["effective_to"])
    if "notes" in body:
        updates["notes"] = body["notes"]
    if "status" in body:
        status = str(body["status"]).strip()
        if status not in ("active", "inactive", "deprecated"):
            raise HTTPException(status_code=422, detail="status 取值不合法")
        updates["status"] = status

    if not updates:
        raise HTTPException(status_code=422, detail="No fields to update")

    try:
        item = await get_cost_item_by_id(db, item_id, tenant_id, customer_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Pricing data not found")
        updated = await update_cost_item(db, item_id, tenant_id, customer_id, updates)
        await db.commit()
        logger.info(
            "pricing_data_updated",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            item_id=item_id,
        )
        return {
            "id": updated.id,
            "amount": float(updated.amount),
            "unit": updated.unit,
            "effective_from": updated.effective_from.isoformat() if updated.effective_from else None,
            "status": updated.status,
        }
    except HTTPException:
        await db.rollback()
        raise
    except Exception:
        await db.rollback()
        raise


@router.delete("/pricing-data/{item_id}", summary="停用某条定价数据（软删除）")
async def delete_pricing_data(
    item_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
):
    """把一条定价数据置为 inactive。

    停用即回退到产品定义的内联兜底值 —— 不会把报价变成「无成本」。
    """
    tenant_id, customer_id = _resolve_identity(request, auth)

    try:
        from app.repositories.cost_items_repo import soft_delete_cost_item

        deleted = await soft_delete_cost_item(db, item_id, tenant_id, customer_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Pricing data not found or access denied")
        await db.commit()
        logger.info(
            "pricing_data_deleted",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            item_id=item_id,
        )
        return {"id": item_id, "status": "inactive"}
    except HTTPException:
        await db.rollback()
        raise
    except Exception:
        await db.rollback()
        raise
