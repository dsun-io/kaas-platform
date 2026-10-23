"""品名对照 CRUD（`/api/v1/market/name-mappings`）—— 无数据库行为测试（C36 #19）。

锁死与 TS 门面 / 前端共用的契约（lead 定稿）：
- GET 列表：{items,total,page,page_size}；分页 page>=1、page_size 1..100（默认 20）；
  q = local_name ILIKE 或 alt_names 任一 ILIKE；region_code 大写归一；lang 精确；
  排序 is_verified DESC, created_at DESC；tenant 恒为 default。
- PATCH：全可选 body（model_fields_set 只更新传入字段），显式空 body → 422；
  不存在（或非本 tenant）→ 404；唯一键冲突 → 409；显式 updated_at=NOW()。
- DELETE：204；不存在 → 404。
- 鉴权同现有 POST（Bearer JWT；无 token → 401，且不触库）。

做法：FastAPI TestClient + dependency_overrides 注入用户，`_acquire` 打桩为
`_StubConn`（记录 SQL/参数、按序返回预置结果）。不连 DB、不发网络。
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

_NOW = datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc)

USER = {
    "id": 7, "email": "crud@qa.test", "display_name": "CRUD",
    "account_type": "internal", "role": "sales", "status": "active",
    "team_id": 3, "console_access": False, "plan": "free", "is_tenant_admin": False,
}


class _StubAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _StubConn:
    """按调用顺序返回预置结果；记录每条 SQL 与绑定参数。"""

    def __init__(self, *results):
        self._results = list(results)
        self.queries: list[tuple[str, tuple]] = []

    def _next(self, q, args):
        self.queries.append((q, args))
        assert self._results, "端点执行了多于预期的查询（桩结果已用尽）"
        result = self._results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    async def fetch(self, q, *args):
        return self._next(q, args)

    async def fetchrow(self, q, *args):
        return self._next(q, args)

    async def fetchval(self, q, *args):
        return self._next(q, args)

    async def execute(self, q, *args):
        self.queries.append((q, args))
        return "OK"


class _UniqueViolation(Exception):
    """asyncpg.UniqueViolationError 的最小替身（sqlstate 23505）。"""

    sqlstate = "23505"


def _as_user(user):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.fixture(autouse=True)
def _clean():
    yield
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


@pytest.fixture()
def patched(monkeypatch):
    def _install(conn):
        monkeypatch.setattr(worker_main, "_acquire", lambda _req: _StubAcquire(conn))
        return conn
    return _install


def _row(**over):
    row = {
        "id": 11,
        "tenant_id": "default",
        "category_id": 3,
        "region_code": "US",
        "lang": "en",
        "local_name": "Chain Link Fence",
        "alt_names": ["chain link fencing"],
        "hs_code": "7314.41",
        "source": "manual",
        "confidence": "high",
        "is_verified": True,
        "created_at": _NOW,
        "updated_at": _NOW,
    }
    row.update(over)
    return row


# ── 鉴权（同现有 POST）──────────────────────────────────────────────────────

def test_requires_bearer_token_for_all_three_routes(patched):
    conn = patched(_StubConn())
    for method, path, kwargs in (
        ("get", "/api/v1/market/name-mappings", {}),
        ("patch", "/api/v1/market/name-mappings/11", {"json": {"local_name": "x"}}),
        ("delete", "/api/v1/market/name-mappings/11", {}),
    ):
        resp = getattr(client, method)(path, **kwargs)
        assert resp.status_code == 401, (method, path, resp.text)
        assert resp.json()["detail"]["error"] == "unauthorized"
    # 闸门先于任何 SQL
    assert conn.queries == []


# ── GET 列表：分页 / 形状 ───────────────────────────────────────────────────

def test_list_default_pagination_and_shape(patched):
    conn = patched(_StubConn(2, [_row(), _row(id=12, local_name="Welded Mesh")]))
    _as_user(USER)
    resp = client.get("/api/v1/market/name-mappings")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 2 and body["page"] == 1 and body["page_size"] == 20
    assert [item["id"] for item in body["items"]] == [11, 12]
    assert body["items"][0]["local_name"] == "Chain Link Fence"

    count_sql, count_args = conn.queries[0]
    rows_sql, rows_args = conn.queries[1]
    assert count_sql.startswith("SELECT COUNT(*) FROM market_product_name_mappings")
    assert "WHERE tenant_id = $1" in count_sql
    assert count_args == ("default",)
    # 排序与 name-lookup 同口径 + LIMIT/OFFSET 走位置参数
    assert "ORDER BY is_verified DESC, created_at DESC" in rows_sql
    assert "LIMIT $2 OFFSET $3" in rows_sql
    assert rows_args == ("default", 20, 0)


def test_list_page_offset(patched):
    conn = patched(_StubConn(0, []))
    _as_user(USER)
    resp = client.get("/api/v1/market/name-mappings?page=3&page_size=5")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["page"] == 3 and body["page_size"] == 5
    assert conn.queries[1][1] == ("default", 5, 10)


@pytest.mark.parametrize("query", ["page=0", "page_size=0", "page_size=101"])
def test_list_rejects_out_of_range_paging(patched, query):
    conn = patched(_StubConn())
    _as_user(USER)
    resp = client.get("/api/v1/market/name-mappings?" + query)
    assert resp.status_code == 422, resp.text
    assert conn.queries == []


# ── GET 列表：筛选 ─────────────────────────────────────────────────────────

def test_list_filters_q_region_lang(patched):
    conn = patched(_StubConn(1, [_row()]))
    _as_user(USER)
    resp = client.get(
        "/api/v1/market/name-mappings?q=fence&region_code=us&lang=en&page=2&page_size=10")
    assert resp.status_code == 200, resp.text
    count_sql, count_args = conn.queries[0]
    assert "tenant_id = $1" in count_sql
    assert "local_name ILIKE $2" in count_sql
    assert "jsonb_array_elements_text" in count_sql and "alt_names" in count_sql
    assert "region_code = $3" in count_sql
    assert "lang = $4" in count_sql
    # region_code 大写归一；lang 精确；q 包 %；tenant 恒 default
    assert count_args == ("default", "%fence%", "US", "en")
    rows_sql, rows_args = conn.queries[1]
    assert "LIMIT $5 OFFSET $6" in rows_sql
    assert rows_args == ("default", "%fence%", "US", "en", 10, 10)


def test_list_without_filters_has_only_tenant_where(patched):
    conn = patched(_StubConn(0, []))
    _as_user(USER)
    resp = client.get("/api/v1/market/name-mappings?q=&region_code=&lang=")
    assert resp.status_code == 200, resp.text
    assert "WHERE tenant_id = $1" in conn.queries[0][0]
    assert conn.queries[0][1] == ("default",)


# ── PATCH：部分更新 / 唯一键 409 / 404 ─────────────────────────────────────

def test_patch_updates_only_provided_fields(patched):
    updated = _row(local_name="Chain Link Fence Pro", is_verified=False)
    conn = patched(_StubConn(updated))
    _as_user(USER)
    resp = client.patch("/api/v1/market/name-mappings/11",
                        json={"local_name": "Chain Link Fence Pro", "is_verified": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["local_name"] == "Chain Link Fence Pro"
    assert resp.json()["is_verified"] is False
    sql, args = conn.queries[0]
    # 只更新传入字段（falsy 的 is_verified 也必须被写入）
    assert "local_name = $1" in sql and "is_verified = $2" in sql
    assert "category_id" not in sql and "alt_names" not in sql
    assert "updated_at = NOW()" in sql
    assert "WHERE id = $3 AND tenant_id = $4" in sql
    assert args == ("Chain Link Fence Pro", False, 11, "default")


def test_patch_region_upper_alt_names_jsonb_and_explicit_null(patched):
    updated = _row(region_code="EU", alt_names=["cloture"], hs_code=None)
    conn = patched(_StubConn(updated))
    _as_user(USER)
    resp = client.patch(
        "/api/v1/market/name-mappings/11",
        json={"region_code": "eu", "alt_names": ["cloture"], "hs_code": None},
    )
    assert resp.status_code == 200, resp.text
    sql, args = conn.queries[0]
    assert "region_code = $1" in sql
    assert "alt_names = $2::jsonb" in sql
    assert "hs_code = $3" in sql
    assert args[0] == "EU"
    assert args[1] == '["cloture"]'
    assert args[2] is None


def test_patch_empty_body_422(patched):
    conn = patched(_StubConn())
    _as_user(USER)
    resp = client.patch("/api/v1/market/name-mappings/11", json={})
    assert resp.status_code == 422, resp.text
    assert "No fields to update" in resp.text
    assert conn.queries == []


def test_patch_missing_row_404(patched):
    conn = patched(_StubConn(None))
    _as_user(USER)
    resp = client.patch("/api/v1/market/name-mappings/99", json={"local_name": "x"})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == {
        "error": "not_found", "code": "NAME_MAPPING_NOT_FOUND"}
    # tenant 作用域：UPDATE 仍带 tenant_id（非本 tenant 等同不存在）
    assert "AND tenant_id = $3" in conn.queries[0][0]
    assert conn.queries[0][1][-1] == "default"


def test_patch_unique_violation_409(patched):
    conn = patched(_StubConn(_UniqueViolation(
        'duplicate key value violates unique constraint "uq_market_name_mappings"')))
    _as_user(USER)
    resp = client.patch("/api/v1/market/name-mappings/11", json={"local_name": "dup"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == {
        "error": "conflict", "code": "NAME_MAPPING_EXISTS"}


def test_patch_unique_violation_by_message_409(patched):
    """非 asyncpg 的桩异常只要带 duplicate key 文案也归 409（同 ws_teams 口径）。"""
    conn = patched(_StubConn(Exception(
        'duplicate key value violates unique constraint "uq_market_name_mappings"')))
    _as_user(USER)
    resp = client.patch("/api/v1/market/name-mappings/11", json={"lang": "zh"})
    assert resp.status_code == 409, resp.text


# ── DELETE：204 / 404 ─────────────────────────────────────────────────────

def test_delete_204(patched):
    conn = patched(_StubConn(11))
    _as_user(USER)
    resp = client.delete("/api/v1/market/name-mappings/11")
    assert resp.status_code == 204, resp.text
    assert resp.content == b""
    sql, args = conn.queries[0]
    assert sql.startswith("DELETE FROM market_product_name_mappings")
    assert "WHERE id=$1 AND tenant_id=$2" in sql
    assert args == (11, "default")


def test_delete_missing_404(patched):
    conn = patched(_StubConn(None))
    _as_user(USER)
    resp = client.delete("/api/v1/market/name-mappings/99")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"] == {
        "error": "not_found", "code": "NAME_MAPPING_NOT_FOUND"}
    assert conn.queries[0][1] == (99, "default")
