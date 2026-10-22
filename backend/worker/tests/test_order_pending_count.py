"""订单列表「有变更待批」角标（P0-A A1）。

背景：已确认订单改明细要走审批（ws_approvals.py），但列表页看不出「哪些单在等审批」。
本文件锁住：
  · GET /orders 每行带 pending_item_change_count（该单 status='pending' 的申请数）；
  · 计数与列表**同一次查询**（相关子查询），不是逐单再查（禁止 N+1）；
  · 缺列/异常值按 0（前端直接 >0 判角标）。
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

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
MEMBER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2}
NOW = datetime(2026, 10, 23, 9, 0, tzinfo=timezone.utc)


def _order_row(**over):
    row = {
        "id": 21, "tenant_id": "default", "order_no": "ORD-US-ACM-1",
        "customer_id": 3, "customer_name": "ACME 贸易", "status": "confirmed",
        "currency": "USD", "total_amount": Decimal("3180.00"),
        "amount_breakdown": None, "order_date": NOW, "delivery_date": None,
        "notes": None, "fx_rate": None, "fx_rate_date": None, "created_at": NOW,
        "owner_id": "3", "owner_scope": "private", "team_id": 2,
        "quote_id": None, "source_type": "direct", "source_channel": None,
        "inquiry_id": None, "confirmed_at": NOW, "confirmed_by": "3",
        "confirmed_source": "manual",
        "incoterm": None, "payment_terms": None,
        "port_of_loading": None, "port_of_destination": None,
        "shipping_marks": None, "country_of_origin": None,
    }
    row.update(over)
    return row


class _StubDb:
    """替换 worker_main.db 的 fetch/fetchval（list_orders 走 platform db 封装）。"""

    def __init__(self, *, fetchval=None, fetch=None):
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchval(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else 0

    async def fetch(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


_ORIGINAL_DB = worker_main.db


@contextmanager
def _patched(db, user=ADMIN):
    worker_main.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        worker_main.db = _ORIGINAL_DB
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def test_list_orders_carries_pending_item_change_count():
    db = _StubDb(
        fetchval=[2],
        fetch=[[_order_row(pending_item_change_count=2),
                _order_row(id=22, order_no="ORD-US-ACM-2")]],
    )
    with _patched(db):
        resp = client.get("/api/v1/orders")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2
    assert body["items"][0]["pending_item_change_count"] == 2
    # 聚合列缺失 ⇒ 0（不是 None：前端直接 >0 判角标）
    assert body["items"][1]["pending_item_change_count"] == 0

    # 行项投影仍是 row_to_order 的键集 + 一个聚合键
    assert "order_no" in body["items"][0]
    assert body["items"][0]["source_type"] == "direct"


def test_pending_count_is_aggregated_in_the_list_query_not_per_row():
    """禁止 N+1：整页只有 count + list 两次查询，且 list SQL 自带相关子查询。"""
    db = _StubDb(
        fetchval=[1],
        fetch=[[_order_row(pending_item_change_count=1)]],
    )
    with _patched(db):
        resp = client.get("/api/v1/orders")
    assert resp.status_code == 200, resp.text
    assert len(db.calls) == 2, [s for s, _ in db.calls]

    list_sql = next(s for s, _ in db.calls if "ORDER BY created_at DESC" in s)
    assert "FROM order_item_change_requests" in list_sql
    assert "status = 'pending'" in list_sql
    assert "AS pending_item_change_count" in list_sql
    # 子查询必须按单关联（否则会算出全表待批数）
    assert "r.order_id = o.id" in list_sql


def test_member_list_keeps_ownership_scope_with_pending_count():
    db = _StubDb(
        fetchval=[1],
        fetch=[[_order_row(pending_item_change_count=3)]],
    )
    with _patched(db, user=MEMBER):
        resp = client.get("/api/v1/orders")
    assert resp.status_code == 200, resp.text
    assert resp.json()["items"][0]["pending_item_change_count"] == 3

    list_sql = next(s for s, _ in db.calls if "ORDER BY created_at DESC" in s)
    # 归属/团队谓词照旧（加聚合列不能把可见性丢了）
    assert "owner_id = $2" in list_sql
    assert "owner_scope = 'tenant'" in list_sql
    assert "team_id = $3" in list_sql
