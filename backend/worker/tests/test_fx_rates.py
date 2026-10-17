"""汇率实时拉取（worker）：纯解析、缓存新鲜度、降级路径。

背景（2026-10-17）：fx_rates 长期为空，`/fx-rates/latest` 恒 404。
现在改为读时刷新（>6h 拉公开源）+ 失败降级缓存，这里锁住这几条语义。
"""
import asyncio
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()

import ws_extras  # noqa: E402

TS = 1792195352  # 2026-10-17T00:02:32Z（open.er-api.com 的刷新时间）


def _row(rate=6.5, fetched_at=None, is_stale=False):
    return {
        "base_currency": "USD",
        "quote_currency": "CNY",
        "rate": rate,
        "rate_date": date(2026, 10, 17),
        "source": "open.er-api.com",
        "is_stale": is_stale,
        "fetched_at": fetched_at,
    }


class _Conn:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.executed = []

    async def fetchrow(self, *args, **kwargs):
        return self.rows.pop(0) if self.rows else None

    async def execute(self, *args, **kwargs):
        self.executed.append(args)
        return "INSERT 0 1"


def test_parse_payload():
    rate, rate_date = ws_extras.parse_fx_payload(
        {"time_last_update_unix": TS, "rates": {"CNY": 6.698464}}, "CNY"
    )
    assert float(rate) == pytest.approx(6.698464)
    assert rate_date == date(2026, 10, 17)


def test_parse_payload_unknown_quote_raises():
    with pytest.raises(ValueError):
        ws_extras.parse_fx_payload({"time_last_update_unix": TS, "rates": {}}, "CNY")


def test_fresh_boundaries():
    now = datetime.now(timezone.utc)
    assert ws_extras.fx_is_fresh(now - timedelta(hours=5), now) is True
    assert ws_extras.fx_is_fresh(now - timedelta(hours=7), now) is False
    assert ws_extras.fx_is_fresh(None, now) is False


def test_fresh_cache_skips_fetch(monkeypatch):
    async def boom(*args, **kwargs):
        raise AssertionError("缓存新鲜时不应该请求外部源")

    monkeypatch.setattr(ws_extras, "_http_get_json", boom)
    row = _row(rate=6.7, fetched_at=datetime.now(timezone.utc) - timedelta(hours=1))
    out = asyncio.run(ws_extras._ensure_fresh_fx(_Conn([row]), "USD", "CNY"))
    assert out["rate"] == 6.7
    assert out["is_stale"] is False


def test_stale_cache_refreshes(monkeypatch):
    async def ok(*args, **kwargs):
        return {"time_last_update_unix": TS, "rates": {"CNY": 6.7}}

    monkeypatch.setattr(ws_extras, "_http_get_json", ok)
    old = _row(rate=6.5, fetched_at=datetime.now(timezone.utc) - timedelta(hours=10))
    new = _row(rate=6.7, fetched_at=datetime.now(timezone.utc))
    conn = _Conn([old, new])
    out = asyncio.run(ws_extras._ensure_fresh_fx(conn, "USD", "CNY"))
    assert out["rate"] == 6.7
    assert conn.executed, "刷新后应 upsert 到 fx_rates"


def test_fetch_failure_falls_back_to_stale(monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(ws_extras, "_http_get_json", fail)
    old = _row(rate=6.5, fetched_at=datetime.now(timezone.utc) - timedelta(hours=10))
    out = asyncio.run(ws_extras._ensure_fresh_fx(_Conn([old]), "USD", "CNY"))
    assert out["rate"] == 6.5
    assert out["is_stale"] is True


def test_no_cache_and_fetch_failure_raises_503(monkeypatch):
    async def fail(*args, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(ws_extras, "_http_get_json", fail)
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(ws_extras._ensure_fresh_fx(_Conn([]), "USD", "CNY"))
    assert excinfo.value.status_code == 503
