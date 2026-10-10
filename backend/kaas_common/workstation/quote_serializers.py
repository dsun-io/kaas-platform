"""报价单/行项序列化与金额计算 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from decimal import Decimal
from typing import Any, Optional

__all__ = ["row_to_quote", "row_to_item", "calc_line_amount", "calc_items_total"]


def row_to_quote(q: Any, item_count: int = 0) -> dict:
    """报价单 ORM 行/字典 → API 响应字典。"""
    g = _getter(q)
    return {
        "id": g("id"), "quote_no": g("quote_no"),
        "customer_id": g("customer_id"), "customer_name": g("customer_name"),
        "inquiry_id": g("inquiry_id"),
        "status": g("status"), "currency": g("currency"),
        "total_amount": _float(g("total_amount")),
        "valid_until": _iso(g("valid_until")),
        "notes": g("notes"),
        "fx_rate": _float(g("fx_rate")),
        "fx_rate_date": _iso(g("fx_rate_date")),
        "created_at": _iso(g("created_at")),
        "owner_id": g("owner_id"), "owner_scope": g("owner_scope"),
        "item_count": item_count,
        "incoterm": g("incoterm"), "payment_terms": g("payment_terms"),
        "port_of_loading": g("port_of_loading"),
        "port_of_destination": g("port_of_destination"),
        "shipping_marks": g("shipping_marks"),
        "country_of_origin": g("country_of_origin"),
        "destination_country": g("destination_country"),
        "destination_region": g("destination_region"),
        "carrier": g("carrier"),
        "freight_valid_from": _iso(g("freight_valid_from")),
        "freight_valid_to": _iso(g("freight_valid_to")),
    }


def row_to_item(it: Any) -> dict:
    """报价行项 ORM 行/字典 → API 响应字典。"""
    g = _getter(it)
    return {
        "id": g("id"), "quote_order_id": g("quote_order_id"), "sku_id": g("sku_id"),
        "product_name": g("product_name"), "spec_snapshot": g("spec_snapshot"),
        "qty": _float(g("qty")),
        "qty_unit": g("qty_unit"),
        "unit_price": _float(g("unit_price")),
        "currency": g("currency"),
        "line_amount": _float(g("line_amount")),
        "sort_order": g("sort_order"),
        "policy_override": g("policy_override"),
        "price_source": g("price_source"),
        "cost_override": _float(g("cost_override")),
        "price_override": _float(g("price_override")),
        "weight_override": _float(g("weight_override")),
        "volume_override": _float(g("volume_override")),
        "image_url": g("image_url"),
        "created_at": _iso(g("created_at")),
    }


def calc_line_amount(qty: Any, unit_price: Any, line_amount: Any = None) -> Optional[Decimal]:
    """行金额 = 数量 × 单价；优先取前端算好的 line_amount（与单证 Amount 同源）。"""
    if line_amount is not None:
        return Decimal(str(line_amount))
    if unit_price is not None and qty is not None:
        return Decimal(str(qty)) * Decimal(str(unit_price))
    return None


def calc_items_total(rows: list) -> Decimal:
    """行项合计 = Σ 行金额。"""
    total = Decimal("0")
    for row in rows:
        line = calc_line_amount(
            _getter(row)("qty") if not isinstance(row, dict) else row.get("qty"),
            _getter(row)("unit_price") if not isinstance(row, dict) else row.get("unit_price"),
            _getter(row)("line_amount") if not isinstance(row, dict) else row.get("line_amount"),
        )
        if line is not None:
            total += line
    return total


def _getter(obj):
    if isinstance(obj, dict):
        return obj.get
    return lambda k: getattr(obj, k, None)


def _float(v):
    return float(v) if v is not None else None


def _iso(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)
