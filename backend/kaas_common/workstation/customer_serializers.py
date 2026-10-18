"""客户/询盘序列化 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。

2026-10-18：客户阶段拆成两层
---------------------------
`customers.stage` 只存**手动状态**（active / inactive），而接口里对外的
`stage` 是**推导值**（有开启中的订单 ⇒ ordered）。所以序列化拆成两个字段：

  · `manual_stage` —— 库里的手动状态（客户页下拉用它回填）
  · `stage`        —— 对外展示值（活跃 / 沉寂 / 已下单）

`row_to_customer(c, display_stage=...)` 的 `display_stage` 由调用方用
`customer_rules.derive_customer_stage()` 算好传进来；不传时退回手动状态
（新建客户必然没有订单，等价于 active）。
"""
from typing import Any, Optional

from .customer_rules import normalize_manual_stage

__all__ = ["row_to_customer", "row_to_inquiry"]


def row_to_customer(c: Any, display_stage: Optional[str] = None) -> dict:
    """客户 ORM 行/字典 → API 响应字典。

    `display_stage`：调用方按订单推导出的展示阶段（ordered / active / inactive）；
    缺省时用库里的手动阶段归一化后的值。
    """
    if isinstance(c, dict):
        g = c.get
    else:
        g = lambda k: getattr(c, k, None)
    manual = normalize_manual_stage(g("stage"))
    return {
        "id": g("id"),
        "company_name": g("name"),
        # 客户缩写（询盘编号用；可空）
        "abbr": g("abbr"),
        "country": g("country"),
        "address": g("address"),
        "default_port": g("default_port"),
        "credit_level": g("credit_level"),
        # 对外展示阶段（活跃 / 沉寂 / 已下单）
        "stage": display_stage or manual,
        # 手动状态（活跃 / 沉寂）—— 客户页「更新阶段」用它回填
        "manual_stage": manual,
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
        "inquiry_no": g("inquiry_no"),
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
