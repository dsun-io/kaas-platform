"""订单金额 / 收款计划 / 实收登记 / 询盘多产品行（设计 §13.3 · 2026-10-22）。

本文件钉住新增能力的**契约与口径**（无数据库，桩连接按调用顺序吐结果）：

1. POST /orders：amount_breakdown 四项 + payment_plan[] 在**同一事务**里
   创建订单 / 行项 / 收款计划 / 应收台账（status='unpaid'）；
2. GET /orders/{id}：返回 amount_breakdown、items、payment_schedules（每期带
   received_amount）、receipts；
3. 实收登记：GET/POST /orders/{id}/receipts；允许 schedule_id 为空、同一期多次、
   金额差异；登记后重算期次状态（pending/partial/paid）与应收台账
   （unpaid/partial/paid）；已 paid 但无 receipts 的历史期次保持 paid（实收按金额计）；
4. 询盘多产品：新建/PATCH 落 items 并同步旧标量字段；读取 items 为空时用旧字段合成一行。

为什么不连库：这些端点的价值在**事务与重算口径**，桩连接能逐条断言 SQL 与参数；
真实 DB 路径由 integration 档覆盖。
"""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone

import pytest

from _bootstrap import load_main

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

import ws_crm_ext  # noqa: E402
from kaas_common.workstation import order_serializers  # noqa: E402
from kaas_common.workstation.customer_serializers import row_to_inquiry  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

_NOW = datetime(2026, 10, 22, 9, 0, tzinfo=timezone.utc)

CUSTOMER = {
    "id": 3, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False,
}
ADMIN = {
    "id": 1, "email": "root@qa.test", "display_name": "管理员",
    "account_type": "internal", "role": "system_admin", "status": "active",
    "team_id": None, "console_access": False,
}

_RECEIPT_KEYS = set(order_serializers.row_to_receipt({}))

