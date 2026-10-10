"""订单/付款计划/应收序列化 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any

__all__ = ["row_to_order", "row_to_order_item", "row_to_schedule", "row_to_receivable"]


def row_to_order(o: Any) -> dict:
    g = _getter(o)
    return {
        "id": g("id"), "order_no": g("order_no"), "customer_id": g("customer_id"),
        "customer_name": g("customer_name"), "status": g("status"), "currency": g("currency"),
        "total_amount": _float(g("total_amount")),
        "order_date": _iso(g("order_date")),
        "delivery_date": _iso(g("delivery_date")),
        "notes": g("notes"),
        "fx_rate": _float(g("fx_rate")),
        "fx_rate_date": _iso(g("fx_rate_date")),
        "created_at": _iso(g("created_at")),
        "owner_id": g("owner_id"), "owner_scope": g("owner_scope"),
        "incoterm": g("incoterm"), "payment_terms": g("payment_terms"),
        "port_of_loading": g("port_of_loading"),
        "port_of_destination": g("port_of_destination"),
        "shipping_marks": g("shipping_marks"),
        "country_of_origin": g("country_of_origin"),
    }


def row_to_order_item(it: Any) -> dict:
    g = _getter(it)
    return {
        "id": g("id"), "sku_id": g("sku_id"), "product_name": g("product_name"),
        "spec_snapshot": g("spec_snapshot"),
        "qty": _float(g("qty")),
        "qty_unit": g("qty_unit"),
        "unit_price": _float(g("unit_price")),
        "currency": g("currency"),
        "line_amount": _float(g("line_amount")),
        "sort_order": g("sort_order"),
    }


def row_to_schedule(s: Any) -> dict:
    g = _getter(s)
    return {
        "id": g("id"), "order_id": g("order_id"), "trade_doc_id": g("trade_doc_id"),
        "schedule_type": g("schedule_type"),
        "ratio": _float(g("ratio")),
        "amount": _float(g("amount")),
        "currency": g("currency"), "due_date": _iso(g("due_date")),
        "actual_date": _iso(g("actual_date")), "status": g("status"),
        "fx_rate": _float(g("fx_rate")),
        "exchange_gain_loss": _float(g("exchange_gain_loss")),
        "notes": g("notes"),
        "created_at": _iso(g("created_at")),
    }


def row_to_receivable(r: Any) -> dict:
    g = _getter(r)
    return {
        "id": g("id"), "order_id": g("order_id"), "currency": g("currency"),
        "total_amount": _float(g("total_amount")),
        "fx_rate": _float(g("fx_rate")),
        "fx_rate_date": _iso(g("fx_rate_date")),
        "base_currency": g("base_currency"),
        "base_amount": _float(g("base_amount")),
        "received_amount": _float(g("received_amount")),
        "exchange_gain_loss": _float(g("exchange_gain_loss")),
        "status": g("status"),
        "created_at": _iso(g("created_at")),
    }


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
