"""报价/订单 1:N 业务闸门（TODO F5，口径 A：允许一报价多订单）。

用户 2026-10-20 拍板选 A（docs/UI_BACKEND_DEPENDENCIES_2026-10-20.md §5）：
**不**加 1:1 唯一约束（分批出货/重复下单是真实业务），但必须有业务校验：

1. 币种必须与报价一致 —— 否则"累计金额"没有可比性；
2. 同一报价下**未取消**订单的金额累计不得超过报价合计 —— 否则客户订 100 米，
   系统能开出 300 米的订单，应收与单证数量全对不上。

历史数据不迁移：闸门只作用于**新建**订单（已存在的多单保持原样）。
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

CUSTOMER = {"id": 3, "account_type": "customer", "role": "user", "team_id": 2}
NOW = datetime(2026, 10, 20, 12, 0, tzinfo=timezone.utc)


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
            async def __aenter__(self_inner):
                return None

            async def __aexit__(self_inner, *exc):
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


def _quote_row(**over):
    row = {
        "id": 11, "quote_no": "QUO-US-ACME-1", "customer_id": 3,
        "customer_name": "ACME 贸易", "inquiry_id": 9, "status": "sent",
        "currency": "USD", "total_amount": Decimal("100.00"),
        "valid_until": None, "notes": None, "fx_rate": None, "fx_rate_date": None,
        "tax_archive_id": None, "tax_archive_code": None, "tax_archive_name": None,
        "tax_snapshot": None, "created_at": NOW, "created_by": "5",
        "owner_id": "5", "owner_scope": "private",
        "incoterm": "FOB", "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
        "destination_country": None, "destination_region": None,
        "carrier": None, "freight_valid_from": None, "freight_valid_to": None,
        "team_id": 2, "tenant_id": "default",
    }
    row.update(over)
    return row


def _customer_row():
    return {"id": 3, "name": "ACME 贸易", "stage": "active", "team_id": 2}


def _created_order(total="25.00"):
    return {
        "id": 21, "order_no": "ORD-US-ACME-1", "customer_id": 3,
        "customer_name": "ACME 贸易", "status": "pending", "currency": "USD",
        "total_amount": Decimal(total), "order_date": NOW, "delivery_date": None,
        "notes": None, "quote_id": 11, "created_by": "3",
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "incoterm": "FOB", "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
        "created_at": NOW,
    }


def _post_order(conn, body):
    with _patched(conn):
        return client.post("/api/v1/orders", json=body)


def test_quote_currency_mismatch_rejected():
    """报价 USD、订单 EUR ⇒ 422（累计校验前先拦币种，否则数字没有可比性）。"""
    conn = _FakeConn(
        fetchrow=[_quote_row(), _customer_row()],
        fetchval=[None],
        fetch=[],
    )
    resp = _post_order(
        conn,
        {"quote_order_id": 11, "currency": "EUR", "items": [{"line_amount": 10}]},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "ORDER_QUOTE_CURRENCY_MISMATCH"
    # 币种不符时不应继续算累计/落库
    assert "INSERT INTO orders" not in conn.sql()


def test_order_exceeding_quote_total_rejected():
    """报价 100，本单 150 ⇒ 422 ORDER_EXCEEDS_QUOTE（附报价/已下单/本单金额，便于对账）。"""
    conn = _FakeConn(
        fetchrow=[_quote_row(), _customer_row()],
        fetchval=[None, 0],          # doc_no, 已下单累计
        fetch=[],
    )
    resp = _post_order(
        conn,
        {"quote_order_id": 11, "items": [{"line_amount": 150}]},
    )
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "ORDER_EXCEEDS_QUOTE"
    assert detail["quote_total"] == 100.0 and detail["quote_ordered"] == 0.0
    assert detail["order_total"] == 150.0
    assert "INSERT INTO orders" not in conn.sql()


def test_order_partially_used_quote_rejected_when_exceeding_remainder():
    """报价 100，已下单 80，本单 30 ⇒ 超过剩余 20 ⇒ 422。"""
    conn = _FakeConn(
        fetchrow=[_quote_row(), _customer_row()],
        fetchval=[None, Decimal("80.00")],
        fetch=[],
    )
    resp = _post_order(
        conn,
        {"quote_order_id": 11, "items": [{"line_amount": 30}]},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "ORDER_EXCEEDS_QUOTE"


def test_order_within_quote_remainder_allowed():
    """报价 100，已下单 60，本单 30 ⇒ 放行（1:N 分批出货合法）。"""
    conn = _FakeConn(
        # 第 3 条是「报价自带询盘 → 查渠道」的那次查询（设计 §3.2：inquiry 继承询盘渠道）
        fetchrow=[_quote_row(), _customer_row(),
                  {"channel": "email"}, _created_order("30.00")],
        fetchval=[None, Decimal("60.00")],
        fetch=[],
    )
    resp = _post_order(
        conn,
        {"quote_order_id": 11, "items": [{"line_amount": 30}]},
    )
    assert resp.status_code == 201, resp.text
    insert_sql, insert_args = conn.first("INSERT INTO orders")
    assert insert_args[9] == 11                 # orders.quote_id 落库（1:N 靠列 + 边表）
    # 询盘转化单：来源三元组 = inquiry + 继承来的渠道 + 询盘 id
    assert list(insert_args[20:23]) == ["inquiry", "email", 9]
    # 累计只统计未取消订单（作废订单不该继续占额度）
    sum_sql, _ = next((s, a) for s, a in conn.calls if "SUM(total_amount)" in s)
    assert "status <> 'cancelled'" in sum_sql


def test_manual_order_without_quote_skips_constraint():
    """没有报价来源的手动订单不受该闸门约束（老路径行为不变）。"""
    conn = _FakeConn(
        fetchrow=[_customer_row(), _created_order("12.00")],
        fetchval=[None],
        fetch=[],
    )
    resp = _post_order(
        conn,
        {"customer_id": 3, "items": [{"line_amount": 12}]},
    )
    assert resp.status_code == 201, resp.text
    assert "SUM(total_amount)" not in conn.sql()
