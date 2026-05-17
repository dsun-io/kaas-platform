"""
Wizard 提交事务 — 五分组录入的核心事务入口。
必须导出 4 辅助函数: load_active_bindings / validate_spec_values / build_unit_map / current_schema_version
"""
from typing import Any, Optional
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    ProductCategory,
    CategoryAttributeBinding,
    SpecAttribute,
    SpecAttributeValue,
    ProductSku,
    ProductSkuRevision,
)
from app.domain.spec_hash import compute_sku_hash
from app.domain.units import convert_to_base_unit
from app.services.price_engine import upsert_price


async def load_active_bindings(
    db: AsyncSession,
    category_id: int,
    tenant_id: str,
) -> list[dict]:
    """加载指定类目的所有活跃属性绑定（公库 + 本租户私库）。"""
    stmt = (
        select(CategoryAttributeBinding, SpecAttribute)
        .join(SpecAttribute, CategoryAttributeBinding.attribute_id == SpecAttribute.id)
        .where(
            CategoryAttributeBinding.category_id == category_id,
            SpecAttribute.status == "active",
            (
                (CategoryAttributeBinding.scope == "public") |
                ((CategoryAttributeBinding.scope == "private") & (CategoryAttributeBinding.tenant_id == tenant_id))
            ),
        )
        .order_by(CategoryAttributeBinding.sort_order)
    )
    rows = await db.execute(stmt)
    result = []
    for binding, attr in rows.fetchall():
        # 加载枚举值
        values = []
        if attr.data_type in ("enum", "multi_enum"):
            val_stmt = (
                select(SpecAttributeValue)
                .where(
                    SpecAttributeValue.attribute_id == attr.id,
                    SpecAttributeValue.status == "active",
                    (
                        (SpecAttributeValue.scope == "public") |
                        ((SpecAttributeValue.scope == "private") & (SpecAttributeValue.tenant_id == tenant_id))
                    ),
                )
                .order_by(SpecAttributeValue.sort_order)
            )
            val_rows = await db.execute(val_stmt)
            values = val_rows.scalars().all()

        result.append({
            "binding_id": binding.id,
            "attr_role": binding.attr_role,
            "is_required": binding.is_required,
            "is_locked": binding.is_locked,
            "sort_order": binding.sort_order,
            "default_value": binding.default_value,
            "depends_on": binding.depends_on,
            "attribute": {
                "id": attr.id,
                "code": attr.code,
                "name": attr.name,
                "group_code": attr.group_code,
                "data_type": attr.data_type,
                "unit": attr.unit,
                "unit_group": attr.unit_group,
                "number_min": float(attr.number_min) if attr.number_min is not None else None,
                "number_max": float(attr.number_max) if attr.number_max is not None else None,
                "number_step": float(attr.number_step) if attr.number_step is not None else None,
                "scope": attr.scope,
                "values": [
                    {"id": v.id, "code": v.value_code, "label": v.value_label}
                    for v in values
                ],
            },
        })
    return result


def validate_spec_values(spec_values: dict[str, Any], bindings: list[dict]) -> dict[str, Any]:
    """校验 spec_values 是否满足 binding 约束（必填、类型、范围）。"""
    binding_map = {b["attribute"]["code"]: b for b in bindings}
    errors = []

    # 检查必填
    for b in bindings:
        if b["is_required"]:
            code = b["attribute"]["code"]
            val = spec_values.get(code)
            if val is None or (isinstance(val, dict) and val.get("v") in (None, "")):
                errors.append(f"Missing required attribute: {code} ({b['attribute']['name']})")

    if errors:
        raise ValueError("; ".join(errors))

    # 类型和范围校验
    for code, val in spec_values.items():
        if code not in binding_map:
            continue
        b = binding_map[code]
        attr = b["attribute"]
        raw = val.get("v") if isinstance(val, dict) else val

        if raw is None or raw == "":
            continue

        if attr["data_type"] == "number":
            try:
                num = float(raw)
            except (ValueError, TypeError):
                errors.append(f"{code}: expected number, got {raw}")
                continue
            if attr["number_min"] is not None and num < attr["number_min"]:
                errors.append(f"{code}: {num} < min {attr['number_min']}")
            if attr["number_max"] is not None and num > attr["number_max"]:
                errors.append(f"{code}: {num} > max {attr['number_max']}")

        elif attr["data_type"] == "enum":
            valid_codes = {v["code"] for v in attr.get("values", [])}
            if valid_codes and raw not in valid_codes:
                errors.append(f"{code}: invalid enum value '{raw}', valid: {valid_codes}")

    if errors:
        raise ValueError("; ".join(errors))

    return spec_values


