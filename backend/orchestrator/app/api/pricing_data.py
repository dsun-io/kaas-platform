"""
Kaas v2 · 客户定价数据录入/查询 API
────────────────────────────────────
POST /api/v1/pricing-data  — 同一事务写 product_specs + customer_cost_items
GET  /api/v1/pricing-data  — 查询当前客户的定价数据

安全约束:
- tenant/customer 永远从 AuthContext 取，不信任前端传入
- free 用户只能读写自己的数据
- product_specs 写入仅使用平台通用字段，不含价格
- customer_cost_items 含有成本价，scoped to customer_id
"""
from datetime import date, datetime, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db_session
from app.db.models import ProductSpec, CustomerCostItem
from app.domain.spec_hash import compute_spec_hash
from app.domain.category_normalizer import normalize_category
from app.repositories.cost_items_repo import list_cost_items, insert_cost_item
from app.core.auth import get_auth_context, AuthContext
from app.core.auth_utils import require_tenant_match, require_customer_match

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1", tags=["pricing_data"])

_CATEGORIES = frozenset([
    "niulanwang",
    "fence",
    "barbed_wire",
    "gabion",
    "steel_grating",
    "other",
])

# cost_unit → cost_type 映射
_UNIT_TO_COST_TYPE = {
    "元/kg": "cost_per_kg",
    "元/卷": "cost_per_roll",
    "元/捆": "cost_per_bundle",
    "元/平方米": "cost_per_sqm",
    "元/个": "fixed",
    "元/根": "fixed",
}

_SPEC_FIELDS = [
    "product_category", "product_type", "wire_diameter",
    "height", "mesh_width", "mesh_spec", "roll_length",
]


def _build_spec_dict(body: dict) -> dict:
    """从请求体提取规格字段构建 spec_hash 输入字典。"""
    return {k: body.get(k) for k in _SPEC_FIELDS if body.get(k) is not None}


