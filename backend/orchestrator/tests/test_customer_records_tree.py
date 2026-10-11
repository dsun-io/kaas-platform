"""往来记录树装配的单测（共享内核，两端共用同一份实现）。

为什么单独钉住：这是"客户能查到历史报价/订单/单证"的核心装配逻辑。
一旦装配口径漂移（比如把只归属客户的单证算进某个报价），
前端会静默少显示数据 —— 这种错最难在界面上发现。
"""
import pytest

from kaas_common.workstation.customer_records import build_records

pytestmark = pytest.mark.unit

CUSTOMER = {"id": 7, "company_name": "Tim Trading", "team_id": 1}


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


def test_normal_flow_quote_to_quotation_and_order_to_docs():
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
    assert [d["doc_no"] for d in q["documents"]] == ["QUO-4"]        # 报价单挂报价
    assert [o["order_no"] for o in q["orders"]] == ["ORD-1"]
    assert sorted(d["doc_no"] for d in q["orders"][0]["documents"]) == ["CI-1", "PI-2"]
    assert tree["direct"] == {"orders": [], "documents": []}


def test_manual_and_imported_data_land_in_direct():
    """手动新建的无报价订单、只归属客户的单证 → direct（用户要能查到导入的历史）。"""
    tree = build_records(
        CUSTOMER,
        quotes=[_quote(4, "QUO-4")],
        orders=[_order(9, "ORD-MANUAL", quote_id=None)],
        docs=[_doc(5, "CI-IMPORTED", "ci"),                    # 无 quote 无 order
              _doc(6, "PL-MANUAL", "pl", order_id=9)],         # 挂手动订单
    )
    assert [o["order_no"] for o in tree["direct"]["orders"]] == ["ORD-MANUAL"]
    assert [d["doc_no"] for d in tree["direct"]["documents"]] == ["CI-IMPORTED"]
    assert [d["doc_no"] for d in tree["direct"]["orders"][0]["documents"]] == ["PL-MANUAL"]
    # counts 必须包含 direct，否则客户页标题栏少算
    assert tree["counts"] == {"quotes": 1, "orders": 1, "documents": 2}


def test_multiple_quotes_keep_their_own_containment():
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


def test_doc_with_deleted_parent_falls_back_to_direct():
    """父对象已被删的脏单证不能从树上消失 —— 落 direct，用户仍能查到。"""
    tree = build_records(CUSTOMER, quotes=[], orders=[],
                         docs=[_doc(5, "CI-ORPHAN", "ci", order_id=999)])
    assert [d["doc_no"] for d in tree["direct"]["documents"]] == ["CI-ORPHAN"]
    assert tree["counts"]["documents"] == 1


def test_doc_cannot_belong_to_both_parents():
    """二选一：同时给了 quote_id 和 order_id 时，按报价优先（DB 约束本不允许两者都有）。"""
    tree = build_records(
        CUSTOMER, quotes=[_quote(4, "QUO-4")], orders=[_order(1, "ORD-1", quote_id=4)],
        docs=[_doc(9, "X-1", "quotation", quote_id=4, order_id=1)],
    )
    assert [d["doc_no"] for d in tree["quotes"][0]["documents"]] == ["X-1"]
    assert tree["quotes"][0]["orders"][0]["documents"] == []


def test_decimal_amount_is_serialized_as_string():
    """金额是 Decimal 时必须转字符串，否则 JSON 化成 float 丢精度。"""
    from decimal import Decimal
    tree = build_records(CUSTOMER, quotes=[_quote(4, "QUO-4", total_amount=Decimal("12300.55"))],
                         orders=[], docs=[])
    assert tree["quotes"][0]["total_amount"] == "12300.55"


def test_empty_customer_returns_empty_tree():
    tree = build_records(CUSTOMER, quotes=[], orders=[], docs=[])
    assert tree["quotes"] == []
    assert tree["direct"] == {"orders": [], "documents": []}
    assert tree["counts"] == {"quotes": 0, "orders": 0, "documents": 0}

def test_columns_are_the_only_truth():
    """归属**只认列**：列为空即视为"只归属客户"，读侧不得再去链接表/边表找关系。

    为什么钉住：曾经的实现是"列优先、链接表兜底"，两套真相并存 ——
    现改为：写入侧两端都写列，边表由数据库触发器（迁移 202610110013）从列自动派生。
    如果以后有人"顺手"在装配处再补一层兜底，就会重新引入两套真相，
    而树/列表/导出三条链路的可见性又会开始漂移。
    """
    tree = build_records(
        CUSTOMER,
        quotes=[_quote(4, "QUO-4")],
        orders=[_order(9, "ORD-9", quote_id=None)],   # 列是空的
        docs=[_doc(5, "CI-5", "ci")],                 # 列是空的
    )
    # 即使业务上"它可能来自某张报价"，读侧也不猜 —— 一律进 direct
    assert tree["quotes"][0]["orders"] == []
    assert [o["order_no"] for o in tree["direct"]["orders"]] == ["ORD-9"]
    assert [d["doc_no"] for d in tree["direct"]["documents"]] == ["CI-5"]
