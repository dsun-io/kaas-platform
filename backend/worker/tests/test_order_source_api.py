"""订单来源三元组 + 货物明细整批替换（设计 §3.2 / §3.3 / §6，迁移 202610220004）。

不连库：替换 `_acquire` 与 `db.acquire`，把 handler 跑到返回。
覆盖三条硬规则：
  R1  inquiry 单必须挂询盘（显式给 / 报价带 / 都不给 → 422）；
  R2  direct 单不许挂询盘（否则两套真相）；
  R3  pending 才能直接改明细，confirmed 及以后走变更审批（409 指路）。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

CUSTOMER = {"id": 3, "account_type": "internal", "role": "system_admin",
            "team_id": 2}
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)


class _FakeConn:
    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        class _Tx:
            async def __aenter__(self):
                return None

            async def __aexit__(self, *exc):
                return False

        return _Tx()

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)

    def first(self, needle: str):
        return next((s, a) for s, a in self.calls if needle in s)


@contextmanager
def _patched(conn):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old_main = worker_main._acquire
    old_db = worker_main.db.acquire
    worker_main._acquire = fake_acquire
    worker_main.db.acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: CUSTOMER
    try:
        yield conn
    finally:
        worker_main._acquire = old_main
        worker_main.db.acquire = old_db
        worker_main.app.dependency_overrides.clear()


def _customer_row():
    return {"id": 3, "name": "ACME 贸易", "stage": "active", "team_id": 2}


def _inquiry_row(**over):
    row = {
        "id": 9, "tenant_id": "default", "customer_id": 3,
        "channel": "email", "status": "open", "stage": "inquiry",
        "inquiry_no": "US-ACM-20261022120000", "notes": None,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "created_at": NOW,
    }
    row.update(over)
    return row


def _created_order(**over):
    row = {
        "id": 21, "order_no": "ORD-US-ACME-1", "customer_id": 3,
        "customer_name": "ACME 贸易", "status": "pending", "currency": "USD",
        "total_amount": Decimal("30.00"), "amount_breakdown": None,
        "order_date": NOW, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "quote_id": None, "source_type": "direct", "source_channel": None,
        "inquiry_id": None,
        "confirmed_at": None, "confirmed_by": None, "confirmed_source": None,
        "incoterm": None, "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
    }
    row.update(over)
    return row


def _post(conn, body):
    with _patched(conn):
        return client.post("/api/v1/orders", json=body)


def _patch(conn, body):
    with _patched(conn):
        return client.patch("/api/v1/orders/21", json=body)


# ── R1 / R2：来源写入规则 ────────────────────────────────────────────────────

def test_explicit_inquiry_marks_order_as_inquiry_source():
    """显式传 inquiry_id ⇒ source_type=inquiry，渠道默认继承询盘渠道。"""
    conn = _FakeConn(
        fetchrow=[_customer_row(), _inquiry_row(), _created_order()],
        fetchval=[None],
        fetch=[],
    )
    resp = _post(conn, {"customer_id": 3, "inquiry_id": 9,
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 201, resp.text
    insert_sql, insert_args = conn.first("INSERT INTO orders")
    assert "$21,$22,$23" in insert_sql, "INSERT 必须带来源三元组三列"
    assert list(insert_args[20:23]) == ["inquiry", "email", 9]


def test_inquiry_source_without_inquiry_is_422():
    """R1：说自己是询盘转化又不给询盘 ⇒ 422（DB CHECK 之前先给可操作的报错）。"""
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None], fetch=[])
    resp = _post(conn, {"customer_id": 3, "source_type": "inquiry",
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INQUIRY_REQUIRED"
    assert "INSERT INTO orders" not in conn.sql()


def test_direct_order_with_inquiry_is_422():
    """R2：direct 单挂询盘 = 两套真相（询盘详情页会看见不属于它的订单）。"""
    conn = _FakeConn(
        fetchrow=[_customer_row(), _inquiry_row()],
        fetchval=[None], fetch=[],
    )
    resp = _post(conn, {"customer_id": 3, "source_type": "direct",
                        "inquiry_id": 9, "items": [{"line_amount": 30}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "DIRECT_ORDER_INQUIRY_CONFLICT"
    assert "INSERT INTO orders" not in conn.sql()


def test_inquiry_from_other_customer_is_422():
    """挂错客户的询盘会让客户档案与漏斗同时失真。"""
    conn = _FakeConn(
        fetchrow=[_customer_row(), _inquiry_row(customer_id=7)],
        fetchval=[None], fetch=[],
    )
    resp = _post(conn, {"customer_id": 3, "inquiry_id": 9,
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INQUIRY_CUSTOMER_MISMATCH"


def test_unknown_inquiry_is_404():
    conn = _FakeConn(fetchrow=[_customer_row(), None], fetchval=[None], fetch=[])
    resp = _post(conn, {"customer_id": 3, "inquiry_id": 9,
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "INQUIRY_NOT_FOUND"


def test_manual_order_stays_direct_with_unknown_channel():
    """历史/未知渠道不伪造：direct 单没传渠道 ⇒ NULL，前端展示「未知」。"""
    conn = _FakeConn(
        fetchrow=[_customer_row(), _created_order()],
        fetchval=[None], fetch=[],
    )
    resp = _post(conn, {"customer_id": 3, "items": [{"line_amount": 30}]})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["source_type"] == "direct"
    assert body["source_channel"] is None
    assert body["inquiry_id"] is None


def test_invalid_source_type_and_channel_are_422():
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None], fetch=[])
    resp = _post(conn, {"customer_id": 3, "source_type": "wechat",
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 422
    # 第二条要再给一条客户行：渠道校验发生在客户闸门之后
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None], fetch=[])
    resp = _post(conn, {"customer_id": 3, "source_channel": "quote",
                        "items": [{"line_amount": 30}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


# ── R3：货物明细整批替换 ─────────────────────────────────────────────────────

def test_replace_items_on_pending_order_recomputes_total():
    """pending 单可直接改明细并重算总额（线下单 T1→T2 补全的唯一入口）。"""
    conn = _FakeConn(
        fetchrow=[_created_order(), _created_order(total_amount=Decimal("140.00"))],
        fetchval=[None], fetch=[],
    )
    resp = _patch(conn, {"items": [
        {"product_name": "牛栏网", "qty": 10, "unit_price": 10, "line_amount": 100},
        {"product_name": "刺绳", "qty": 4, "unit_price": 10, "line_amount": 40},
    ]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["total_amount"] == 140.0
    assert "DELETE FROM order_items" in conn.sql()
    assert "INSERT INTO order_items" in conn.sql()
    # 行项汇总变了 ⇒ 订单总额跟着变
    update_sql, update_args = conn.first("UPDATE orders SET total_amount")
    assert update_args[0] == 140.0


def test_replace_items_recomputes_breakdown_goods_amount():
    """有金额构成的订单：只换货物金额，运费/保险/其他按谈定值保留。"""
    conn = _FakeConn(
        fetchrow=[
            _created_order(amount_breakdown={
                "goods_amount": 100.0, "freight_amount": 400.0,
                "insurance_amount": 100.0, "other_amount": 100.0,
            }),
            _created_order(total_amount=Decimal("700.00")),
        ],
        fetchval=[None], fetch=[],
    )
    resp = _patch(conn, {"items": [{"line_amount": 100}]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["total_amount"] == 700.0


def test_replace_items_on_confirmed_order_needs_approval():
    """已确认订单的金额是客户认过账的：409 指路变更审批，不静默改。"""
    conn = _FakeConn(
        fetchrow=[_created_order(status="confirmed")],
        fetchval=[None], fetch=[],
    )
    resp = _patch(conn, {"items": [{"line_amount": 5}]})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ORDER_ITEMS_LOCKED"
    assert "item-change-requests" in resp.json()["detail"]["detail"]
    assert "DELETE FROM order_items" not in conn.sql()


def test_replace_items_rejects_non_list():
    conn = _FakeConn(
        fetchrow=[_created_order()], fetchval=[None], fetch=[],
    )
    resp = _patch(conn, {"items": {"line_amount": 5}})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ITEMS"


def test_replace_items_rejects_non_numeric_amounts():
    """与新建同口径（PARITY-QUOTE-10）：非法数字 422，不是 500。"""
    conn = _FakeConn(
        fetchrow=[_created_order()], fetchval=[None], fetch=[],
    )
    resp = _patch(conn, {"items": [{"qty": "abc", "unit_price": 2}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ITEM_NUMBER"


def test_replace_items_syncs_unpaid_receivable_total():
    """还没收到一分钱 ⇒ 应收台账跟着改；已收过钱的不动（不悄悄改账）。"""
    conn = _FakeConn(
        fetchrow=[
            _created_order(),
            _created_order(total_amount=Decimal("140.00")),
            {"id": 41, "received_amount": Decimal("0.00")},
        ],
        fetchval=[None],
        fetch=[],
    )
    resp = _patch(conn, {"items": [{"line_amount": 140}]})
    assert resp.status_code == 200, resp.text
    recv_sql, recv_args = conn.first("UPDATE receivables SET total_amount")
    assert recv_args[0] == 140.0


def test_replace_items_keeps_receivable_when_money_already_received():
    """已收过钱的订单改明细：总额照改，应收**不动**（received > total 宁可让财务看见）。"""
    conn = _FakeConn(
        fetchrow=[
            _created_order(),
            _created_order(total_amount=Decimal("140.00")),
            {"id": 41, "received_amount": Decimal("80.00")},
        ],
        fetchval=[None],
        fetch=[],
    )
    resp = _patch(conn, {"items": [{"line_amount": 140}]})
    assert resp.status_code == 200, resp.text
    assert "UPDATE receivables SET total_amount" not in conn.sql()


# ── 列表筛选 ────────────────────────────────────────────────────────────────

def test_list_orders_filters_by_source_type_and_channel():
    """设计 §8：订单列表要能按来源切（询盘转化 / 某渠道）。"""
    conn = _FakeConn(fetchval=[0], fetch=[])
    with _patched(conn):
        resp = client.get(
            "/api/v1/orders?source_type=inquiry&source_channel=phone&inquiry_id=9")
    assert resp.status_code == 200, resp.text
    sql = conn.sql()
    assert "source_type = $2" in sql
    assert "source_channel = $3" in sql
    assert "inquiry_id = $4" in sql


def test_list_orders_rejects_unknown_source_type():
    conn = _FakeConn(fetchval=[0], fetch=[])
    with _patched(conn):
        resp = client.get("/api/v1/orders?source_type=wechat")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"