async def _find_or_create_spec(
    db: AsyncSession,
    spec_dict: dict,
    body: dict,
) -> ProductSpec:
    """按 spec_hash 查找现有 ProductSpec，不存在则创建。"""
    spec_hash = compute_spec_hash(spec_dict)
    result = await db.execute(
        select(ProductSpec).where(ProductSpec.spec_hash == spec_hash)
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        return existing

    spec = ProductSpec(
        product_category=spec_dict.get("product_category", body.get("product_category", "")),
        product_type=spec_dict.get("product_type"),
        wire_diameter=spec_dict.get("wire_diameter"),
        height=spec_dict.get("height"),
        mesh_width=spec_dict.get("mesh_width"),
        mesh_spec=spec_dict.get("mesh_spec"),
        roll_length=spec_dict.get("roll_length"),
        weight_kg=body.get("weight_kg"),
        spec_hash=spec_hash,
    )
    db.add(spec)
    await db.flush()
    return spec


def _parse_date(value) -> Optional[datetime]:
    """解析日期字符串为 UTC datetime，None/空串返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    # ISO date string
    try:
        d = date.fromisoformat(str(value)[:10])
        return datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


@router.post("/pricing-data")
async def create_pricing_data(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """录入客户规格 + 成本价数据。

    同一事务内:
    1. 查找或创建 product_specs 规格记录
    2. 插入 customer_cost_items 成本记录

    tenant/customer 信息永远从 AuthContext 取，不信任请求体。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if auth is None:
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Authentication required"},
        )

    # customer/free: tenant 必须以 AuthContext 为准
    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""

    if not tenant_id:
        return JSONResponse(
            status_code=401,
            content={"error": "tenant_required", "message": "Missing tenant context"},
        )

    # customer_id 使用 customer_code（与 quote engine 一致）
    customer_id: str = auth.customer_id_str or tenant_id

    body = await request.json()

    # customer/free: 拒绝 body 中携带的不匹配 tenant/customer 参数
    require_tenant_match(auth, body.get("tenant_id"))
    require_customer_match(auth, body.get("customer_id"))

    # ── 校验必填字段 ──
    raw_category = (body.get("product_category") or "").strip()
    product_category = normalize_category(raw_category)
    if not product_category:
        return JSONResponse(
            status_code=422,
            content={
                "error": "validation_error",
                "message": "product_category is required",
            },
        )

    cost_amount = body.get("cost_amount")
    if cost_amount is None or not isinstance(cost_amount, (int, float)) or cost_amount <= 0:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "cost_amount must be > 0"},
        )

    cost_unit = (body.get("cost_unit") or "").strip()
    cost_type = _UNIT_TO_COST_TYPE.get(cost_unit)
    if cost_type is None:
        return JSONResponse(
            status_code=422,
            content={
                "error": "validation_error",
                "message": f"cost_unit must be one of: {', '.join(_UNIT_TO_COST_TYPE.keys())}",
            },
        )

    # ── 解析可选字段 ──
    effective_from = _parse_date(body.get("effective_from"))
    effective_to = _parse_date(body.get("effective_to"))
    status = (body.get("status") or "active").strip()
    if status not in ("active", "inactive", "deprecated"):
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "status must be active, inactive, or deprecated"},
        )

    # ── 同一事务: 写 product_specs + customer_cost_items ──
    try:
        spec_dict = _build_spec_dict(body)
        if not spec_dict:
            return JSONResponse(
                status_code=422,
                content={"error": "validation_error", "message": "At least one spec field is required beyond product_category"},
            )

        spec = await _find_or_create_spec(db, spec_dict, body)
        spec_hash = spec.spec_hash

        cost_item = await insert_cost_item(
            session=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            product_category=product_category,
            spec_hash=spec_hash,
            cost_type=cost_type,
            amount=float(cost_amount),
            currency=(body.get("cost_currency") or "CNY").strip(),
            unit=cost_unit,
            product_spec_id=spec.id,
            product_spec_json={
                "spec_id": spec.id,
                "product_category": spec.product_category,
                "product_type": spec.product_type,
                "wire_diameter": spec.wire_diameter,
                "height": spec.height,
                "mesh_width": spec.mesh_width,
                "mesh_spec": spec.mesh_spec,
                "roll_length": spec.roll_length,
                "weight_kg": spec.weight_kg,
            },
            effective_from=effective_from,
            effective_to=effective_to,
            source="manual",
            notes=body.get("notes"),
            created_by=str(auth.user_id),
        )

        logger.info(
            "pricing_data_created",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
            spec_hash=spec_hash,
            cost_item_id=cost_item.id,
        )

        return JSONResponse(
            status_code=201,
            content={
                "id": cost_item.id,
                "product_category": product_category,
                "spec_hash": spec_hash,
                "spec_id": spec.id,
                "cost_type": cost_type,
                "amount": cost_item.amount,
                "currency": cost_item.currency,
                "unit": cost_item.unit,
                "effective_from": effective_from.isoformat() if effective_from else None,
                "effective_to": effective_to.isoformat() if effective_to else None,
                "status": cost_item.status,
                "product_spec": {
                    "id": spec.id,
                    "product_category": spec.product_category,
                    "product_type": spec.product_type,
                    "wire_diameter": spec.wire_diameter,
                    "height": spec.height,
                    "mesh_width": spec.mesh_width,
                    "mesh_spec": spec.mesh_spec,
                    "roll_length": spec.roll_length,
                    "weight_kg": spec.weight_kg,
                },
            },
        )

    except Exception:
        await db.rollback()
        raise


@router.get("/pricing-data")
async def list_pricing_data(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """查询当前客户的定价数据列表。"""
    auth: AuthContext = getattr(request.state, "auth", None)
    if auth is None:
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Authentication required"},
        )

    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""

    if not tenant_id:
        return JSONResponse(
            status_code=401,
            content={"error": "tenant_required", "message": "Missing tenant context"},
        )

    customer_id: str = auth.customer_id_str or tenant_id

    # 解析查询参数（normalize 品类，兼容中英文）
    raw_category = request.query_params.get("product_category")
    normalized_cat = normalize_category(raw_category) if raw_category else None
    page = max(1, int(request.query_params.get("page", "1")))
    page_size = min(100, max(1, int(request.query_params.get("page_size", "20"))))

    items = await list_cost_items(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_category=normalized_cat,
    )

    # 简单分页
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    page_items = items[start:end]

    # 关联查询 product_specs
    spec_ids = [item.product_spec_id for item in page_items if item.product_spec_id]
    spec_map = {}
    if spec_ids:
        specs_result = await db.execute(
            select(ProductSpec).where(ProductSpec.id.in_(spec_ids))
        )
        for s in specs_result.scalars().all():
            spec_map[s.id] = s

    results = []
    for item in page_items:
        spec = spec_map.get(item.product_spec_id) if item.product_spec_id else None
        results.append({
            "id": item.id,
            "product_category": item.product_category,
            "spec_hash": item.spec_hash,
            "spec_id": item.product_spec_id,
            "cost_type": item.cost_type,
            "amount": item.amount,
            "currency": item.currency,
            "unit": item.unit,
            "effective_from": item.effective_from.isoformat() if item.effective_from else None,
            "effective_to": item.effective_to.isoformat() if item.effective_to else None,
            "status": item.status,
            "source": item.source,
            "notes": item.notes,
            "created_at": item.created_at.isoformat() if item.created_at else None,
            "product_spec": {
                "id": spec.id,
                "product_category": spec.product_category,
                "product_type": spec.product_type,
                "wire_diameter": spec.wire_diameter,
                "height": spec.height,
                "mesh_width": spec.mesh_width,
                "mesh_spec": spec.mesh_spec,
                "roll_length": spec.roll_length,
                "weight_kg": spec.weight_kg,
            } if spec else None,
        })

    return JSONResponse(
        status_code=200,
        content={
            "items": results,
            "total": total,
            "page": page,
            "page_size": page_size,
            "pages": (total + page_size - 1) // page_size if total > 0 else 0,
        },
    )


