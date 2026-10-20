"""单证列表的「定时对账标识」守卫（TODO A8/A9，无数据库、无网络）。

为什么需要：
定时任务把最近一次对账结论写进 `trade_doc_render_checks`，列表端点把它挂到每一行上
（`render_check`）。这里锁两件事：
1. 有对账记录 ⇒ 行上带 `render_check`（未对账过 ⇒ `null`，**不冒充"没问题"**）；
2. 没对账记录时列表照常返回，不能因为 join 不到就少行/报错。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}


class _FakeConn:
    """按顺序吐 fetchval / fetch 结果，并记录 SQL。"""

    def __init__(self, fetchvals=None, fetches=None):
        self._fetchvals = list(fetchvals or [])
        self._fetches = list(fetches or [])
        self.queries: list[str] = []

    async def fetchval(self, sql, *args):
        self.queries.append(sql)
        return self._fetchvals.pop(0) if self._fetchvals else 0

    async def fetch(self, sql, *args):
        self.queries.append(sql)
        return self._fetches.pop(0) if self._fetches else []

    def transaction(self):
        class _Tx:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *exc):
                return False

        return _Tx()


@contextmanager
def _patched(conn):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = worker_main._acquire
    worker_main._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: ADMIN
    try:
        yield conn
    finally:
        worker_main._acquire = old
        worker_main.app.dependency_overrides.clear()


def _doc_row(**over):
    row = {
        "id": 7, "tenant_id": "default", "doc_no": "PI-202610-0007", "doc_type": "pi",
        "order_id": None, "quote_id": None, "customer_id": 3, "status": "issued",
        "currency": "USD", "total_amount": 1200, "issued_at": datetime(2026, 10, 20, tzinfo=timezone.utc),
        "issued_by": "1", "raw_payload": {}, "created_at": datetime(2026, 10, 20, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 10, 20, tzinfo=timezone.utc),
        "owner_id": None, "owner_scope": "private", "team_id": None,
    }
    row.update(over)
    return row


def test_list_attaches_latest_render_check():
    checked_at = datetime(2026, 10, 20, 17, 40, tzinfo=timezone.utc)
    conn = _FakeConn(
        fetchvals=[1, None],       # count, doc_no_editable(每行一次)
        fetches=[
            [_doc_row()],          # trade_docs 本体
            [{                     # trade_doc_render_checks
                "trade_doc_id": 7,
                "matches": False,
                "reason": "data_changed",
                "render_version_drift": False,
                "checked_at": checked_at,
            }],
        ],
    )
    with _patched(conn):
        resp = client.get("/api/v1/trade-docs")

    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1 and len(body["items"]) == 1
    check = body["items"][0]["render_check"]
    assert check is not None
    assert check["matches"] is False and check["reason"] == "data_changed"
    assert check["checked_at"] == checked_at.isoformat()
    assert any("trade_doc_render_checks" in q for q in conn.queries)


def test_list_without_check_returns_null_not_false():
    """从未对账过 ⇒ null（界面不显示标识）—— 不能写成 matches=false 冒充"已变更"。"""
    conn = _FakeConn(fetchvals=[1, None], fetches=[[_doc_row()], []])
    with _patched(conn):
        resp = client.get("/api/v1/trade-docs")

    assert resp.status_code == 200
    assert resp.json()["items"][0]["render_check"] is None


def test_list_without_rows_skips_check_query():
    """空列表：不额外查对账表（省一次往返，也不依赖空数组语义）。"""
    conn = _FakeConn(fetchvals=[0], fetches=[[]])
    with _patched(conn):
        resp = client.get("/api/v1/trade-docs")

    assert resp.status_code == 200
    assert resp.json()["items"] == []
    assert not any("trade_doc_render_checks" in q for q in conn.queries)
