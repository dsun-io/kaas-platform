"""订单/付款计划/应收/实收序列化 —— 纯函数、零三方依赖（stdlib only）。

orchestrator 与 Worker 共用；任何适配层不得另写一份判定。

2026-10-22（设计 §13.3）：订单金额构成 + 实收登记
-----------------------------------------------
- `orders.amount_breakdown`（jsonb）：四项金额
  `{goods_amount, freight_amount, insurance_amount, other_amount}`；
  订单总额仍以 `orders.total_amount` 为准（历史行没有 amount_breakdown ⇒ null）。
- `payment_receipts`（一次收款一行）：`row_to_receipt` 输出前端消费的键；
  `schedule_id` 可空（未分配收款），`amount` 是实际到账金额（可与期次金额不同）。

2026-10-22（设计 §3.2 / §5.1，迁移 202610220004）：订单来源与确认痕迹
---------------------------------------------------------------
- `row_to_order` 增加 `source_type` / `source_channel` / `inquiry_id` / `quote_id`
  与 `confirmed_at` / `confirmed_by` / `confirmed_source`。
  `source_type` 缺省输出 `direct`（迁移已给列设 server_default，但**读历史库**时
  可能拿到 NULL，前端不该看到 null 再自己判）。
"""
import json
from typing import Any

__all__ = [
    "row_to_order", "row_to_order_item", "row_to_schedule", "row_to_receivable",
    "row_to_receipt", "normalize_amount_breakdown",
]

AMOUNT_BREAKDOWN_KEYS = (
    "goods_amount", "freight_amount", "insurance_amount", "other_amount",
)


def row_to_order(o: Any) -> dict:
    g = _getter(o)
    return {
        "id": g("id"), "order_no": g("order_no"), "customer_id": g("customer_id"),
        "customer_name": g("customer_name"), "status": g("status"), "currency": g("currency"),
        "total_amount": _float(g("total_amount")),
        # 金额构成（迁移 202610220001）：历史订单为 null，前端回退 total_amount。
        "amount_breakdown": _json_obj(g("amount_breakdown")),
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
        # ── 来源三元组（迁移 202610220004，设计 §3.2）──────────────────────
        # inquiry=询盘转化（含经报价转化）/ direct=直接下单。订单是一等公民，
        # 两种来源都合法；`source_channel` 可空 = 渠道未知（历史单不伪造）。
        "source_type": g("source_type") or "direct",
        "source_channel": g("source_channel"),
        "inquiry_id": g("inquiry_id"),
        "quote_id": g("quote_id"),
        # 确认痕迹（设计 §5.1）：三者同时为空 = 未确认；confirmed_source 区分
        # 人工确认(manual)与定金到账联动(deposit_receipt)。
        "confirmed_at": _iso(g("confirmed_at")),
        "confirmed_by": g("confirmed_by"),
        "confirmed_source": g("confirmed_source"),
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


def row_to_receipt(r: Any) -> dict:
    """实收登记行 → API 响应（前端订单详情/收款计划面板消费的 10 键）。"""
    g = _getter(r)
    return {
        "id": g("id"),
        "order_id": g("order_id"),
        # 可空：一笔款暂不指定期次（页面「未分配收款」区）
        "schedule_id": g("schedule_id"),
        "amount": _float(g("amount")),
        "currency": g("currency"),
        # 到账日期（date → YYYY-MM-DD）
        "received_date": _iso(g("received_date")),
        "fx_rate": _float(g("fx_rate")),
        # 到账截图：挂在 file_objects(owner_type='payment_receipt') 的当前件
        "file_id": g("file_id"),
        "notes": g("notes"),
        "created_at": _iso(g("created_at")),
    }


def normalize_amount_breakdown(raw: Any):
    """入参 amount_breakdown → 只保留四项金额（数字）的 dict；空/非法返回 None。

    不落 total —— 订单总额的唯一真源是 `orders.total_amount`，两份会有漂移。
    """
    if isinstance(raw, str):
        try:
            raw = json.loads(raw) if raw.strip() else None
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    out = {k: _float(raw.get(k)) for k in AMOUNT_BREAKDOWN_KEYS}
    if all(v is None for v in out.values()):
        return None
    # 缺项按 0 处理：前端只填了运费时，货物金额单独看由订单行汇总负责
    return {k: (0.0 if v is None else v) for k, v in out.items()}


def _getter(obj):
    if isinstance(obj, dict):
        return obj.get
    return lambda k: getattr(obj, k, None)


def _float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _json_obj(v):
    """jsonb 列：asyncpg 在 Workers 里可能返回 str；解析失败按 None（不抛 500）。"""
    if isinstance(v, str):
        try:
            return json.loads(v) if v.strip() else None
        except ValueError:
            return None
    return v


def _iso(dt):
    if dt is None:
        return None
    if hasattr(dt, "isoformat"):
        return dt.isoformat()
    return str(dt)
