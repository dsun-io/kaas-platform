"""C30：`GET /api/v1/admin/archive-logs` 接真实 `events_archive_log`（无数据库）。

背景：端点此前是**占位空列表**（注释"Worker 无文件系统"），但数据在库里 ——
`backend/worker/src/ws_cron.py` 每月把上月事件写成 R2 对象后插一行
`(tenant_id='*', month='YYYY-MM', minio_path='{bucket}/events-archive/…', status='archived')`。

本文件钉住三件容易复发的事：
1. **不做租户过滤**：写入行 `tenant_id='*'`，一旦加 `tenant_id=$1` 就永远空列表；
2. 分页参数进 SQL 的顺序（`LIMIT $n-1 OFFSET $n`）与回显；
3. `month` 过滤只多一个占位参数，且空列表时形状不变（前端据 `total` 显示空态）。
"""
from __future__ import annotations

import sys
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}


class _FakeDb:
    """冒充 platform/db：只记录 SQL 与参数，按预设返回。"""

    def __init__(self, *, total=0, rows=None):
        self._total = total
        self._rows = list(rows or [])
        self.calls: list[tuple[str, str, tuple]] = []

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append(("fetchval", sql, args))
        return self._total

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append(("fetch", sql, args))
        return self._rows

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append(("fetchrow", sql, args))
        return None

    async def execute(self, request, sql, *args):
        self.calls.append(("execute", sql, args))
        return "OK"


@contextmanager
def _patched(db, user=ADMIN):
    old_db = worker_main.db
    worker_main.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        worker_main.db = old_db
        worker_main.app.dependency_overrides.clear()


def _row(month="2026-09", status="archived"):
    return {
        "id": "6f1b0c0a-5c2a-4d5e-8f9a-0b1c2d3e4f5a",
        "month": month,
        "minio_path": "kaas-events-archive/events-archive/2026/09/01/v1.jsonl.gz",
        "status": status,
        "archived_at": datetime(2026, 10, 1, 2, 0, tzinfo=timezone.utc),
    }


def test_archive_logs_shape_pagination_and_no_tenant_filter():
    """形状 + 分页参数顺序；**不得**出现 tenant_id 过滤（会滤掉 '*' 行）。"""
    db = _FakeDb(total=42, rows=[_row(), _row(month="2026-08")])
    with _patched(db):
        resp = client.get("/api/v1/admin/archive-logs", params={"page": 2, "page_size": 10})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"items", "total", "page", "page_size"}
    assert body["total"] == 42
    assert body["page"] == 2
    assert body["page_size"] == 10
    assert len(body["items"]) == 2
    first = body["items"][0]
    # 前端契约字段（`path` 是 `minio_path` 的对外名）
    assert set(first) == {"id", "month", "path", "status", "archived_at"}
    assert first["path"].startswith("kaas-events-archive/")
    assert first["archived_at"] == "2026-10-01T02:00:00+00:00"

    count_sql, count_args = db.calls[0][1], db.calls[0][2]
    list_sql, list_args = db.calls[1][1], db.calls[1][2]
    assert "events_archive_log" in count_sql
    assert "tenant_id" not in count_sql and "tenant_id" not in list_sql
    assert "ORDER BY archived_at DESC" in list_sql
    assert "LIMIT $1 OFFSET $2" in list_sql
    # page=2,page_size=10 ⇒ LIMIT 10 OFFSET 10
    assert count_args == ()
    assert list_args == (10, 10)


def test_archive_logs_month_filter_becomes_placeholder():
    """`month` 过滤只多一个占位参数（参数化，不拼用户输入）。"""
    db = _FakeDb(total=1, rows=[_row()])
    with _patched(db):
        resp = client.get(
            "/api/v1/admin/archive-logs",
            params={"month": "2026-09", "page": 1, "page_size": 5},
        )

    assert resp.status_code == 200, resp.text
    count_sql, count_args = db.calls[0][1], db.calls[0][2]
    list_sql, list_args = db.calls[1][1], db.calls[1][2]
    assert "month = $1" in count_sql
    assert "month = $1" in list_sql
    assert "LIMIT $2 OFFSET $3" in list_sql
    assert count_args == ("2026-09",)
    assert list_args == ("2026-09", 5, 0)


def test_archive_logs_empty_keeps_shape():
    """真没有记录时形状不变（前端据 total==0 显示"暂无记录"，不是报错）。"""
    db = _FakeDb(total=0, rows=[])
    with _patched(db):
        resp = client.get("/api/v1/admin/archive-logs")

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"items": [], "total": 0, "page": 1, "page_size": 20}


def test_archive_logs_clamps_bounds_like_neighbour_admin_endpoints():
    """page/page_size 越界钳位（与相邻 events / audit-log 同一口径，不是 422）。"""
    db = _FakeDb(total=0, rows=[])
    with _patched(db):
        resp = client.get(
            "/api/v1/admin/archive-logs", params={"page": 0, "page_size": 999}
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["page"] == 1
    assert body["page_size"] == 100
