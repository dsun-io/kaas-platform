"""Kaas v2 · INT-R3 牛栏网定价引擎 (§5 T3)

包含两层：
1. calculate_base_cost  — 优先查销售价覆盖，其次查成本价
2. calculate_tiers      — 基于成本 × 利润率计算三档报价
"""
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import ProductSpec
from app.repositories.sale_price_repo import get_current_sale_price
from app.repositories.cost_items_repo import get_current_cost
from app.repositories.pricing_profiles_repo import get_current_profile


async def calculate_base_cost(
    db: AsyncSession,
    tenant_id: str,
    customer_id: str,
    spec: ProductSpec,
) -> dict:
    """计算牛栏网基准成本/售价。

    优先级：
      1. CustomerSalePriceItem（客户销售价覆盖）→ sale_price_matched
      2. CustomerCostItem（客户成本价）        → matched
      3. 两者均无                               → cost_pending

    Returns:
        {
            "amount": float | None,      # 基准单价（元/卷，或销售价对应单位）
            "cost_type": str | None,     # cost_per_kg / cost_per_sqm / sale_per_roll …
            "currency": str,             # 币种
            "status": "matched"|"cost_pending"|"sale_price_matched",
            "notes": str,
        }
    """
    spec_hash = spec.spec_hash

    # Priority 1: 客户销售价覆盖
    sale_item = await get_current_sale_price(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        spec_hash=spec_hash,
    )
    if sale_item is not None:
        return {
            "amount": sale_item.amount,
            "cost_type": sale_item.sale_price_type,
            "currency": sale_item.currency,
            "status": "sale_price_matched",
            "notes": f"命中客户销售价: {sale_item.amount} {sale_item.currency}/{sale_item.unit}",
        }

    # Priority 2: 客户成本价
    cost_item = await get_current_cost(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        spec_hash=spec_hash,
    )
    if cost_item is not None:
        # 不同成本类型换算为单件成本
        amount = cost_item.amount
        if cost_item.cost_type == "cost_per_kg" and spec.weight_kg:
            amount = cost_item.amount * spec.weight_kg
        elif cost_item.cost_type == "cost_per_bundle" and spec.bundle_size and spec.bundle_size > 0:
            amount = cost_item.amount / spec.bundle_size
        return {
            "amount": amount,
            "cost_type": cost_item.cost_type,
            "currency": cost_item.currency,
            "status": "matched",
            "notes": f"命中客户成本价: {cost_item.amount} {cost_item.currency}/{cost_item.unit}",
        }

    # 两者均无
    return {
        "amount": None,
        "cost_type": None,
        "currency": "CNY",
        "status": "cost_pending",
        "notes": "未找到该规格的成本价或销售价，请人工确认",
    }


async def calculate_tiers(
    db: AsyncSession,
    tenant_id: str,
    customer_id: str,
    product_category: str,
    cost_amount: Optional[float],
    base_cost_status: str = "cost_pending",
    quantity: int = 1,
    need_invoice: bool = False,
    tax_rate_override: Optional[float] = None,
) -> dict:
    """基于定价策略 + 基准成本计算三档报价。

    逻辑：
      - 无定价策略 → {status: "pricing_profile_missing"}
      - 有策略但有售价覆盖 (sale_price_matched) → 三档统一为售价
      - 有策略且有成本 (matched) → cost × (1 + margin_rate)

    Returns:
        {
            "status": "matched"|"pricing_profile_missing",
            "tiers": [{"label", "unit_price", "subtotal", "total"}, ...],
            "tax_rate": float,
            "notes": str,
        }
    """
    profile = await get_current_profile(
        session=db,
        tenant_id=tenant_id,
        customer_id=customer_id,
        product_category=product_category,
    )

    if profile is None:
        return {
            "status": "pricing_profile_missing",
            "tiers": [],
            "tax_rate": 0.0,
            "notes": "未配置客户定价策略，请人工确认",
        }

    if not need_invoice:
        tax_rate = 0.0
    else:
        tax_rate = tax_rate_override if tax_rate_override is not None else (profile.tax_rate or 0.0)

    if cost_amount is None:
        return {
            "status": "cost_pending",
            "tiers": [],
            "base_cost": None,
            "tax_rate": tax_rate,
            "notes": "基准成本为空，无法计算报价梯度",
        }

    margin_rates = {
        "低": profile.low_margin_rate,
        "标准": profile.standard_margin_rate,
        "高": profile.high_margin_rate,
    }

    # 销售价覆盖时三档统一
    if base_cost_status == "sale_price_matched":
        tiers = [
            {
                "label": label,
                "margin_rate": None,
                "unit_price": round(cost_amount, 2),
                "subtotal": round(cost_amount * quantity, 2),
                "total": round(cost_amount * quantity * (1 + tax_rate), 2),
            }
            for label in ["低", "标准", "高"]
        ]
        return {
            "status": "matched",
            "tiers": tiers,
            "base_cost": round(cost_amount, 2),
            "tax_rate": tax_rate,
            "notes": "基于客户销售价覆盖，三档统一报价",
        }

    # 正常成本 × 利润率（margin_rate 为直接乘数，如 1.10 = 加价10%）
    low_price = cost_amount * profile.low_margin_rate
    standard_price = cost_amount * profile.standard_margin_rate
    high_price = cost_amount * profile.high_margin_rate

    tiers = [
        {
            "label": label,
            "margin_rate": margin_rates[label],
            "unit_price": round(price, 2),
            "subtotal": round(price * quantity, 2),
            "total": round(price * quantity * (1 + tax_rate), 2),
        }
        for label, price in [("低", low_price), ("标准", standard_price), ("高", high_price)]
    ]

    return {
        "status": "matched",
        "tiers": tiers,
        "base_cost": round(cost_amount, 2),
        "tax_rate": tax_rate,
        "notes": f"基于利润率 (低{profile.low_margin_rate*100:.0f}%/标准{profile.standard_margin_rate*100:.0f}%/高{profile.high_margin_rate*100:.0f}%) 计算",
    }
