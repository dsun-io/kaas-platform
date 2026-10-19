"""属性沉淀提案（`ws_admin_proposals.py`）—— 无数据库行为测试。

锁死与 orchestrator `app/api/admin_proposals.py` 的一致性：
- 三条路由存在（补生产 404）；鉴权 = internal + 管理员角色，其余 403；
- 列表 / 推荐 的响应键集与过滤条件；
- approve = 「插 spec_attributes + 回写提案状态」在同一事务里；
- reject / merge / invalid_action / not_found 的响应形状。
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_admin_proposals  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

_NOW = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)

PLATFORM_ADMIN = {
    "id": 1, "email": "root@qa.test", "display_name": "根", "account_type": "internal",
    "role": "system_admin", "status": "active", "team_id": None,
}
INTERNAL_MEMBER = {
    "id": 2, "email": "member@qa.test", "display_name": "成员", "account_type": "internal",
    "role": "user", "status": "active", "team_id": None,
}
CUSTOMER = {
    "id": 3, "email": "buyer@qa.test", "display_name": "买家", "account_type": "customer",
    "role": "owner", "status": "active", "team_id": None,
}


class _StubTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        self._conn.tx_started += 1
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _StubAcquire:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _StubConn:
    def __init__(self, *results):
        self._results = list(results)
        self.queries: list[tuple[str, tuple]] = []
        self.tx_started = 0

    def _next(self, q, args):
        self.queries.append((q, args))
        assert self._results, "端点执行了多于预期的查询（桩结果已用尽）"
        return self._results.pop(0)

    def transaction(self):
        return _StubTx(self)

    async def fetch(self, q, *args):
        return self._next(q, args)

    async def fetchrow(self, q, *args):
        return self._next(q, args)

    async def fetchval(self, q, *args):
        return self._next(q, args)

    async def execute(self, q, *args):
        self.queries.append((q, args))
        return "OK"


def _as(user: dict) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.fixture(autouse=True)
def _clean():
    yield
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _patched(monkeypatch, conn) -> None:
    monkeypatch.setattr(ws_admin_proposals, "_acquire", lambda _req: _StubAcquire(conn))


def _proposal_row(**over):
    row = {
        "id": 7,
        "tenant_id": "default",
        "category_id": 3,
        "proposed_name": "耐晒等级",
        "proposed_type": "enum",
        "group_code": "variant",
        "status": "pending",
        "occurrence_count": 4,
        "recommended_for_promotion": True,
        "recommendation_score": 0.85,
        "created_at": _NOW,
    }
    row.update(over)
    return row


# ── 鉴权 ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("user", [CUSTOMER, INTERNAL_MEMBER])
def test_non_platform_operator_forbidden(user):
    _as(user)
    for method, path in (
        ("get", "/api/v1/admin/spec/attribute-proposals"),
        ("get", "/api/v1/admin/spec/attribute-proposals/recommended"),
        ("patch", "/api/v1/admin/spec/attribute-proposals/7"),
    ):
        if method == "patch":
            resp = client.patch(path, json={})
        else:
            resp = client.get(path)
        assert resp.status_code == 403, (method, path, resp.text)


# ── 列表 / 推荐 ──────────────────────────────────────────────────────────────

def test_list_proposals_shape_and_status_filter(monkeypatch):
    conn = _StubConn([_proposal_row()])
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.get("/api/v1/admin/spec/attribute-proposals?status=pending")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["id"] == 7 and item["status"] == "pending"
    assert item["recommendation_score"] == 0.85
    assert item["created_at"] == _NOW.isoformat()
    assert item["recommended_for_promotion"] is True

    sql, args = conn.queries[0]
    assert "FROM attribute_proposals" in sql and "ORDER BY created_at DESC" in sql
    assert args == ("pending",)


def test_list_proposals_without_status_binds_none(monkeypatch):
    conn = _StubConn([])
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.get("/api/v1/admin/spec/attribute-proposals")
    assert resp.status_code == 200
    assert resp.json() == {"items": []}
    assert conn.queries[0][1] == (None,)


def test_recommended_shape_and_filter(monkeypatch):
    conn = _StubConn([{
        "id": 9, "tenant_id": "default", "proposed_name": "克重",
        "recommendation_score": None, "recommended_at": _NOW,
    }])
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.get("/api/v1/admin/spec/attribute-proposals/recommended")
    assert resp.status_code == 200, resp.text
    item = resp.json()["items"][0]
    assert item == {
        "id": 9, "tenant_id": "default", "proposed_name": "克重",
        "recommendation_score": None, "recommended_at": _NOW.isoformat(),
    }
    sql, _args = conn.queries[0]
    assert "recommended_for_promotion IS TRUE" in sql and "status = 'pending'" in sql


# ── 审核动作 ────────────────────────────────────────────────────────────────

def test_patch_not_found(monkeypatch):
    conn = _StubConn(None)
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch("/api/v1/admin/spec/attribute-proposals/7", json={"action": "reject"})
    assert resp.status_code == 200
    assert resp.json() == {"error": "not_found"}
    assert conn.tx_started == 1


def test_patch_approve_inserts_attribute_and_updates_proposal(monkeypatch):
    proposal = {
        "id": 7, "proposed_name": "耐晒等级", "proposed_type": "enum",
        "group_code": "variant", "proposed_unit": None, "proposed_unit_group": None,
        "private_attribute_id": 12,
    }
    conn = _StubConn(proposal, 55)
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch(
        "/api/v1/admin/spec/attribute-proposals/7",
        json={"action": "approve", "note": "ok", "code": "sun_resistance"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"id": 7, "status": "promoted", "promoted_attribute_id": 55}

    insert_sql, insert_args = conn.queries[1]
    assert "INSERT INTO spec_attributes" in insert_sql
    assert "RETURNING id" in insert_sql
    # code / name / group / type / unit / unit_group / promoted_from / created_by
    assert insert_args == (
        "sun_resistance", "耐晒等级", "variant", "enum", None, None, 12, "1",
    )

    update_sql, update_args = conn.queries[2]
    assert "UPDATE attribute_proposals" in update_sql
    assert "promoted_attribute_id=$4" in update_sql
    assert update_args == (7, "1", "ok", 55)
    assert conn.tx_started == 1


def test_patch_approve_default_code_from_name(monkeypatch):
    proposal = {
        "id": 7, "proposed_name": "UV Level", "proposed_type": "text",
        "group_code": "spec", "proposed_unit": None, "proposed_unit_group": None,
        "private_attribute_id": None,
    }
    conn = _StubConn(proposal, 56)
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch("/api/v1/admin/spec/attribute-proposals/7", json={"action": "approve"})
    assert resp.status_code == 200
    assert conn.queries[1][1][0] == "uv_level"


def test_patch_reject(monkeypatch):
    conn = _StubConn({"id": 7})
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch("/api/v1/admin/spec/attribute-proposals/7", json={"action": "reject", "note": "no"})
    assert resp.status_code == 200
    assert resp.json() == {"id": 7, "status": "rejected"}
    sql, args = conn.queries[1]
    assert "status='rejected'" in sql
    assert args == (7, "1", "no")


def test_patch_merge_requires_target(monkeypatch):
    conn = _StubConn({"id": 7})
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch("/api/v1/admin/spec/attribute-proposals/7", json={"action": "merge"})
    assert resp.status_code == 200
    assert resp.json() == {"error": "target_attribute_id required for merge"}
    assert len(conn.queries) == 1  # 只有取提案那一条，没有 UPDATE


def test_patch_merge_success(monkeypatch):
    conn = _StubConn({"id": 7})
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch(
        "/api/v1/admin/spec/attribute-proposals/7",
        json={"action": "merge", "target_attribute_id": 33, "note": "dup"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"id": 7, "status": "merged", "merged_into": 33}
    sql, args = conn.queries[1]
    assert "status='merged'" in sql
    assert args == (7, "1", "dup", 33)


def test_patch_invalid_action(monkeypatch):
    conn = _StubConn({"id": 7})
    _patched(monkeypatch, conn)
    _as(PLATFORM_ADMIN)

    resp = client.patch("/api/v1/admin/spec/attribute-proposals/7", json={"action": "drop"})
    assert resp.status_code == 200
    assert resp.json() == {"error": "invalid_action"}
