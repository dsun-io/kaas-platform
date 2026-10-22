"""询盘工位：跨客户列表筛选 + 询盘详情（设计 §8，M1-d）。

背景：询盘以前只是客户档案里的一个 tab（只能按客户归类全量拉），
"这个月展会来了多少询盘 / 这个询盘后来报了几次价、转了几个订单"都答不出来。
本文件锁住新增的筛选入参与详情形状。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_crm_ext  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.workstation.customer_serializers import row_to_inquiry  # noqa: E402
from kaas_common.workstation.order_serializers import row_to_order  # noqa: E402
from kaas_common.workstation.quote_serializers import row_to_quote  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
# 非管理员：别人的私有询盘必须看不见（404 不泄露存在性）
MEMBER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2}
NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)

_ORIGINAL_ACQUIRE = worker_main._acquire
_ORIGINAL_CRM_ACQUIRE = ws_crm_ext._acquire
_ORIGINAL_CRM_DB = ws_crm_ext.db


class _StubDb:
    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, _request, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)

    def args_of(self, needle: str):
        return next(a for s, a in self.calls if needle in s)


class _StubConn:
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


@contextmanager
def _patched(*, conn=None, db=None, user=ADMIN):
    conn = conn if conn is not None else _StubConn()

    @asynccontextmanager
    async def fake_acquire(_request):
        yield conn

    worker_main._acquire = fake_acquire
    ws_crm_ext._acquire = fake_acquire
    if db is not None:
        ws_crm_ext.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        worker_main._acquire = _ORIGINAL_ACQUIRE
        ws_crm_ext._acquire = _ORIGINAL_CRM_ACQUIRE
        ws_crm_ext.db = _ORIGINAL_CRM_DB
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _inquiry_row(**over):
    row = {
        "id": 9, "tenant_id": "default", "customer_id": 3,
        "inquiry_no": "US-ACM-20261022120000", "channel": "email",
        "category_id": None, "product_name_raw": "牛栏网",
        "quantity": 100, "quantity_unit": "m", "application": "牧场围栏",
        "items": [], "status": "quoted", "stage": "order",
        "stage_updated_at": NOW, "lead_id": None, "notes": None,
        "created_by": "3", "created_at": NOW, "updated_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
    }
    row.update(over)
    return row


def _quote_row(**over):
    row = {
        "id": 11, "tenant_id": "default", "quote_no": "QUO-US-ACM-1",
        "customer_id": 3, "customer_name": "ACME 贸易", "inquiry_id": 9,
        "status": "accepted", "currency": "USD",
        "total_amount": 3180.0, "valid_until": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "created_by": "3", "owner_id": "3", "owner_scope": "private",
        "team_id": 2,
    }
    row.update(over)
    return row


def _order_row(**over):
    row = {
        "id": 21, "tenant_id": "default", "order_no": "ORD-US-ACM-1",
        "customer_id": 3, "customer_name": "ACME 贸易", "status": "confirmed",
        "currency": "USD", "total_amount": 3180.0, "amount_breakdown": None,
        "order_date": None, "delivery_date": None, "notes": None,
        "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "quote_id": 11, "source_type": "inquiry", "source_channel": "email",
        "inquiry_id": 9,
        "confirmed_at": NOW, "confirmed_by": "3",
        "confirmed_source": "deposit_receipt",
        "incoterm": "FOB", "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
    }
    row.update(over)
    return row


# ── 列表：筛选入参 ───────────────────────────────────────────────────────────

def test_list_filters_by_stage_channel_and_dates():
    db = _StubDb(fetch=[[{**_inquiry_row(), "company_name": "ACME",
                          "quote_count": 2, "order_count": 1,
                          "latest_quote_at": NOW}]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries?stage=order&channel=email"
                          "&date_from=2026-10-01&date_to=2026-10-31")
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    # 「这个询盘后来怎样了」要在一行里看得见
    assert item["quote_count"] == 2
    assert item["order_count"] == 1
    assert item["latest_quote_at"] == NOW.isoformat()
    assert item["company_name"] == "ACME"

    sql = db.sql()
    assert "i.stage = $2" in sql
    assert "i.channel = $3" in sql
    assert "i.created_at::date >= $4" in sql
    assert "i.created_at::date <= $5" in sql
    # 订单数要同时算正列 inquiry_id 与经报价传递的历史单
    assert "o.inquiry_id = i.id" in sql
    assert "OR o.quote_id IN" in sql


def test_list_counts_default_to_zero_when_subquery_returns_null():
    """SQL count(*) 理论不会返 NULL，但假库/视图可能；序列化不能把 null 透给前端。"""
    db = _StubDb(fetch=[[{**_inquiry_row(), "company_name": "ACME"}]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries")
    item = resp.json()["items"][0]
    assert item["quote_count"] == 0
    assert item["order_count"] == 0
    assert item["latest_quote_at"] is None


def test_list_keyword_filter_matches_product_and_customer():
    db = _StubDb(fetch=[[]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries?q=牛栏网")
    assert resp.status_code == 200
    assert "i.product_name_raw ILIKE $2" in db.sql()
    assert "c.name ILIKE $2" in db.sql()


def test_list_rejects_unknown_stage_and_channel():
    db = _StubDb(fetch=[[]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries?stage=won")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"

    db = _StubDb(fetch=[[]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries?channel=quote")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_list_rejects_malformed_date_instead_of_silently_ignoring():
    """静默忽略比报错更糟：用户以为筛了 10 月，实际拿到全量。"""
    db = _StubDb(fetch=[[]])
    with _patched(db=db):
        resp = client.get("/api/v1/inquiries?date_from=2026/10/01")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_DATE"


# ── 详情：报价历史 + 关联订单 + 阶段流水 ─────────────────────────────────────

def test_detail_returns_quote_history_orders_and_stage_log():
    conn = _StubConn(
        fetchrow=[{**_inquiry_row(), "company_name": "ACME"}],
        fetchval=[2, 1],                      # quote 行项数 / 该报价的订单数
        fetch=[[_quote_row()], [_order_row()], []],   # 报价 / 订单 / 阶段流水
    )
    with _patched(conn=conn):
        resp = client.get("/api/v1/inquiries/9")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 基本信息走共享序列化 + company_name
    assert body["id"] == 9 and body["company_name"] == "ACME"
    assert body["stage"] == "order"
    # items 为空的历史行：共享序列化用旧字段合成一行（前端不必判空分支）
    assert body["items"] == [{
        "product_key": None, "product_name_raw": "牛栏网", "spec_text": None,
        "quantity": 100.0, "quantity_unit": "m", "application": "牧场围栏",
        "notes": None,
    }]

    # 报价历史：1:N，每次带时间/金额/状态 + 行项数 + 该报价转出的订单数
    assert len(body["quotes"]) == 1
    quote = body["quotes"][0]
    assert quote["quote_no"] == "QUO-US-ACM-1"
    assert quote["status"] == "accepted"
    assert quote["total_amount"] == 3180.0
    assert quote["item_count"] == 2
    assert quote["order_count"] == 1
    assert set(quote) >= set(row_to_quote({}))

    # 关联订单：走共享 row_to_order ⇒ 带来源三元组与确认痕迹
    assert len(body["orders"]) == 1
    order = body["orders"][0]
    assert order["source_type"] == "inquiry"
    assert order["inquiry_id"] == 9
    assert order["confirmed_source"] == "deposit_receipt"
    assert set(order) == set(row_to_order({}))

    # 阶段流水
    assert body["stage_log"] == []

    assert body["counts"] == {"quotes": 1, "orders": 1, "open_orders": 1}


def test_detail_counts_exclude_cancelled_orders_from_open_count():
    conn = _StubConn(
        fetchrow=[_inquiry_row()],
        fetchval=[0, 0],
        fetch=[[], [_order_row(status="cancelled")], []],
    )
    with _patched(conn=conn):
        resp = client.get("/api/v1/inquiries/9")
    body = resp.json()
    assert body["counts"]["orders"] == 1
    assert body["counts"]["open_orders"] == 0


def test_detail_404_when_inquiry_missing_or_not_visible():
    conn = _StubConn(fetchrow=[None])
    with _patched(conn=conn):
        assert client.get("/api/v1/inquiries/404").status_code == 404

    # 不可见（别人团队 + 别人私有的询盘）同样 404，不泄露存在性
    conn = _StubConn(
        fetchrow=[_inquiry_row(owner_id="999", owner_scope="private", team_id=99)])
    with _patched(conn=conn, user=MEMBER):
        resp = client.get("/api/v1/inquiries/9")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "INQUIRY_NOT_FOUND"


def test_detail_quote_history_orders_by_created_at():
    """改价重报是同询盘多张报价：详情按时间正序给出完整轨迹。"""
    conn = _StubConn(
        fetchrow=[_inquiry_row()],
        fetchval=[1, 0],
        fetch=[[_quote_row(id=11, created_at=NOW),
                _quote_row(id=12, quote_no="QUO-US-ACM-2",
                           total_amount=2980.0, created_at=NOW)],
               [], []],
    )
    with _patched(conn=conn):
        resp = client.get("/api/v1/inquiries/9")
    quotes = resp.json()["quotes"]
    assert [q["quote_no"] for q in quotes] == ["QUO-US-ACM-1", "QUO-US-ACM-2"]
    assert "ORDER BY created_at, id" in conn.sql()