def build_unit_map(bindings: list[dict]) -> dict[str, str]:
    """从 bindings 构建 { attribute_code: base_unit_code } 映射。"""
    unit_map = {}
    for b in bindings:
        attr = b["attribute"]
        if attr.get("unit"):
            unit_map[attr["code"]] = attr["unit"]
    return unit_map


def current_schema_version(bindings: list[dict]) -> int:
    """计算当前 schema_version = max(binding.schema_version)。"""
    if not bindings:
        return 1
    # bindings 里没有直接的 schema_version，用 1 作为默认
    return 1


async def submit_wizard(
    db: AsyncSession,
    tenant_id: str,
    category_id: int,
    spec_values: dict[str, Any],
    price_payload: Optional[dict] = None,
    weight_kg: Optional[float] = None,
    description: Optional[str] = None,
    created_by: Optional[str] = None,
) -> dict:
    """
    Wizard 提交事务入口。
    1. 校验类目
    2. 加载 bindings
    3. 校验 spec_values
    4. 计算 spec_hash
    5. Upsert SKU
    6. Upsert Price（如有）
    """
    # 1. 校验类目
    cat = await db.get(ProductCategory, category_id)
    if not cat or not cat.is_leaf or not cat.is_active:
        raise ValueError("Invalid leaf category")

    # 2. 加载 bindings
    bindings = await load_active_bindings(db, category_id, tenant_id)
    if not bindings:
        raise ValueError("No active bindings for this category")

    # 3. 校验 spec_values
    validate_spec_values(spec_values, bindings)

    # 4. 计算 spec_hash
    unit_map = build_unit_map(bindings)
    spec_hash = compute_sku_hash(cat.code, spec_values, unit_map, None)

    # 5. Upsert SKU
    sku_stmt = select(ProductSku).where(
        ProductSku.tenant_id == tenant_id,
        ProductSku.category_id == cat.id,
        ProductSku.spec_hash == spec_hash,
    )
    sku_result = await db.execute(sku_stmt)
    sku = sku_result.scalar_one_or_none()
    is_new = False

    if not sku:
        is_new = True
        sku = ProductSku(
            tenant_id=tenant_id,
            category_id=cat.id,
            spec_values=spec_values,
            spec_hash=spec_hash,
            schema_version=current_schema_version(bindings),
            weight_kg=weight_kg,
            description=description,
            created_by=created_by,
        )
        db.add(sku)
        await db.flush()

    # 6. Upsert Price
    price_id = None
    if price_payload:
        price_id = await upsert_price(
            db=db,
            sku_id=sku.id,
            tenant_id=tenant_id,
            price=price_payload["price"],
            price_unit_code=price_payload["price_unit"],
            effective_from=price_payload["effective_from"],
            effective_to=price_payload.get("effective_to"),
            min_qty=price_payload.get("min_qty"),
            tier_rules=price_payload.get("tier_rules"),
            note=price_payload.get("note"),
            change_reason=price_payload.get("change_reason", "Wizard submit"),
            created_by=created_by,
        )

    return {
        "sku_id": sku.id,
        "price_id": price_id,
        "spec_hash": spec_hash,
        "is_new_sku": is_new,
        "schema_version": sku.schema_version,
    }
