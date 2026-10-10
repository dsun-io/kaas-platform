"""客户/询盘序列化 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。
"""
from typing import Any, Optional

__all__ = ["row_to_customer", "row_to_inquiry"]


def row_to_customer(c: Any) -> dict:
    """客户 ORM 行/字典 → API 响应字典。"""
    if isinstance(c, dict):
        g = c.get
    else:
        g = lambda k: getattr(c, k, None)
    return {
        "id": g("id"),
        "company_name": g("name"),
        "country": g("country"),
        "address": g("address"),
        "default_port": g("default_port"),
        "credit_level": g("credit_level"),
        "stage": g("stage"),
        "notes": g("notes"),
        "created_at": _iso(g("created_at")),
        "updated_at": _iso(g("updated_at")),
    }


def row_to_inquiry(i: Any) -> dict:
    """询盘 ORM 行/字典 → API 响应字典。"""
    if isinstance(i, dict):
        g = i.get
    else:
        g = lambda k: getattr(i, k, None)
    qty = g("quantity")
    return {
        "id": g("id"),
        "customer_id": g("customer_id"),
        "lead_id": g("lead_id"),
        "channel": g("channel"),
        "category_id": g("category_id"),
        "product_name_raw": g("product_name_raw"),
        "quantity": float(qty) if qty is not None else None,
        "quantity_unit": g("quantity_unit"),
        "application": g("application"),
        "status": g("status"),
        "created_at": _iso(g("created_at")),
    }


def _iso(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)
