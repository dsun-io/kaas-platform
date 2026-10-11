"""往来记录树（`build_records`）的单测 —— 纯函数，不需要数据库。

这是"客户能查到历史报价/订单/单证"的核心装配逻辑，重点钉住三件事：
1. 报价 → 报价单 / 订单 → 单证 的包含关系正确
2. **手动新建 / 导入**的无报价订单、只归属客户的单证进 `direct`（不能凭空消失）
3. 计数准确（前端标题栏直接显示）
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()

from kaas_common.workstation.customer_records import build_records  # noqa: E402


def _quote(i, no, **over):
    row = {"id": i, "quote_no": no, "status": "accepted", "currency": "USD",
           "total_amount": "12300.00", "created_at": f"2026-09-2{i}T10:00:00Z"}
    row.update(over)
    return row


def _order(i, no, quote_id=None, **over):
    row = {"id": i, "order_no": no, "quote_id": quote_id, "status": "confirmed",
           "currency": "USD", "total_amount": "12300.00",
           "created_at": f"2026-09-2{i}T12:00:00Z"}
    row.update(over)
    return row


def _doc(i, no, doc_type, quote_id=None, order_id=None, **over):
    row = {"id": i, "doc_no": no, "doc_type": doc_type, "quote_id": quote_id,
           "order_id": order_id, "status": "issued", "currency": "USD",
           "total_amount": None, "created_at": f"2026-09-2{i}T09:00:00Z"}
    row.update(over)
    return row


CUSTOMER = {"id": 7, "company_name": "Tim Trading", "team_id": 1}


def test_quote_with_quotation_and_order_with_docs():
    """正常业务流程：报价 →（报价单）；报价 → 订单 →（PI/CI）。"""
    tree = build_records(
        CUSTOMER,
        quotes=[_quote(4, "QUO-4")],
        orders=[_order(1, "ORD-1", quote_id=4)],
        docs=[_doc(12, "QUO-4", "quotation", quote_id=4),
              _doc(2, "CI-1", "ci", order_id=1),
              _doc(3, "PI-2", "pi", order_id=1)],
    )
    assert tree["customer"] == {"id": 7, "name": "Tim Trading", "team_id": 1}
    assert tree["counts"] == {"quotes": 1, "orders": 1, "documents": 3}
    q = tree["quotes"][0]
    assert [d["doc_no"] for d in q["documents"]] == ["QUO-4"]      # 报价单挂报价
    assert [o["order_no"] for o in q["orders"]] == ["ORD-1"]
    assert sorted(d["doc_no"] for d in q["orders"][0]["documents"]) == ["CI-1", "PI-2"]
    assert tree["direct"] == {"orders": [], "documents": []}


def test_manual_and_imported_data_go_to_direct():
    """手动新建的无报价订单、只归属客户的单证 → direct（用户要能查到导入的历史）。"""
    tree = build_records(
        CUSTOMER,
        quotes=[_quote(4, "QUO-4")],
        orders=[_order(9, "ORD-MANUAL", quote_id=None)],
        docs=[_doc(5, "CI-IMPORTED", "ci"),                       # 无 quote 无 order
              _doc(6, "PL-MANUAL", "pl", order_id=9)],            # 挂手动订单
    )
    assert [o["order_no"] for o in tree["direct"]["orders"]] == ["ORD-MANUAL"]
    assert [d["doc_no"] for d in tree["direct"]["documents"]] == ["CI-IMPORTED"]
    assert [d["doc_no"] for d in tree["direct"]["orders"][0]["documents"]] == ["PL-MANUAL"]
    # 计数包含 direct 里的数据（否则标题栏会少算）
    assert tree["counts"] == {"quotes": 1, "orders": 1, "documents": 2}


def test_multiple_quotes_keep_containment():
    tree = build_records(
        CUSTOMER,
        quotes=[_quote(4, "QUO-4"), _quote(3, "QUO-3")],
        orders=[_order(1, "ORD-1", quote_id=4), _order(2, "ORD-2", quote_id=3)],
        docs=[_doc(1, "QUO-4", "quotation", quote_id=4),
              _doc(2, "QUO-3", "quotation", quote_id=3)],
    )
    by_no = {q["quote_no"]: q for q in tree["quotes"]}
    assert [d["doc_no"] for d in by_no["QUO-4"]["documents"]] == ["QUO-4"]
    assert [o["order_no"] for o in by_no["QUO-3"]["orders"]] == ["ORD-2"]
    assert tree["counts"] == {"quotes": 2, "orders": 2, "documents": 2}


def test_doc_pointing_at_unknown_parent_falls_back_to_direct():
    """脏数据（父对象已被删）不能让单证从树上消失 —— 落到 direct。"""
    tree = build_records(
        CUSTOMER, quotes=[], orders=[],
        docs=[_doc(5, "CI-ORPHAN", "ci", order_id=999)],
    )
    assert [d["doc_no"] for d in tree["direct"]["documents"]] == ["CI-ORPHAN"]
    assert tree["counts"]["documents"] == 1


def test_empty_customer_returns_empty_tree():
    tree = build_records(CUSTOMER, quotes=[], orders=[], docs=[])
    assert tree["quotes"] == [] and tree["direct"] == {"orders": [], "documents": []}
    assert tree["counts"] == {"quotes": 0, "orders": 0, "documents": 0}
