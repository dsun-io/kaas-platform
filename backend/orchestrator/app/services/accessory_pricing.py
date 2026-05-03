"""Kaas v2 · INT-R3 配件报价引擎 (§5 T4)

为配件列表（立柱/横梁等）逐一匹配规格并查询成本/售价。
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.product_specs_repo import match_specs
from app.repositories.sale_price_repo import get_current_sale_price
from app.repositories.cost_items_repo import get_current_cost


async def price_accessories(
    db: AsyncSession,
    tenant_id: str,
    customer_id: str,
    accessories: list[dict],
) -> list[dict]:
    """计算配件价格。

    对每个配件：
      1. 按 product_category + 可选参数匹配 ProductSpec
      2. 优先查销售价覆盖，其次查成本价
      3. 计算 total = 单价 × quantity

    Args:
        accessories: 配件列表，每项包含:
            - product_category (str, required)
            - product_type (str, optional)
            - height (float, optional)
            - bundle_size (int, optional)
            - quantity (int, default=1)

    Returns:
        每项返回:
        {
            "product_category": str,
            "spec_summary": str,
            "quantity": int,
            "unit": str,
            "unit_price": float | None,
            "total": float | None,
            "status": "matched"|"no_match"|"too_many"|"cost_pending",
            "notes": str,
        }
    """
    results: list[dict] = []

    for acc in accessories:
        product_category = acc.get("product_category", "")
        quantity = acc.get("quantity", 1)

        # 匹配 ProductSpec
        specs = await match_specs(
            db=db,
            product_category=product_category,
            product_type=acc.get("product_type"),
            height=acc.get("height"),
            wire_diameter=acc.get("wire_diameter"),
            mesh_width=acc.get("mesh_width"),
            mesh_spec=acc.get("mesh_spec"),
            roll_length=acc.get("roll_length"),
        )

        if len(specs) == 0:
            results.append({
                "product_category": product_category,
                "spec_summary": product_category,
                "quantity": quantity,
                "unit": "",
                "unit_price": None,
                "total": None,
                "status": "no_match",
                "notes": f"未找到配件 {product_category} 的规格记录",
            })
            continue

        if len(specs) > 1:
            results.append({
                "product_category": product_category,
                "spec_summary": product_category,
                "quantity": quantity,
                "unit": "",
                "unit_price": None,
                "total": None,
                "status": "too_many",
                "notes": f"配件 {product_category} 匹配到 {len(specs)} 条记录，需细化",
            })
            continue

        spec = specs[0]
        spec_summary = _format_accessory_summary(spec)
        unit = "根" if spec.product_type == "立柱" else "个"
        spec_hash = spec.spec_hash

        # 优先查销售价，其次成本价
        sale_item = await get_current_sale_price(
            session=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            spec_hash=spec_hash,
        )
        if sale_item is not None:
            unit_price = sale_item.amount
            total = round(unit_price * quantity, 2)
            results.append({
                "product_category": product_category,
                "spec_summary": spec_summary,
                "quantity": quantity,
                "unit": unit,
                "unit_price": unit_price,
                "total": total,
                "status": "matched",
                "notes": f"销售价 {unit_price} 元/{unit}",
            })
            continue

        cost_item = await get_current_cost(
            session=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            spec_hash=spec_hash,
        )
        if cost_item is not None:
            unit_price = cost_item.amount
            if cost_item.cost_type == "cost_per_kg" and spec.weight_kg:
                unit_price = cost_item.amount * spec.weight_kg
            total = round(unit_price * quantity, 2)
            results.append({
                "product_category": product_category,
                "spec_summary": spec_summary,
                "quantity": quantity,
                "unit": unit,
                "unit_price": unit_price,
                "total": total,
                "status": "matched",
                "notes": f"成本价 {cost_item.amount} 元/{cost_item.unit}",
            })
            continue

        # 无价格
        results.append({
            "product_category": product_category,
            "spec_summary": spec_summary,
            "quantity": quantity,
            "unit": unit,
            "unit_price": None,
            "total": None,
            "status": "cost_pending",
            "notes": f"配件 {product_category} 未配置价格",
        })

    return results


def _format_accessory_summary(spec) -> str:
    """生成配件规格摘要。"""
    parts = [spec.product_category or ""]
    if spec.product_type:
        parts.append(spec.product_type)
    if spec.height:
        parts.append(f"{spec.height}m")
    if spec.bundle_size:
        parts.append(f"{spec.bundle_size}支/捆")
    return " | ".join(p for p in parts if p)
