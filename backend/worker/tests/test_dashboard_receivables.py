"""Dashboard 应收聚合（P0-A A3）。

口径（与 frontend/src/lib/receivables/summary.ts 一致）：
  · 金额**只在同币种内相加**（多币种硬加会得出无意义数字）；
  · 未收 = max(0, 应收总额 − 已收)；
  · 归属过滤与 GET /api/v1/receivables 逐条一致（非管理员只能看自己/本团队/共享行）。

纯函数真源 = kaas_common/workstation/receivable_summary.py；端点只取行 + 拼 range/since。
"""
import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

from kaas_common.workstation.receivable_summary import summarize_receivables  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
MEMBER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2}


# ── 纯函数（内核口径）──────────────────────────────────────────────────────

def test_summarize_groups_by_currency_and_never_sums_across_currencies():
    out = summarize_receivables([
        {"currency": "USD", "total_amount": Decimal("1000.00"),
         "received_amount": Decimal("400.00"), "status": "partial"},
        {"currency": "USD", "total_amount": 600, "received_amount": 0,
         "status": "unpaid"},
        {"currency": "CNY", "total_amount": 68000, "received_amount": 68000,
         "status": "paid"},
    ])
    # 每币种独立一行；USD 1000+600=1600（绝不与 CNY 相加）
    assert out["by_currency"] == [
        {"currency": "CNY", "total": 68000.0, "received": 68000.0,
         "outstanding": 0.0, "count": 1},
        {"currency": "USD", "total": 1600.0, "received": 400.0,
         "outstanding": 1200.0, "count": 2},
    ]
    assert out["totals"] == {"count": 3}


def test_summarize_outstanding_clamped_and_status_order_fixed():
    out = summarize_receivables([
        {"currency": "USD", "total_amount": 100, "received_amount": 120,
         "status": "paid"},                       # 多收：未收不夹负
        {"currency": "USD", "total_amount": 50, "received_amount": None,
         "status": "unpaid"},
        {"currency": "USD", "total_amount": None, "received_amount": None,
         "status": "weird"},
    ])
    usd = out["by_currency"][0]
    assert usd["outstanding"] == 50.0
    assert usd["received"] == 120.0
    # unpaid/partial/paid 固定顺序，未知状态排最后
    assert [s["status"] for s in out["by_status"]] == ["unpaid", "paid", "weird"]
    assert out["by_status"][0] == {"status": "unpaid", "count": 1, "total": 50.0}


def test_summarize_empty_is_zeroed():
    assert summarize_receivables([]) == {
        "by_currency": [], "by_status": [], "totals": {"count": 0}}


def test_summarize_unknown_currency_is_not_faked_as_usd():
    out = summarize_receivables([
        {"currency": None, "total_amount": 10, "received_amount": 0,
         "status": "unpaid"},
    ])
    assert out["by_currency"][0]["currency"] == "—"


# ── 端点 ───────────────────────────────────────────────────────────────────

class _StubDb:
    def __init__(self, *, fetch=None):
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetch(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def fetchval(self, _request, sql, *args, table=None):
        self.calls.append((sql, args))
        return 0

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


_ORIGINAL_DB = worker_main.db

_ROWS = [
    {"currency": "USD", "total_amount": Decimal("1000.00"),
     "received_amount": Decimal("400.00"), "status": "partial"},
    {"currency": "CNY", "total_amount": Decimal("68000.00"),
     "received_amount": Decimal("0.00"), "status": "unpaid"},
]


@contextmanager
def _patched(db, user=ADMIN):
    worker_main.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        worker_main.db = _ORIGINAL_DB
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def test_dashboard_receivables_shape_and_range_window():
    db = _StubDb(fetch=[_ROWS])
    with _patched(db):
        resp = client.get("/api/v1/dashboard/receivables?range=30d")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["range"] == "30d"
    assert [c["currency"] for c in body["by_currency"]] == ["CNY", "USD"]
    assert body["totals"] == {"count": 2}
    assert {s["status"] for s in body["by_status"]} == {"unpaid", "partial"}
    # since = now - 30d（ISO 带时区）
    since = datetime.fromisoformat(body["since"])
    expected = datetime.now(timezone.utc) - timedelta(days=30)
    assert abs((since - expected).total_seconds()) < 120

    # 时间窗过滤走 SQL 参数（created_at >= $2），不是取全表再算
    assert "r.created_at >= $2" in db.sql()
    assert isinstance(db.calls[0][1][1], datetime)


def test_dashboard_receivables_unknown_range_falls_back_to_today():
    db = _StubDb(fetch=[[]])
    with _patched(db):
        resp = client.get("/api/v1/dashboard/receivables?range=bogus")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # 与 /dashboard/funnel 同语义：未知 range 不 422，落 today
    assert body["range"] == "bogus"
    since = datetime.fromisoformat(body["since"])
    assert abs(((datetime.now(timezone.utc) - since) - timedelta(days=1))
               .total_seconds()) < 120
    assert body["by_currency"] == [] and body["totals"] == {"count": 0}


def test_dashboard_receivables_member_sees_only_own_or_team_rows():
    db = _StubDb(fetch=[_ROWS])
    with _patched(db, user=MEMBER):
        resp = client.get("/api/v1/dashboard/receivables?range=7d")
    assert resp.status_code == 200, resp.text
    sql, args = db.calls[0]
    # 与 GET /api/v1/receivables 同一套归属过滤（否则 dashboard 成了越权侧门）
    assert "r.owner_id = $3" in sql
    assert "r.team_id = $4" in sql
    assert "r.owner_scope = 'tenant'" in sql
    assert args[2] == "3" and args[3] == 2


def test_dashboard_receivables_admin_has_no_ownership_filter():
    db = _StubDb(fetch=[[]])
    with _patched(db, user=ADMIN):
        resp = client.get("/api/v1/dashboard/receivables")
    assert resp.status_code == 200, resp.text
    sql, args = db.calls[0]
    assert "owner_id" not in sql
    assert "team_id" not in sql
    assert args[0] == "default"
    assert isinstance(args[1], datetime)
    assert len(args) == 2
