"""单证数据装配助手（Worker）—— main.py 与 ws_docs_ext.py 共用的**唯一实现**。

为什么需要这个文件（这是一次生产事故的修复）
--------------------------------------------
`e5ab56e`「单证数据装配下沉到共享内核」删掉了 main.py 里 11KB 的镜像实现，
**但调用点没跟着改** —— main.py 的 9 处调用（`_doc_dict` / `_snap_rows` /
`_seller_block` / `_buyer_block` / `_clean` / `_order_snapshot` / `_quote_snapshot` /
`_inquiry_snapshot`）指向的函数在运行期根本不存在：

    POST /api/v1/trade-docs             → NameError（生产 500）
    GET  /api/v1/trade-docs/{id}        → NameError
    PATCH /api/v1/trade-docs/{id}       → NameError
    GET  /api/v1/trade-docs/{id}/render-data → NameError
    GET  /api/v1/tenant/company-profile → NameError      （只有 GET 列表是好的）

静态检查（import）发现不了：这些名字只在**函数体内**被引用，Python 到调用时才解析。
所以本模块既修 bug，也把它变成**一份实现**（main 与 ws_docs_ext 都从这里取），
避免下次再出现「改了一处、另一处还是旧的」。

分工
----
- 纯映射（卖方/买方区块、空值过滤、单证投影）来自共享内核
  `kaas_common.trade_doc.payload_shared`，本文件只做 re-export，不重写判定。
- 需要读库的快照在这里实现（`db` 由调用方传入，Worker 是单租户 `DEFAULT_TENANT`）。
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import HTTPException

from kaas_common.trade_doc.payload_shared import (  # noqa: F401  (re-export)
    buyer_block,
    clean,
    seller_block,
)

DEFAULT_TENANT = "default"


# ── 投影助手 ────────────────────────────────────────────────────────────────

def _f(value) -> Optional[float]:
    return float(value) if value is not None else None


def _iso(value) -> Optional[str]:
    return value.isoformat() if value is not None else None


def payload_of(row) -> dict:
    """raw_payload 归一成 dict。

    `db.*` 传了 `table="trade_docs"` 时 jsonb 已解码；这里再兜一层字符串，
    因为老数据/异常路径可能拿到未解码文本 —— 返回字符串会让前端 zod 报类型错。
    """
    payload = row.get("raw_payload") if hasattr(row, "get") else row["raw_payload"]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            payload = {}
    return payload if isinstance(payload, dict) else {}


def payload_parts(row) -> tuple[dict, dict]:
    """raw_payload → (sources, custom)（与 orchestrator `_payload_parts` 同义）。"""
    payload = payload_of(row)
    return payload.get("sources") or {}, payload.get("custom") or {}


def doc_dict(row) -> dict:
    """trade_docs 行 → 输出。

    返回**整行**（与列表端点 `_row_to_dict(r, "trade_docs")` 同形，前端同一套解析），
    再把 raw_payload 归一成对象、金额/时间转成可 JSON 化的形式。
    """
    d = dict(row)
    d["total_amount"] = _f(d.get("total_amount"))
    d["issued_at"] = _iso(d.get("issued_at"))
    d["created_at"] = _iso(d.get("created_at"))
    d["raw_payload"] = payload_of(d)
    return d


def buyer_block_of(customer, contact=None) -> dict:
    """买方区块（共享内核 buyer_block 的薄封装，签名对齐 orchestrator `_buyer_of` 的产物）。"""
    return buyer_block(customer, contact)


# ── 上游快照（字段清单 = 已落库数据的契约，不得「顺手改好一点」）─────────────

async def order_snapshot(db, request, order_id: int) -> dict:
    """订单快照（含行项与贸易条款）——字段与 orchestrator `_order_snapshot` 逐条一致。"""
    o = await db.fetchrow(
        request, "SELECT * FROM orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, order_id, table="orders",
    )
    if o is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "ORDER_NOT_FOUND"})
    items = await db.fetch(
        request,
        "SELECT product_name, qty, qty_unit, unit_price, line_amount, spec_snapshot"
        " FROM order_items WHERE tenant_id=$1 AND order_id=$2 ORDER BY sort_order, id",
        DEFAULT_TENANT, o["id"], table="order_items",
    )
    return {
        "order_no": o["order_no"], "customer_id": o["customer_id"],
        "customer_name": o["customer_name"], "status": o["status"],
        "currency": o["currency"], "total_amount": _f(o["total_amount"]),
        "fx_rate": _f(o["fx_rate"]),
        # 贸易条款冻进快照：单据上的条款必须等于开单当时的条款，
        # 而不是"现在去订单表读"（订单改了会污染历史单据）
        "incoterm": o["incoterm"], "payment_terms": o["payment_terms"],
        "port_of_loading": o["port_of_loading"],
        "port_of_destination": o["port_of_destination"],
        "shipping_marks": o["shipping_marks"],
        "country_of_origin": o["country_of_origin"],
        "items": [{
            "product_name": i["product_name"], "qty": _f(i["qty"]),
            "qty_unit": i["qty_unit"], "unit_price": _f(i["unit_price"]),
            "line_amount": _f(i["line_amount"]),
            # 规格快照必须带：报关/装箱的核心列（规格、HS Code、毛净重）都在里面
            "spec_snapshot": i["spec_snapshot"],
        } for i in items],
    }


async def quote_snapshot(db, request, quote_id: int) -> dict:
    """报价快照——字段与 orchestrator `_quote_snapshot` 逐条一致（注意不含 fx_rate）。"""
    q = await db.fetchrow(
        request, "SELECT * FROM quote_orders WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, quote_id, table="quote_orders",
    )
    if q is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "QUOTE_NOT_FOUND"})
    items = await db.fetch(
        request,
        "SELECT product_name, qty, qty_unit, unit_price, line_amount, spec_snapshot"
        " FROM quote_order_items WHERE tenant_id=$1 AND quote_order_id=$2"
        " ORDER BY sort_order, id",
        DEFAULT_TENANT, q["id"], table="quote_order_items",
    )
    return {
        "quote_no": q["quote_no"], "customer_id": q["customer_id"],
        "customer_name": q["customer_name"], "status": q["status"],
        "currency": q["currency"], "total_amount": _f(q["total_amount"]),
        "incoterm": q["incoterm"], "payment_terms": q["payment_terms"],
        "port_of_loading": q["port_of_loading"],
        "port_of_destination": q["port_of_destination"],
        "shipping_marks": q["shipping_marks"],
        "country_of_origin": q["country_of_origin"],
        "items": [{
            "product_name": i["product_name"], "qty": _f(i["qty"]),
            "qty_unit": i["qty_unit"], "unit_price": _f(i["unit_price"]),
            "line_amount": _f(i["line_amount"]),
            "spec_snapshot": i["spec_snapshot"],
        } for i in items],
    }


async def inquiry_snapshot(db, request, inquiry_id: int) -> dict:
    """询盘快照——字段与 orchestrator `_inquiry_snapshot` 逐条一致。"""
    i = await db.fetchrow(
        request, "SELECT * FROM cust_inquiries WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, inquiry_id, table="cust_inquiries",
    )
    if i is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "INQUIRY_NOT_FOUND"})
    return {
        "inquiry_id": i["id"], "customer_id": i["customer_id"], "status": i["status"],
        "channel": i["channel"], "product_name_raw": i["product_name_raw"],
        "quantity": _f(i["quantity"]),
        "quantity_unit": i["quantity_unit"], "application": i["application"],
    }


async def get_doc_or_404(db, request, doc_id: int, user: Optional[dict] = None) -> dict:
    """取单证；给了 `user` 时按 C27 团队/owner 可见性过滤（不可见 ⇒ 404）。

    为什么把可见性放在这里而不是各端点：`ws_docs_ext` 的 7 个读/写入口全部经本函数，
    一处收口才不会出现"补了 A 入口、漏了 B 入口"。判定口径与 `main._doc_visible`
    完全一致（internal 含非管理员跨团队、customer 仅本团队/owner/tenant 共享、
    无团队客户 404）—— 两个模块不互相 import 是为了避免 main↔doc_payload 循环。
    """
    row = await db.fetchrow(
        request, "SELECT * FROM trade_docs WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, doc_id, table="trade_docs",
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "DOC_NOT_FOUND"})
    if user is not None:
        from kaas_common.workstation.scope import is_admin_role

        privileged = (user.get("account_type") == "internal"
                      or is_admin_role(user.get("role")))
        if not privileged:
            row_team, viewer_team = row.get("team_id"), user.get("team_id")
            visible = (
                row.get("owner_scope") == "tenant"
                or (row.get("owner_id") is not None
                    and str(row.get("owner_id")) == str(user.get("id")))
                or (row_team is not None and viewer_team is not None
                    and str(row_team) == str(viewer_team))
            )
            if viewer_team is None or not visible:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "DOC_NOT_FOUND"})
    return row