_ORIGINAL_MAIN_ACQUIRE = worker_main._acquire
_ORIGINAL_DB_ACQUIRE = worker_main.db.acquire
_ORIGINAL_CRM_ACQUIRE = ws_crm_ext._acquire


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按调用顺序吐预设结果，并记录全部 SQL（含绑定参数）。"""

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
        return _FakeTxn()

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)

    def first(self, needle: str) -> tuple[str, tuple]:
        return next((sql, args) for sql, args in self.calls if needle in sql)


@pytest.fixture(autouse=True)
def _clean_state():
    worker_main.app.dependency_overrides.clear()
    worker_main._acquire = _ORIGINAL_MAIN_ACQUIRE
    worker_main.db.acquire = _ORIGINAL_DB_ACQUIRE
    ws_crm_ext._acquire = _ORIGINAL_CRM_ACQUIRE
    yield
    worker_main.app.dependency_overrides.clear()
    worker_main._acquire = _ORIGINAL_MAIN_ACQUIRE
    worker_main.db.acquire = _ORIGINAL_DB_ACQUIRE
    ws_crm_ext._acquire = _ORIGINAL_CRM_ACQUIRE


def _patched(conn, user):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    worker_main._acquire = fake_acquire
    worker_main.db.acquire = fake_acquire
    ws_crm_ext._acquire = fake_acquire   # 模块级缓存了 main._acquire，必须一起换
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _customer_row(**over):
    row = {
        "id": 3, "name": "ACME 贸易", "company_name": "ACME 贸易",
        "abbr": "ACME", "country": "US", "address": None, "default_port": None,
        "credit_level": None, "stage": "active", "notes": None,
        "created_at": _NOW, "updated_at": _NOW, "is_deleted": False,
        "team_id": 2, "owner_id": "3", "owner_scope": "private", "tenant_id": "default",
    }
    row.update(over)
    return row


def _order_row(**over):
    row = {
        "id": 21, "order_no": "ORD-US-ACME-20261022000000", "customer_id": 3,
        "customer_name": "ACME 贸易", "status": "pending", "currency": "USD",
        "total_amount": 10600.0,
        "amount_breakdown": {
            "goods_amount": 10000.0, "freight_amount": 400.0,
            "insurance_amount": 100.0, "other_amount": 100.0,
        },
        "order_date": None, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": _NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "incoterm": None, "payment_terms": None, "port_of_loading": None,
        "port_of_destination": None, "shipping_marks": None,
        "country_of_origin": None, "tenant_id": "default",
    }
    row.update(over)
    return row


def _item_row():
    return {
        "id": 1, "sku_id": None, "product_name": "牛栏网", "spec_snapshot": None,
        "qty": 10, "qty_unit": "m", "unit_price": 1000, "currency": "USD",
        "line_amount": 10000, "sort_order": 0, "tenant_id": "default",
    }


def _schedule_row(**over):
    row = {
        "id": 31, "order_id": 21, "trade_doc_id": None, "schedule_type": "deposit",
        "ratio": 0.3, "amount": 3180.0, "currency": "USD", "due_date": None,
        "actual_date": None, "status": "pending", "fx_rate": None,
        "exchange_gain_loss": None, "notes": None, "created_at": _NOW,
        "tenant_id": "default",
    }
    row.update(over)
    return row


def _receipt_row(**over):
    row = {
        "id": 41, "order_id": 21, "schedule_id": 31, "amount": 1000.0,
        "currency": "USD", "received_date": date(2026, 10, 22), "fx_rate": None,
        "file_id": None, "notes": None, "created_at": _NOW,
        "created_by": "5", "owner_id": "5", "owner_scope": "private",
        "team_id": 2, "tenant_id": "default",
    }
    row.update(over)
    return row


def _receivable_row(**over):
    row = {
        "id": 51, "order_id": 21, "currency": "USD", "total_amount": 10600.0,
        "fx_rate": None, "fx_rate_date": None, "base_currency": "CNY",
        "base_amount": None, "received_amount": 0, "exchange_gain_loss": None,
        "status": "unpaid", "created_at": _NOW, "tenant_id": "default",
    }
    row.update(over)
    return row


# ════════════════════════════════════════════════════════════════════════════
# 1. 建单：金额构成 + 收款计划 + 应收台账（同一事务）
# ════════════════════════════════════════════════════════════════════════════

def test_create_order_with_breakdown_and_plan_creates_schedules_and_receivable():
    conn = _FakeConn(
        fetchrow=[_customer_row(), _order_row()],
        fetchval=[None],   # 订单号查重：第一次就空闲
        fetch=[],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders", json={
        "customer_id": 3,
        "currency": "USD",
        "items": [{"product_name": "牛栏网", "qty": 10, "qty_unit": "m",
                   "unit_price": 1000, "currency": "USD"}],
        "amount_breakdown": {
            "goods_amount": 10000, "freight_amount": 400,
            "insurance_amount": 100, "other_amount": 100,
        },
        "payment_plan": [
            {"schedule_type": "deposit", "ratio": 0.3},
            {"schedule_type": "balance", "ratio": 0.7},
        ],
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    # 总额 = 四项之和（没显式传 total_amount）
    assert body["total_amount"] == 10600.0
    assert body["amount_breakdown"] == {
        "goods_amount": 10000.0, "freight_amount": 400.0,
        "insurance_amount": 100.0, "other_amount": 100.0,
    }

    insert_order_sql, insert_order_args = conn.first("INSERT INTO orders")
    assert "$20::jsonb" in insert_order_sql
    assert json.loads(insert_order_args[-1])["freight_amount"] == 400.0
    assert 10600.0 in insert_order_args          # total_amount 落订单总额

    schedules = [(sql, args) for sql, args in conn.calls
                 if "INSERT INTO payment_schedules" in sql]
    assert len(schedules) == 2
    # 30% / 70% 按订单总额自动算（设计 §13.3「金额自动 = 总额 × 比例」）
    assert schedules[0][1][4] == 3180.0          # ratio=0.3 → 10600×0.3
    assert schedules[1][1][4] == 7420.0
    assert "INSERT INTO order_items" in conn.sql()

    recv_sql, recv_args = conn.first("INSERT INTO receivables")
    assert 10600.0 in recv_args
    assert "'unpaid'" in recv_sql


def test_create_order_plan_ratio_over_100_rejected_before_write():
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None], fetch=[])
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders", json={
        "customer_id": 3,
        "payment_plan": [
            {"schedule_type": "deposit", "ratio": 0.6},
            {"schedule_type": "balance", "ratio": 0.6},
        ],
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PAYMENT_PLAN_RATIO_EXCEEDS"
    assert "INSERT INTO orders" not in conn.sql()


def test_normalize_payment_plan_amount_falls_back_to_ratio_and_validates_type():
    from main import _normalize_payment_plan

    plan = _normalize_payment_plan([
        {"schedule_type": "deposit", "ratio": 0.3},
        {"schedule_type": "other", "amount": 50},
    ], 1000.0)
    assert plan[0]["amount"] == 300.0
    assert plan[1]["amount"] == 50.0

    with pytest.raises(Exception) as exc:
        _normalize_payment_plan([{"schedule_type": "oops"}], 1000.0)
    assert getattr(exc.value, "status_code", None) == 422


def test_normalize_amount_breakdown_keeps_four_keys_only():
    from kaas_common.workstation.order_serializers import normalize_amount_breakdown

    out = normalize_amount_breakdown({
        "goods_amount": 100, "freight_amount": 10, "insurance_amount": 5,
        "other_amount": 1, "total": 116, "junk": 999,
    })
    assert out == {"goods_amount": 100.0, "freight_amount": 10.0,
                   "insurance_amount": 5.0, "other_amount": 1.0}
    assert normalize_amount_breakdown(None) is None


# ════════════════════════════════════════════════════════════════════════════
# 2. 订单详情：amount_breakdown + 每期 received_amount + receipts
# ════════════════════════════════════════════════════════════════════════════

def test_get_order_detail_includes_amount_breakdown_schedules_and_receipts():
    conn = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[
            [_item_row()],                        # items
            [],                                   # quote_refs
            [_schedule_row(amount=3180.0)],       # payment_schedules
            [_receivable_row()],                  # receivable
            [_receipt_row(amount=1000.0)],        # receipts
        ],
    )
    _patched(conn, CUSTOMER)
    resp = client.get("/api/v1/orders/21")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["amount_breakdown"]["goods_amount"] == 10000.0
    assert set(body["receipts"][0]) == _RECEIPT_KEYS
    schedule = body["payment_schedules"][0]
    # 期次实收 = 该期 receipts 合计（partial 由状态字段体现）
    assert schedule["received_amount"] == 1000.0
    assert schedule["amount"] == 3180.0


def test_get_order_detail_legacy_paid_schedule_without_receipts():
    conn = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[
            [], [], [_schedule_row(amount=3180.0, status="paid")],
            [_receivable_row(received_amount=3180.0, status="partial")], [],
        ],
    )
    _patched(conn, CUSTOMER)
    resp = client.get("/api/v1/orders/21")
    assert resp.status_code == 200, resp.text
    schedule = resp.json()["payment_schedules"][0]
    assert schedule["status"] == "paid"
    # 历史收款（无截图）：实收按该期金额展示，不强制补录
    assert schedule["received_amount"] == 3180.0


# ════════════════════════════════════════════════════════════════════════════
# 3. 实收登记：允许未分配 / 多次 / 金额差异；重算期次与应收
# ════════════════════════════════════════════════════════════════════════════

def test_post_receipt_partial_recomputes_schedule_and_receivable():
    conn = _FakeConn(
        fetchrow=[_order_row(), _receipt_row(), _receivable_row()],
        fetchval=[1],                                  # schedule 属于该订单
        fetch=[
            [_schedule_row(amount=3180.0, status="pending")],   # 重算：期次
            [_receipt_row(amount=1000.0)],                      # 重算：receipts
        ],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders/21/receipts", json={
        "schedule_id": 31, "amount": 1000, "received_date": "2026-10-22",
    })
    assert resp.status_code == 201, resp.text
    assert set(resp.json()) == _RECEIPT_KEYS
    assert resp.json()["schedule_id"] == 31

    status_sql, status_args = conn.first("UPDATE payment_schedules SET status")
    # 0 < 实收 1000 < 应收 3180 ⇒ partial（SCHEDULE_STATUS 新增值）
    assert status_args[-1] == "partial"
    recv_sql, recv_args = conn.first("UPDATE receivables SET received_amount")
    assert recv_args[2] == 1000.0
    assert recv_args[3] == "partial"


def test_post_receipt_full_amount_marks_paid():
    conn = _FakeConn(
        fetchrow=[_order_row(), _receipt_row(amount=3180.0),
                  _receivable_row(total_amount=3180.0)],
        fetchval=[1],
        fetch=[
            [_schedule_row(amount=3180.0, status="pending")],
            [_receipt_row(amount=3180.0)],
        ],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders/21/receipts", json={
        "schedule_id": 31, "amount": 3180, "received_date": "2026-10-22",
    })
    assert resp.status_code == 201, resp.text
    assert conn.first("UPDATE payment_schedules SET status")[1][-1] == "paid"
    assert conn.first("UPDATE receivables SET received_amount")[1][3] == "paid"


def test_post_receipt_without_schedule_is_allowed_as_unallocated():
    conn = _FakeConn(
        fetchrow=[_order_row(), _receipt_row(schedule_id=None),
                  _receivable_row(total_amount=3180.0)],
        fetchval=[],
        fetch=[[], [_receipt_row(schedule_id=None, amount=500.0)]],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders/21/receipts", json={
        "amount": 500, "received_date": "2026-10-22",
    })
    assert resp.status_code == 201, resp.text
    assert resp.json()["schedule_id"] is None
    # 未分配收款只进应收实收合计，不改任何期次
    assert "UPDATE payment_schedules SET status" not in conn.sql()
    recv_sql, recv_args = conn.first("UPDATE receivables SET received_amount")
    assert recv_args[2] == 500.0


def test_post_receipt_rejects_bad_amount_and_missing_date():
    conn = _FakeConn(fetchrow=[_order_row()])
    _patched(conn, CUSTOMER)
    bad = client.post("/api/v1/orders/21/receipts", json={
        "amount": 0, "received_date": "2026-10-22"})
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "INVALID_RECEIPT_AMOUNT"

    missing = client.post("/api/v1/orders/21/receipts", json={"amount": 10})
    assert missing.status_code == 422
    assert missing.json()["detail"]["code"] == "RECEIVED_DATE_REQUIRED"


def test_post_receipt_rejects_schedule_of_another_order():
    conn = _FakeConn(fetchrow=[_order_row()], fetchval=[None])
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/orders/21/receipts", json={
        "schedule_id": 99, "amount": 100, "received_date": "2026-10-22",
    })
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "SCHEDULE_NOT_IN_ORDER"
    assert "INSERT INTO payment_receipts" not in conn.sql()


def test_get_receipts_lists_items_and_total():
    conn = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[[]],
    )
    _patched(conn, CUSTOMER)
    empty = client.get("/api/v1/orders/21/receipts")
    assert empty.status_code == 200
    assert empty.json() == {"items": [], "total": 0}

    conn2 = _FakeConn(
        fetchrow=[_order_row()],
        fetch=[[_receipt_row(), _receipt_row(id=42, amount=200.0)]],
    )
    _patched(conn2, CUSTOMER)
    resp = client.get("/api/v1/orders/21/receipts")
    assert resp.status_code == 200
    assert resp.json()["total"] == 2
    assert set(resp.json()["items"][0]) == _RECEIPT_KEYS


def test_recompute_keeps_legacy_paid_schedule_and_counts_its_amount():
    """已 paid 但无 receipts 的历史期次：保持 paid，实收按 amount 计入应收。"""
    import asyncio

    conn = _FakeConn(
        fetchrow=[_receivable_row(total_amount=3180.0)],
        fetch=[
            [_schedule_row(amount=3180.0, status="paid")],
            [],        # 无 receipts
        ],
    )

    async def _run():
        return await worker_main._recompute_payment_state(conn, 21)

    result = asyncio.run(_run())
    assert result["received_amount"] == 3180.0
    assert result["status"] == "paid"
    assert "UPDATE payment_schedules SET status" not in conn.sql()


# ════════════════════════════════════════════════════════════════════════════
# 4. 询盘多产品：写入 items + 同步旧字段；读取回退
# ════════════════════════════════════════════════════════════════════════════

def _inquiry_row(**over):
    row = {
        "id": 61, "customer_id": 3, "inquiry_no": "INQ-US-ACME-20261022090000",
        "lead_id": None, "channel": "email", "category_id": None,
        "product_name_raw": "牛栏网", "quantity": 500.0, "quantity_unit": "m",
        "application": "牧场", "status": "unquoted", "stage": "inquiry",
        "stage_updated_at": None, "created_at": _NOW, "tenant_id": "default",
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
    }
    row.update(over)
    return row


def test_create_inquiry_with_items_writes_items_and_legacy_first_row():
    conn = _FakeConn(
        fetchrow=[_customer_row(), _inquiry_row(
            items='[{"product_name_raw": "牛栏网", "quantity": 500, '
                  '"quantity_unit": "m", "application": "牧场"}, '
                  '{"product_name_raw": "勾花网", "quantity": 100}]',
        )],
        fetchval=[None],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/customers/3/inquiries", json={
        "channel": "email",
        "items": [
            {"product_name_raw": "牛栏网", "quantity": 500,
             "quantity_unit": "m", "application": "牧场"},
            {"product_name_raw": "勾花网", "quantity": 100},
        ],
    })
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert [it["product_name_raw"] for it in body["items"]] == ["牛栏网", "勾花网"]

    sql, args = conn.first("INSERT INTO cust_inquiries")
    assert "$16::jsonb" in sql
    stored = json.loads(args[-1])
    assert len(stored) == 2
    # 第一行同步写旧标量字段（旧报表/链式分析不用改）
    assert "牛栏网" in args
    assert 500.0 in args
    assert "m" in args
    assert "牧场" in args


def test_create_inquiry_legacy_scalars_still_work():
    conn = _FakeConn(
        fetchrow=[_customer_row(), _inquiry_row(items="[]",
                                                product_name_raw="鹿网",
                                                quantity=10.0,
                                                quantity_unit="set")],
        fetchval=[None],
    )
    _patched(conn, CUSTOMER)
    resp = client.post("/api/v1/customers/3/inquiries", json={
        "product_name_raw": "鹿网", "quantity": 10, "quantity_unit": "set",
    })
    assert resp.status_code == 201, resp.text
    # 老客户端只给标量：items 落空数组，读取由旧字段合成一行
    assert resp.json()["items"][0]["product_name_raw"] == "鹿网"
    sql, args = conn.first("INSERT INTO cust_inquiries")
    assert json.loads(args[-1]) == []


def test_row_to_inquiry_synthesizes_items_from_legacy_fields():
    row = {"id": 9, "product_name_raw": "勾花网", "quantity": 100,
           "quantity_unit": "㎡", "application": "围栏", "status": "quoted"}
    out = row_to_inquiry(row)
    assert out["items"] == [{
        "product_key": None, "product_name_raw": "勾花网", "spec_text": None,
        "quantity": 100.0, "quantity_unit": "㎡", "application": "围栏",
        "notes": None,
    }]

    empty = row_to_inquiry({"id": 10})
    assert empty["items"] == []


def test_row_to_inquiry_parses_jsonb_string_items():
    row = {"id": 11, "items": '[{"product_name_raw": "鹿网", "quantity": 3}]'}
    out = row_to_inquiry(row)
    assert out["items"][0]["product_name_raw"] == "鹿网"
    assert out["items"][0]["quantity"] == 3.0


def test_patch_inquiry_items_updates_items_and_legacy_fields():
    inq = _inquiry_row()
    updated = _inquiry_row(items='[{"product_name_raw": "鹿网", "quantity": 3}]')
    conn = _FakeConn(fetchrow=[inq, updated])
    _patched(conn, CUSTOMER)
    resp = client.patch("/api/v1/inquiries/61", json={
        "items": [{"product_name_raw": "鹿网", "quantity": 3}],
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["product_name_raw"] == "鹿网"
    sql, args = conn.first("UPDATE cust_inquiries SET")
    assert "items = " in sql and "::jsonb" in sql
    # args: (items-json, product_name_raw, quantity, quantity_unit, application, id)
    assert json.loads(args[0]) == [{
        "product_key": None, "product_name_raw": "鹿网", "spec_text": None,
        "quantity": 3.0, "quantity_unit": None, "application": None,
        "notes": None,
    }]
    assert args[1] == "鹿网" and args[2] == 3.0


def test_enums_include_partial_schedule_status():
    from kaas_common.domain import enums

    assert "partial" in enums.SCHEDULE_STATUS


def test_file_rules_allow_order_and_payment_receipt_owner_types():
    from kaas_common.files import rules

    assert "order" in rules.OWNER_TYPES
    assert "payment_receipt" in rules.OWNER_TYPES
    # 截图/附件复用 other 的 MIME 与 16MB 上限（不改历史限制）
    assert "application/pdf" in rules.KIND_MIME["other"]
    assert rules.MAX_BYTES["other"] == 16 * 1024 * 1024
