"""Kaas v2 · INT-R3 运费计算器 (§5 T5)

根据客户运费表 + 目的地省份 + 总重量计算运费选项。
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.repositories.freight_rates_repo import get_freight_rates


async def calculate_freight(
    db: AsyncSession,
    tenant_id: str,
    customer_id: str,
    province: str,
    total_weight_kg: float,
    preferred_carrier: Optional[str] = None,
) -> dict:
    """计算运费。

    从客户运费表中查询该省份的活跃运费方案，
    按 formula_type 计算运费金额。

    formula_type 规则:
      - fixed:           amount = fixed_fee
      - per_kg:          amount = total_weight_kg × per_kg_after_threshold
      - base_plus_weight: amount = base_fee + max(0, weight - threshold) × per_kg_after_threshold

    Returns:
        {
            "status": "matched"|"freight_missing",
            "province": str,
            "chosen": {"carrier": str, "amount": float} | None,
            "options": [{"carrier": str, "amount": float}, ...],
            "notes": str,
        }
    """
    rates = await get_freight_rates(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        province=province,
    )

    if not rates:
        return {
            "status": "freight_missing",
            "province": province,
            "chosen": None,
            "options": [],
            "notes": f"未配置 {province} 运费方案，请人工确认",
        }

    options = []
    for rate in rates:
        amount = _apply_freight_formula(rate, total_weight_kg)
        if amount is not None:
            options.append({
                "carrier": rate.carrier,
                "amount": round(amount, 2),
            })

    if not options:
        return {
            "status": "freight_missing",
            "province": province,
            "chosen": None,
            "options": [],
            "notes": f"{province} 运费方案均无法计算有效金额",
        }

    # 选择首选承运商或取第一个
    chosen = None
    if preferred_carrier:
        for opt in options:
            if opt["carrier"] == preferred_carrier:
                chosen = opt
                break

    if chosen is None:
        chosen = options[0]

    return {
        "status": "matched",
        "province": province,
        "chosen": chosen,
        "options": options,
        "notes": f"已计算运费: {chosen['carrier']} {chosen['amount']} 元",
    }


def _apply_freight_formula(rate, total_weight_kg: float) -> Optional[float]:
    """根据运费公式类型计算金额。"""
    if rate.formula_type == "fixed":
        return rate.fixed_fee

    if rate.formula_type == "per_kg":
        if rate.per_kg_after_threshold is not None:
            return total_weight_kg * rate.per_kg_after_threshold
        return None

    if rate.formula_type == "base_plus_weight":
        base = rate.base_fee or 0.0
        threshold = rate.threshold_kg or 0.0
        per_kg = rate.per_kg_after_threshold or 0.0
        extra_weight = max(0, total_weight_kg - threshold)
        return base + extra_weight * per_kg

    return None
