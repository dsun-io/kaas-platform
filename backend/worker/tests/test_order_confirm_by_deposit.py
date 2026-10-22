"""定金到账 → 订单联动确认（设计 §5.1，D-16 / D-17）。

用户 2026-10-22 拍板的两条口径：
  ① 触发事件 = **业务上传定金到账**（不是"出了 CI/SC"）；
  ② **定金收款确认一定是人工操作的** —— 系统没有任何自动识别收款的能力，
     "联动"只是把"登记实收"这个已发生的人工动作顺带完成确认。

所以这里验的是：登记一笔实收 ⇒ pending 订单同事务变成 confirmed，
并带上 confirmed_source='deposit_receipt'（与人工点确认的 'manual' 区分）。
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
TODAY = datetime(2026, 10, 22).date()


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

    def all(self, needle: str):
        return [(s, a) for s, a in self.calls if needle in s]


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


def _order_row(**over):
    row = {
        "id": 21, "order_no": "ORD-US-ACME-1", "customer_id": 3,
        "customer_name": "ACME 贸易", "status": "pending", "currency": "USD",
        "total_amount": Decimal("3180.00"), "amount_breakdown": None,
        "order_date": None, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "source_type": "inquiry", "source_channel": "email", "inquiry_id": 9,
        "quote_id": None,
        "confirmed_at": None, "confirmed_by": None, "confirmed_source": None,
        "incoterm": None, "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
        "tenant_id": "default",
    }
    row.update(over)
    return row


def _receipt_row(**over):
    row = {
        "id": 71, "order_id": 21, "schedule_id": None, "amount": Decimal("954.00"),
        "currency": "USD", "received_date": TODAY, "fx_rate": None,
        "notes": None, "created_by": "3", "created_at": NOW,
    }
    row.update(over)
    return row


def _receivable_row(**over):
    row = {
        "id": 41, "order_id": 21, "currency": "USD",
        "total_amount": Decimal("3180.00"), "received_amount": Decimal("0"),
        "status": "unpaid", "created_at": NOW,
    }
    row.update(over)
    return row


def _post_receipt(conn, body):
    with _patched(conn):
        return client.post("/api/v1/orders/21/receipts", json=body)


def test_deposit_receipt_confirms_pending_order():
    """定金 954（30%）到账 ⇒ 订单同事务转 confirmed，confirmed_source=deposit_receipt。"""
    conn = _FakeConn(
        fetchrow=[
            _order_row(),                       # ① 读订单
            _receipt_row(),                     # ② INSERT payment_receipts RETURNING
            _receivable_row(),                  # ③ 重算：读应收台账
            {"rate": Decimal("7.1"), "rate_date": TODAY},   # ④ 锁汇率
            None,                               # ⑤ 查应收（无 → 建）
        ],
        fetchval=[],
        fetch=[[], []],                         # 期次 /  receipts（都没有）
    )
    resp = _post_receipt(conn, {"amount": 954, "received_date": "2026-10-22"})
    assert resp.status_code == 201, resp.text

    confirm_sql, confirm_args = conn.first("UPDATE orders SET status='confirmed'")
    assert "confirmed_at" in confirm_sql and "confirmed_by" in confirm_sql
    assert confirm_args[7] == "deposit_receipt"
    # 确认与实收**同一事务**：事件也走 conn，不用池连接
    event_sql, event_args = conn.first("INSERT INTO business_events")
    assert event_args[1] == "order.confirmed"
    payload = event_args[4]
    if isinstance(payload, str):
        import json
        payload = json.loads(payload)
    assert payload["confirm_source"] == "deposit_receipt"
    # 汇率锁定与建应收都发生了
    assert conn.first("INSERT INTO receivables")


def test_second_receipt_does_not_reconfirm():
    """已确认的订单再登记收款只是记账：不再走确认路径（幂等）。"""
    conn = _FakeConn(
        fetchrow=[
            _order_row(status="confirmed", confirmed_source="manual"),
            _receipt_row(amount=Decimal("2226.00")),
            _receivable_row(received_amount=Decimal("954.00"), status="partial"),
        ],
        fetchval=[],
        fetch=[[], [_receipt_row(amount=Decimal("954.00"))]],
    )
    resp = _post_receipt(conn, {"amount": 2226, "received_date": "2026-10-23"})
    assert resp.status_code == 201, resp.text
    assert "UPDATE orders SET status='confirmed'" not in conn.sql()
    assert "INSERT INTO business_events" not in conn.sql()


def test_cny_order_confirms_without_fx_lookup():
    """CNY 单汇率恒为 1：不该去查 fx_rates（少一次无谓查询）。"""
    conn = _FakeConn(
        fetchrow=[
            _order_row(currency="CNY"),
            _receipt_row(currency="CNY"),
            _receivable_row(currency="CNY"),
            None,                               # 查应收（无 → 建）
        ],
        fetchval=[],
        fetch=[[], []],
    )
    resp = _post_receipt(conn, {"amount": 954, "received_date": "2026-10-22"})
    assert resp.status_code == 201, resp.text
    assert "FROM fx_rates" not in conn.sql()
    confirm_sql, confirm_args = conn.first("UPDATE orders SET status='confirmed'")
    assert confirm_args[3] == 1.0              # fx_rate 锁定为 1


def test_confirmation_rolls_back_with_receipt():
    """确认写在实收的同一事务里：实收回滚 ⇒ 不会留下"已确认但没收过款"的订单。

    用假的 conn 让 INSERT payment_receipts 抛错，验证 UPDATE orders 从未执行。
    """

    class _Boom(Exception):
        pass

    class _FailingConn(_FakeConn):
        async def fetchrow(self, sql, *args):
            if "INSERT INTO payment_receipts" in sql:
                raise _Boom("回滚")
            return await super().fetchrow(sql, *args)

    conn = _FailingConn(fetchrow=[_order_row()], fetchval=[], fetch=[[], []])
    try:
        _post_receipt(conn, {"amount": 954, "received_date": "2026-10-22"})
    except _Boom:
        pass
    assert "UPDATE orders SET status='confirmed'" not in conn.sql()
    assert "INSERT INTO business_events" not in conn.sql()
