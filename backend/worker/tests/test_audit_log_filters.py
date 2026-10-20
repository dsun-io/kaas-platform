"""C39：`GET /admin/audit-log` 筛选参数回归（此前被静默忽略）。

为什么要这个文件
----------------
前端 audit 页一直传 `action` / `resource_type` / `since` / `until`（hook 还支持 `actor_id`），
但后端只接 `page` / `page_size` ⇒ 真实环境筛选**只影响页码、不影响结果**（C25 验收发现）。
本文件钉住 SQL 形状与参数顺序（含日期边界），防止再退化。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

main = load_main()

ADMIN = {"id": 1, "account_type": "internal", "role": "admin"}
CUSTOMER = {"id": 2, "account_type": "customer", "role": "customer_owner"}


class _DB:
    def __init__(self):
        self.fetchval_calls: list[tuple[str, tuple]] = []
        self.fetch_calls: list[tuple[str, tuple]] = []

    async def fetchval(self, request, sql, *params):
        self.fetchval_calls.append((" ".join(sql.split()), params))
        return 0

    async def fetch(self, request, sql, *params, table=None):
        self.fetch_calls.append((" ".join(sql.split()), params))
        return []


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def fake_db(monkeypatch):
    db = _DB()
    monkeypatch.setattr(main, "db", db)
    return db


def test_no_filters_keeps_original_sql(fake_db):
    _run(main.get_audit_log(object(), page=2, page_size=20, user=ADMIN))

    count_sql, count_params = fake_db.fetchval_calls[0]
    assert "WHERE" not in count_sql
    assert count_params == ()

    rows_sql, rows_params = fake_db.fetch_calls[0]
    assert "LIMIT $1 OFFSET $2" in rows_sql
    assert rows_params == (20, 20)  # page=2 → offset 20


def test_all_filters_are_bound_and_ordered(fake_db):
    _run(main.get_audit_log(
        object(), page=1, page_size=50,
        action="flag_toggle", actor_id="42", resource_type="feature_flag",
        since="2026-01-01", until="2026-01-31", user=ADMIN,
    ))

    count_sql, count_params = fake_db.fetchval_calls[0]
    assert "action = $1" in count_sql
    assert "actor_id = $2" in count_sql
    assert "resource_type = $3" in count_sql
    assert "created_at >= $4::date" in count_sql
    assert "created_at < ($5::date + interval '1 day')" in count_sql
    assert count_params == ("flag_toggle", "42", "feature_flag", "2026-01-01", "2026-01-31")

    rows_sql, rows_params = fake_db.fetch_calls[0]
    assert "action = $1" in rows_sql
    assert "LIMIT $6 OFFSET $7" in rows_sql
    assert rows_params == (
        "flag_toggle", "42", "feature_flag", "2026-01-01", "2026-01-31", 50, 0)


def test_partial_filters_keep_placeholder_contiguity(fake_db):
    _run(main.get_audit_log(object(), action="x", until="2026-02-01", user=ADMIN))

    count_sql, count_params = fake_db.fetchval_calls[0]
    assert "action = $1" in count_sql
    assert "created_at < ($2::date + interval '1 day')" in count_sql
    assert count_params == ("x", "2026-02-01")

    rows_sql, rows_params = fake_db.fetch_calls[0]
    assert "LIMIT $3 OFFSET $4" in rows_sql
    assert rows_params == ("x", "2026-02-01", 20, 0)


def test_customer_is_forbidden(fake_db):
    with pytest.raises(Exception) as exc:
        _run(main.get_audit_log(object(), user=CUSTOMER))
    assert getattr(exc.value, "status_code", 0) == 403
    assert fake_db.fetchval_calls == []
