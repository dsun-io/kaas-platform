"""业务客户往来记录的装配：报价 → 报价单 / 订单 → 单证（纯函数，两端共用）。

设计见 `docs/CUSTOMER_DOCUMENTS_VIEW.md`。

为什么放在共享内核
------------------
"包含关系"是业务语义，不是某一端的查询细节。dev（SQLAlchemy）与 worker（asyncpg）
各自只负责把三类行查出来，**装配逻辑只有这一份** —— 否则两端迟早出现
「一边把只归属客户的单证算进报价、另一边算进 direct」这种极难发现的漂移。

输入/输出都是普通 dict / 可迭代对象，不依赖任何 ORM 或数据库驱动。
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any, Iterable, Mapping, Optional

__all__ = ["build_records", "EMPTY_RECORDS"]


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def _money(value: Any) -> Any:
    """金额统一成字符串：Decimal 直接 JSON 化会变成 float（丢精度）。"""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return str(value)
    return value


def _get(row: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row[name]
    return None


def _quote_out(row: Mapping[str, Any]) -> dict:
    return {
        "id": row["id"], "quote_no": _get(row, "quote_no"), "status": _get(row, "status"),
        "currency": _get(row, "currency"), "total_amount": _money(_get(row, "total_amount")),
        "created_at": _iso(_get(row, "created_at")),
    }


def _order_out(row: Mapping[str, Any]) -> dict:
    return {
        "id": row["id"], "order_no": _get(row, "order_no"), "status": _get(row, "status"),
        "currency": _get(row, "currency"), "total_amount": _money(_get(row, "total_amount")),
        "created_at": _iso(_get(row, "created_at")),
    }


def _doc_out(row: Mapping[str, Any]) -> dict:
    return {
        "id": row["id"], "doc_no": _get(row, "doc_no"), "doc_type": _get(row, "doc_type"),
        "status": _get(row, "status"), "currency": _get(row, "currency"),
        "total_amount": _money(_get(row, "total_amount")),
        "created_at": _iso(_get(row, "created_at")),
    }


EMPTY_RECORDS: dict = {"quotes": [], "direct": {"orders": [], "documents": []},
                       "counts": {"quotes": 0, "orders": 0, "documents": 0}}


def build_records(
    customer: Mapping[str, Any],
    quotes: Iterable[Mapping[str, Any]],
    orders: Iterable[Mapping[str, Any]],
    docs: Iterable[Mapping[str, Any]],
) -> dict:
    """把三类扁平行装配成**包含关系树**。

    规则（与数据库约束一致）：
    - 单证归属**二选一**：`quote_id`（报价单）或 `order_id`（PI/CI/PL/BL）
    - 订单挂 `quote_id`（可空 = 手动新建 / 导入已有数据）
    - 父对象缺失或已被删除的单证/订单 → 落 **`direct`（只归属客户）**，
      **不允许从树上消失** —— 用户明确要求"能查到历史数据"
    """
    quotes = list(quotes or ())
    orders = list(orders or ())
    docs = list(docs or ())

    quote_nodes = {r["id"]: {**_quote_out(r), "documents": [], "orders": []} for r in quotes}
    order_nodes = {r["id"]: {**_order_out(r), "documents": []} for r in orders}
    direct: dict = {"orders": [], "documents": []}

    for d in docs:
        item = _doc_out(d)
        qid, oid = _get(d, "quote_id"), _get(d, "order_id")
        if qid is not None and qid in quote_nodes:
            quote_nodes[qid]["documents"].append(item)
        elif oid is not None and oid in order_nodes:
            order_nodes[oid]["documents"].append(item)
        else:
            direct["documents"].append(item)

    for r in orders:
        node = order_nodes[r["id"]]
        qid = _get(r, "quote_id")
        if qid is not None and qid in quote_nodes:
            quote_nodes[qid]["orders"].append(node)
        else:
            direct["orders"].append(node)

    name: Optional[str] = _get(customer, "company_name", "name")
    return {
        "customer": {"id": _get(customer, "id"), "name": name,
                     "team_id": _get(customer, "team_id")},
        # counts 要包含 direct 里的数据，否则客户页标题栏会少算
        "counts": {"quotes": len(quote_nodes), "orders": len(order_nodes),
                   "documents": len(docs)},
        "quotes": list(quote_nodes.values()),
        "direct": direct,
    }
