"""Kaas v2 · INT-R3 报价引擎主流程 (§5 T6)

编排 spec 匹配 → 成本计算 → 梯度定价 → 配件计价 → 运费计算 → 话术生成。
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import ProductSpec
from app.services.spec_matcher import match_spec, _format_spec_summary
from app.services.niulanwang_pricing import calculate_base_cost, calculate_tiers
from app.services.accessory_pricing import price_accessories
from app.services.freight_calculator import calculate_freight
from app.services.quote_script_renderer import render_quote_script


async def create_quote(
    db: AsyncSession,
    tenant_id: str,
    customer_id: str,
    request: dict,
) -> dict:
    """创建报价主流程（牛栏网专用）。

    Args:
        request: QuoteV2Request 格式的字典:
            - product_category (str)
            - product_type (str, optional)
            - wire_diameter (str, optional)
            - height (float, optional)
            - mesh_width (float, optional)
            - mesh_spec (str, optional)
            - roll_length (float, optional)
            - quantity (int, default=1)
            - accessories (list[dict], optional)
            - province (str, optional)
            - need_invoice (bool, default=False)
            - preferred_carrier (str, optional)

    Returns:
        符合 QuoteV2Response 格式的完整报价结果字典。
        NEVER 包含: cost_amount, margin_rate, base_fee, per_kg_after_threshold
    """
    product_category = request.get("product_category", "")

    # ── Step 0: 品类校验 ──
    if product_category != "牛栏网":
        return _build_response(
            status="unsupported_category",
            product_category=product_category,
            notes=[f"暂不支持品类: {product_category}，仅支持 牛栏网"],
        )

    quantity = request.get("quantity", 1)
    items: list[str] = []

    # ── Step 1: 规格匹配 ──
    spec_result = await match_spec(
        db=db,
        product_category=product_category,
        product_type=request.get("product_type"),
        wire_diameter=request.get("wire_diameter"),
        height=request.get("height"),
        mesh_width=request.get("mesh_width"),
        mesh_spec=request.get("mesh_spec"),
        roll_length=request.get("roll_length"),
    )
    items.append(spec_result["notes"])

    if spec_result["status"] != "matched":
        return _build_response(
            status=spec_result["status"],
            product_category=product_category,
            quantity=quantity,
            notes=items,
        )

    spec: ProductSpec = spec_result["spec"]
    spec_summary = _format_spec_summary(spec)

    # ── Step 2: 基准成本/售价 ──
    cost_result = await calculate_base_cost(
        db=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        spec=spec,
    )
    items.append(cost_result["notes"])

    if cost_result["status"] == "cost_pending":
        return _build_response(
            status="cost_pending",
            product_category=product_category,
            spec_summary=spec_summary,
            quantity=quantity,
            notes=items,
            weight_kg=spec.weight_kg,
        )

    # ── Step 3: 梯度定价 ──
    tier_result = await calculate_tiers(
        db=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_category=product_category,
        cost_amount=cost_result["amount"],
        base_cost_status=cost_result["status"],
        quantity=quantity,
        need_invoice=request.get("need_invoice", False),
    )
    items.append(tier_result["notes"])

    if tier_result["status"] == "pricing_profile_missing":
        return _build_response(
            status="pricing_profile_missing",
            product_category=product_category,
            spec_summary=spec_summary,
            quantity=quantity,
            notes=items,
            weight_kg=spec.weight_kg,
        )

    # ── Step 4: 配件计价 ──
    accessory_lines: list[dict] = []
    raw_accessories = request.get("accessories", [])
    if raw_accessories:
        acc_results = await price_accessories(
            db=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            accessories=raw_accessories,
        )
        for acc in acc_results:
            items.append(acc["notes"])
            accessory_lines.append({
                "product_category": acc["product_category"],
                "spec_summary": acc["spec_summary"],
                "quantity": acc["quantity"],
                "unit": acc["unit"],
                "total": acc["total"],
                "status": acc["status"],
            })

    # ── Step 5: 总重量 ──
    total_weight_kg = 0.0
    if spec.weight_kg:
        total_weight_kg += spec.weight_kg * quantity
    for acc in (raw_accessories or []):
        acc_qty = acc.get("quantity", 1)
        acc_specs = await _get_accessory_weight(db, acc)
        if acc_specs and acc_specs[0].weight_kg:
            total_weight_kg += acc_specs[0].weight_kg * acc_qty

    # ── Step 6: 运费计算 ──
    freight_info = None
    province = request.get("province")
    if province:
        freight_result = await calculate_freight(
            db=db,
            tenant_id=tenant_id,
            customer_id=customer_id,
            province=province,
            total_weight_kg=total_weight_kg,
            preferred_carrier=request.get("preferred_carrier"),
        )
        items.append(freight_result["notes"])
        freight_info = {
            "province": freight_result["province"],
            "chosen": freight_result.get("chosen"),
            "options": freight_result.get("options", []),
            "status": freight_result["status"],
        }

    # ── Step 7: 汇总 ──
    totals = _compute_totals(
        tiers=tier_result["tiers"],
        freight_chosen=freight_info.get("chosen") if freight_info else None,
    )

    # ── Step 8: 话术脚本 ──
    quote_result = {
        "status": "matched",
        "product_category": product_category,
        "spec_summary": spec_summary,
        "quantity": quantity,
        "weight_kg": spec.weight_kg,
        "tiers": tier_result["tiers"],
        "accessory_lines": accessory_lines,
        "freight": freight_info,
        "totals": totals,
        "notes": items,
    }
    copyable_script = render_quote_script(quote_result)

    return _build_response(
        status="matched",
        product_category=product_category,
        spec_summary=spec_summary,
        quantity=quantity,
        weight_kg=spec.weight_kg,
        tiers=tier_result["tiers"],
        accessory_lines=accessory_lines,
        freight=freight_info,
        totals=totals,
        notes=items,
        copyable_script=copyable_script,
    )


def _compute_totals(tiers: list[dict], freight_chosen: Optional[dict]) -> dict:
    """计算三档总价（含运费）。"""
    result = {"low": 0.0, "standard": 0.0, "high": 0.0}
    freight_amount = freight_chosen["amount"] if freight_chosen else 0.0

    tier_map = {"低": "low", "标准": "standard", "高": "high"}
    for t in tiers:
        key = tier_map.get(t.get("label", ""))
        if key:
            result[key] = round(t.get("total", 0) + freight_amount, 2)
    return result


async def _get_accessory_weight(db: AsyncSession, acc: dict) -> list:
    """为配件重量查询临时匹配规格。"""
    from app.repositories.product_specs_repo import match_specs
    return await match_specs(
        db=db,
        product_category=acc.get("product_category", ""),
        product_type=acc.get("product_type"),
        height=acc.get("height"),
    )


def _build_response(
    status: str = "matched",
    product_category: str = "",
    spec_summary: str = "",
    quantity: int = 1,
    weight_kg: Optional[float] = None,
    tiers: Optional[list] = None,
    accessory_lines: Optional[list] = None,
    freight: Optional[dict] = None,
    totals: Optional[dict] = None,
    notes: Optional[list] = None,
    copyable_script: str = "",
) -> dict:
    """构造符合 QuoteV2Response 的响应字典。

    NEVER 包含: cost_amount, margin_rate, base_fee, per_kg_after_threshold
    """
    from app.services.quote_script_renderer import render_quote_script

    result = {
        "status": status,
        "product_category": product_category,
        "main_line": {
            "product_category": product_category,
            "spec_summary": spec_summary,
            "quantity": quantity,
            "unit": "卷",
            "weight_kg": weight_kg,
            "tiers": tiers or [],
            "status": status if status in ("matched",) else "unavailable",
        },
        "accessory_lines": accessory_lines or [],
        "freight": freight,
        "totals": totals or {"low": 0.0, "standard": 0.0, "high": 0.0},
        "notes": notes or [],
        "copyable_script": copyable_script,
    }

    # Auto-render script for error states
    if not copyable_script and status != "matched":
        result["copyable_script"] = render_quote_script(result)

    return result
