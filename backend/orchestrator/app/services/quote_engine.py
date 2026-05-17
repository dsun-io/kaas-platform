"""Kaas v2 · INT-R3 报价引擎主流程 (§5 T6)

编排 spec 匹配 → 成本计算 → 梯度定价 → 配件计价 → 运费计算 → 话术生成。
SKU 优先路径: 先查 product_skus + product_sku_prices，命中则短路返回。
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_

from app.db.models import ProductSpec, ProductSku, ProductSkuPrice, ProductCategory
from app.domain.category_normalizer import normalize_category
from app.domain.spec_hash import compute_sku_hash
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
    """创建报价主流程。

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
    raw_category = request.get("product_category", "")
    product_category = normalize_category(raw_category)

    # ── Step 0: 品类校验 ──
    if product_category not in ("niulanwang", "gouhuawang", "post", "gabion"):
        return _build_response(
            status="unsupported_category",
            product_category=product_category,
            notes=[f"暂不支持品类: {raw_category or product_category}，请人工确认"],
        )

    quantity = request.get("quantity", 1)
    items: list[str] = []

    # ── Step 0.5: SKU 优先查询路径 ──
    sku_result = await _try_sku_path(db, tenant_id, product_category, request, quantity)
    if sku_result is not None:
        return sku_result

    # ── Step 1: 规格匹配（fallback 到老 product_specs）──
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
        tax_rate_override=request.get("tax_rate"),
    )
    items.append(tier_result["notes"])

    if tier_result["status"] in ("pricing_profile_missing", "cost_pending"):
        return _build_response(
            status=tier_result["status"],
            product_category=product_category,
            spec_summary=spec_summary,
            quantity=quantity,
            notes=items,
            weight_kg=spec.weight_kg,
        )

    # 对外报价响应不得包含 margin_rate（铁律: NEVER 暴露利润率）
    for t in tier_result.get("tiers", []):
        t.pop("margin_rate", None)

    # ── Step 4: 配件计价 ──
    accessory_lines: list[dict] = []
    raw_accessories = request.get("accessories", [])
    acc_results: list[dict] = []
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

    # ── Step 5: 总重量（复用 price_accessories 已匹配的规格，避免二次查库且字段不一致） ──
    total_weight_kg = 0.0
    if spec.weight_kg:
        total_weight_kg += spec.weight_kg * quantity
    for acc_result in acc_results:
        acc_weight = acc_result.get("weight_kg")
        if acc_weight:
            total_weight_kg += acc_weight * acc_result.get("quantity", 1)

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
        base_cost=tier_result.get("base_cost"),
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


def _unit_for(category: str) -> str:
    """根据产品品类返回计价单位。"""
    return {"niulanwang": "卷", "gouhuawang": "卷", "post": "根", "gabion": "个"}.get(category, "个")


def _filter_internal_notes(notes: list[str]) -> list[str]:
    """过滤内部经营数据，notes 不暴露成本/利润率等敏感信息。"""
    blocked_keywords = ["成本价", "利润率", "命中客户成本价", "配件"]
    result = []
    for n in notes:
        if any(kw in n for kw in blocked_keywords):
            if "利润率" in n:
                result.append("已应用报价倍率")
            else:
                result.append("已应用客户价格")
        else:
            result.append(n)
    return result


def _build_response(
    status: str = "matched",
    product_category: str = "",
    spec_summary: str = "",
    quantity: int = 1,
    weight_kg: Optional[float] = None,
    base_cost: Optional[float] = None,
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

    unit = _unit_for(product_category)

    result = {
        "status": status,
        "product_category": product_category,
        "main_line": {
            "product_category": product_category,
            "spec_summary": spec_summary,
            "quantity": quantity,
            "unit": unit,
            "weight_kg": weight_kg,
            "base_cost": base_cost,
            "tiers": tiers or [],
            "status": status if status in ("matched",) else "unavailable",
        },
        "accessory_lines": accessory_lines or [],
        "freight": freight,
        "totals": totals or {"low": 0.0, "standard": 0.0, "high": 0.0},
        "notes": _filter_internal_notes(notes) if notes else [],
        "copyable_script": copyable_script,
    }

    # Auto-render script for error states
    if not copyable_script and status != "matched":
        result["copyable_script"] = render_quote_script(result)

    return result


async def _try_sku_path(
    db: AsyncSession,
    tenant_id: str,
    product_category: str,
    request: dict,
    quantity: int,
) -> Optional[dict]:
    """
    SKU 优先查询路径:
    1. 按品类 + spec_values 计算 hash
    2. 在 product_skus 中查找匹配
    3. 在 product_sku_prices 中查找 active 价格
    4. 命中则构造简化的报价响应返回; 未命中返回 None
    """
    # 构建 spec_values（只取有值的字段）
    spec_keys = ["product_type", "wire_diameter", "height", "mesh_width", "mesh_spec", "roll_length"]
    spec_values = {}
    for k in spec_keys:
        v = request.get(k)
        if v is not None and v != "":
            spec_values[k] = v

    if not spec_values:
        return None

    # 查找品类 code → id
    cat_result = await db.execute(
        select(ProductCategory.id).where(ProductCategory.code == product_category)
    )
    cat_row = cat_result.first()
    if not cat_row:
        return None
    category_id = cat_row[0]

    # 计算 spec_hash（使用新系统）
    spec_hash = compute_sku_hash(product_category, spec_values, None, None)

    # 查找 SKU
    sku_result = await db.execute(
        select(ProductSku).where(
            and_(
                ProductSku.tenant_id == tenant_id,
                ProductSku.category_id == category_id,
                ProductSku.spec_hash == spec_hash,
            )
        )
    )
    sku = sku_result.scalar_one_or_none()
    if not sku:
        return None

    # 查找 active 价格
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    price_result = await db.execute(
        select(ProductSkuPrice).where(
            and_(
                ProductSkuPrice.sku_id == sku.id,
                ProductSkuPrice.tenant_id == tenant_id,
                ProductSkuPrice.status == "active",
                ProductSkuPrice.effective_from <= now,
            )
        )
    )
    price = price_result.scalar_one_or_none()

    # 构建 spec_summary
    spec_summary_parts = [f"{k}={v}" for k, v in spec_values.items() if v]
    spec_summary = " | ".join(spec_summary_parts) if spec_summary_parts else "—"

    # 如果有价格，构造完整响应
    if price:
        unit_price = float(price.price)
        total = unit_price * quantity

        return _build_response(
            status="matched",
            product_category=product_category,
            spec_summary=spec_summary,
            quantity=quantity,
            weight_kg=float(sku.weight_kg) if sku.weight_kg else None,
            base_cost=unit_price,
            tiers=[{
                "label": "标准",
                "unit_price": unit_price,
                "subtotal": total,
                "total": total,
            }],
            notes=[f"SKU 路径命中 (sku_id={sku.id}, revision={sku.revision})"],
        )

    # SKU 存在但无价格
    return _build_response(
        status="cost_pending",
        product_category=product_category,
        spec_summary=spec_summary,
        quantity=quantity,
        weight_kg=float(sku.weight_kg) if sku.weight_kg else None,
        notes=[f"SKU 存在但未配置价格 (sku_id={sku.id})"],
    )