@router.patch("/pricing-data/{item_id}")
async def update_pricing_data(
    item_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """编辑客户规格 + 成本价数据。

    仅允许编辑当前用户 tenant/customer 下的数据。
    同一事务内更新 product_specs 和 customer_cost_items。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if auth is None:
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Authentication required"},
        )

    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""

    if not tenant_id:
        return JSONResponse(
            status_code=401,
            content={"error": "tenant_required", "message": "Missing tenant context"},
        )

    customer_id: str = auth.customer_id_str or tenant_id

    body = await request.json()

    # customer/free: 拒绝 body 中携带的不匹配 tenant/customer 参数
    require_tenant_match(auth, body.get("tenant_id"))
    require_customer_match(auth, body.get("customer_id"))

    try:
        # 查找现有记录
        from app.repositories.cost_items_repo import get_cost_item_by_id, update_cost_item
        cost_item = await get_cost_item_by_id(db, item_id, tenant_id, customer_id)
        if cost_item is None:
            return JSONResponse(
                status_code=404,
                content={"error": "not_found", "message": "Pricing data not found"},
            )

        # ── 构建更新字段 ──
        updates: dict = {}

        # 成本金额
        new_amount = body.get("cost_amount")
        if new_amount is not None:
            if not isinstance(new_amount, (int, float)) or new_amount <= 0:
                return JSONResponse(
                    status_code=422,
                    content={"error": "validation_error", "message": "cost_amount must be > 0"},
                )
            updates["amount"] = float(new_amount)

        # 成本单位 → cost_type
        new_unit = body.get("cost_unit")
        if new_unit is not None:
            new_cost_type = _UNIT_TO_COST_TYPE.get(new_unit.strip())
            if new_cost_type is None:
                return JSONResponse(
                    status_code=422,
                    content={
                        "error": "validation_error",
                        "message": f"cost_unit must be one of: {', '.join(_UNIT_TO_COST_TYPE.keys())}",
                    },
                )
            updates["cost_type"] = new_cost_type
            updates["unit"] = new_unit.strip()

        # 品类
        new_category = body.get("product_category")
        if new_category is not None:
            updates["product_category"] = normalize_category(str(new_category).strip())

        # 规格字段变更 → 需重建 spec_hash 和 product_spec
        spec_changed = False
        spec_dict = {}
        for field in ["product_type", "wire_diameter", "height", "mesh_width",
                       "mesh_spec", "roll_length"]:
            if field in body:
                spec_changed = True
                spec_dict[field] = body[field]

        if spec_changed:
            # 构建完整 spec_dict（合并现有值 + 新值）
            full_spec = {
                "product_category": updates.get("product_category", cost_item.product_category),
                "product_type": spec_dict.get("product_type", cost_item.product_spec_json.get("product_type") if cost_item.product_spec_json else None),
                "wire_diameter": spec_dict.get("wire_diameter", cost_item.product_spec_json.get("wire_diameter") if cost_item.product_spec_json else None),
                "height": spec_dict.get("height", cost_item.product_spec_json.get("height") if cost_item.product_spec_json else None),
                "mesh_width": spec_dict.get("mesh_width", cost_item.product_spec_json.get("mesh_width") if cost_item.product_spec_json else None),
                "mesh_spec": spec_dict.get("mesh_spec", cost_item.product_spec_json.get("mesh_spec") if cost_item.product_spec_json else None),
                "roll_length": spec_dict.get("roll_length", cost_item.product_spec_json.get("roll_length") if cost_item.product_spec_json else None),
            }
            from app.domain.spec_hash import compute_spec_hash
            new_spec_hash = compute_spec_hash({k: v for k, v in full_spec.items() if v is not None})
            updates["spec_hash"] = new_spec_hash

            # 更新/创建 product_spec
            spec = await _find_or_create_spec(db, {k: v for k, v in full_spec.items() if v is not None}, body)
            updates["product_spec_id"] = spec.id
            updates["product_spec_json"] = {
                "spec_id": spec.id,
                "product_category": spec.product_category,
                "product_type": spec.product_type,
                "wire_diameter": spec.wire_diameter,
                "height": spec.height,
                "mesh_width": spec.mesh_width,
                "mesh_spec": spec.mesh_spec,
                "roll_length": spec.roll_length,
                "weight_kg": spec.weight_kg,
            }

        # 日期
        if "effective_from" in body:
            updates["effective_from"] = _parse_date(body["effective_from"])
        if "effective_to" in body:
            updates["effective_to"] = _parse_date(body["effective_to"])

        # 状态
        if "status" in body:
            new_status = str(body["status"]).strip()
            if new_status not in ("active", "inactive", "deprecated"):
                return JSONResponse(
                    status_code=422,
                    content={"error": "validation_error", "message": "status must be active, inactive, or deprecated"},
                )
            updates["status"] = new_status

        # 备注
        if "notes" in body:
            updates["notes"] = body["notes"]

        if not updates:
            return JSONResponse(
                status_code=422,
                content={"error": "validation_error", "message": "No fields to update"},
            )

        updated = await update_cost_item(db, item_id, tenant_id, customer_id, updates)
        if updated is None:
            await db.rollback()
            return JSONResponse(
                status_code=500,
                content={"error": "update_failed", "message": "Failed to update cost item"},
            )

        logger.info(
            "pricing_data_updated",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
            item_id=item_id,
        )

        spec = None
        if updated.product_spec_id:
            spec_result = await db.execute(
                select(ProductSpec).where(ProductSpec.id == updated.product_spec_id)
            )
            spec = spec_result.scalar_one_or_none()

        return JSONResponse(
            status_code=200,
            content={
                "id": updated.id,
                "product_category": updated.product_category,
                "spec_hash": updated.spec_hash,
                "spec_id": updated.product_spec_id,
                "cost_type": updated.cost_type,
                "amount": updated.amount,
                "currency": updated.currency,
                "unit": updated.unit,
                "effective_from": updated.effective_from.isoformat() if updated.effective_from else None,
                "effective_to": updated.effective_to.isoformat() if updated.effective_to else None,
                "status": updated.status,
                "product_spec": {
                    "id": spec.id,
                    "product_category": spec.product_category,
                    "product_type": spec.product_type,
                    "wire_diameter": spec.wire_diameter,
                    "height": spec.height,
                    "mesh_width": spec.mesh_width,
                    "mesh_spec": spec.mesh_spec,
                    "roll_length": spec.roll_length,
                    "weight_kg": spec.weight_kg,
                } if spec else None,
            },
        )

    except Exception:
        await db.rollback()
        raise


@router.delete("/pricing-data/{item_id}")
async def delete_pricing_data(
    item_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """删除/停用客户定价数据（软删除，设为 inactive）。

    仅允许操作当前用户 tenant/customer 下的数据。
    """
    auth: AuthContext = getattr(request.state, "auth", None)
    if auth is None:
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Authentication required"},
        )

    if auth.is_customer():
        tenant_id: str = auth.tenant_id or ""
    else:
        tenant_id: str = getattr(request.state, "tenant_id", "") or ""

    if not tenant_id:
        return JSONResponse(
            status_code=401,
            content={"error": "tenant_required", "message": "Missing tenant context"},
        )

    customer_id: str = auth.customer_id_str or tenant_id

    try:
        from app.repositories.cost_items_repo import soft_delete_cost_item
        deleted = await soft_delete_cost_item(db, item_id, tenant_id, customer_id)
        if not deleted:
            return JSONResponse(
                status_code=404,
                content={"error": "not_found", "message": "Pricing data not found or access denied"},
            )

        logger.info(
            "pricing_data_deleted",
            user_id=auth.user_id,
            tenant_id=tenant_id,
            customer_id=customer_id,
            item_id=item_id,
        )

        return JSONResponse(
            status_code=200,
            content={"id": item_id, "status": "inactive", "message": "Pricing data deactivated"},
        )

    except Exception:
        await db.rollback()
        raise
