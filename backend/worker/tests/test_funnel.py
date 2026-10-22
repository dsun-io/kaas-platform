"""商机漏斗统计（设计 §7，D-6 权重 1/2/10）。"""
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main

worker_main = load_main()

from kaas_common.workstation.funnel import (
    build_funnel,
    channel_conversion_rates,
    compute_composite_score,
    direct_currency_breakdown,
)


# ── 纯函数单元 ─────────────────────────────────────────────────────────────

def test_build_funnel_basic():
    f = build_funnel(inquiry_count=100, quoted_count=60,
                     ordered_count=30, completed_count=10,
                     completed_amount=50000.0)
    stages = {s["name"]: s for s in f["stages"]}
    assert stages["inquiry"]["count"] == 100
    assert stages["quoted"]["count"] == 60
    assert stages["ordered"]["count"] == 30
    assert stages["completed"]["count"] == 10
    assert stages["completed"]["amount"] == 50000.0

    rates = f["conversion_rates"]
    assert rates["inquiry_to_quote"] == 60.0
    assert rates["quote_to_order"] == 50.0
    assert rates["order_to_completed"] == 33.33
    assert rates["inquiry_to_completed"] == 10.0


def test_build_funnel_zero_denominator_returns_none():
    f = build_funnel(0, 0, 0, 0, 0)
    for r in f["conversion_rates"].values():
        assert r is None


def test_composite_score_weights():
    """D-6：询盘 1 / 报价 2 / 订单 10。"""
    assert compute_composite_score(1, 0, 0) == 1
    assert compute_composite_score(0, 1, 0) == 2
    assert compute_composite_score(0, 0, 1) == 10
    assert compute_composite_score(10, 5, 2) == 10 + 10 + 20


def test_channel_conversion_rates_sorts_by_score():
    raw = [
        {"channel": "alibaba", "inquiry_count": 10, "quote_count": 5,
         "order_count": 2, "completed_count": 1},
        {"channel": "email",   "inquiry_count": 20, "quote_count": 2,
         "order_count": 1, "completed_count": 0},
    ]
    out = channel_conversion_rates(raw)
    assert [c["channel"] for c in out] == ["alibaba", "email"]
    # alibaba: 10*1 + 5*2 + 2*10 = 40
    assert out[0]["composite_score"] == 40
    # email:   20*1 + 2*2 + 1*10 = 34
    assert out[1]["composite_score"] == 34


def test_direct_currency_breakdown_sorts_and_normalizes():
    """P0-A A5：直接下单按币种拆账（多币种不再用混加金额误导）。"""
    out = direct_currency_breakdown([
        {"currency": "USD", "order_count": 3, "amount": "900.50"},
        {"currency": "cny", "order_count": 1, "amount": 68000},
    ])
    assert out == [
        {"currency": "CNY", "count": 1, "amount": 68000.0},
        {"currency": "USD", "count": 3, "amount": 900.5},
    ]


def test_direct_currency_breakdown_unknown_currency_is_not_usd():
    out = direct_currency_breakdown(
        [{"currency": None, "order_count": 2, "amount": None}])
    assert out == [{"currency": "—", "count": 2, "amount": 0.0}]


def test_channel_conversion_rates_null_channel_becomes_other():
    out = channel_conversion_rates([
        {"channel": None, "inquiry_count": 5, "quote_count": 0,
         "order_count": 0, "completed_count": 0},
    ])
    assert out[0]["channel"] == "other"


# ── 端点集成 ───────────────────────────────────────────────────────────────

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
        return "UPDATE 1"

    def transaction(self):
        class _Tx:
            async def __aenter__(self): return None
            async def __aexit__(self, *exc): return False
        return _Tx()


def test_dashboard_funnel_endpoint_shape():
    """端点返回结构符合契约（不走 DB，用 FakeConn 断言 SQL 片段）。

    口径（M3）：按时间窗内创建的询盘做 cohort；直接下单单独返回。
    """
    conn = _StubConn(
        fetchrow=[{"inquiry_count": 100, "quoted_count": 60, "ordered_count": 30,
                   "completed_count": 10, "completed_amount": 50000.0},
                  {"ord": 5, "amt": 8000.0}],
        fetch=[[{"channel": "email", "inquiry_count": 50, "quote_count": 30,
                 "order_count": 10, "completed_count": 3}],
               # 直接下单按币种（P0-A A5）：GROUP BY currency 一次取回
               [{"currency": "USD", "order_count": 5, "amount": 8000.0},
                {"currency": "CNY", "order_count": 2, "amount": 40000.0}]],
    )

    async def run():
        from main import dashboard_funnel
        from fastapi.testclient import TestClient

        from contextlib import asynccontextmanager

        client = TestClient(worker_main.app, raise_server_exceptions=True)
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: {"id": 1, "role": "system_admin"}

        @asynccontextmanager
        async def fake_acquire(_request):
            yield conn

        original_acquire = worker_main._acquire
        worker_main._acquire = fake_acquire
        try:
            resp = client.get("/api/v1/dashboard/funnel")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert body["range"] == "today"
            assert "since" in body
            assert body["funnel"]["stages"][0]["count"] == 100
            assert body["funnel"]["stages"][1]["count"] == 60
            assert body["funnel"]["stages"][3]["amount"] == 50000.0
            assert body["funnel"]["composite_score"] == 100 + 120 + 300
            assert body["channels"][0]["channel"] == "email"
            assert body["direct_orders"]["count"] == 5
            # A5：amount 保留（跨币种原值相加、仅规模参考），精确金额看 by_currency
            assert body["direct_orders"]["amount"] == 8000.0
            assert body["direct_orders"]["by_currency"] == [
                {"currency": "CNY", "count": 2, "amount": 40000.0},
                {"currency": "USD", "count": 5, "amount": 8000.0},
            ]
            # 一次 GROUP BY 取全部币种（不是逐币种/逐单查询）
            assert any("GROUP BY currency" in c[0] for c in conn.calls)
            # cohort 口径：询盘查询带 created_at >= $2，且 since 作为参数传入
            cohort_calls = [c for c in conn.calls
                            if "cust_inquiries" in c[0] and "created_at >= $2" in c[0]]
            assert len(cohort_calls) >= 2, [c[0] for c in conn.calls]
            assert all(isinstance(c[1][1], datetime) for c in cohort_calls), cohort_calls
        finally:
            worker_main._acquire = original_acquire
            worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)

    import asyncio
    asyncio.run(run())
