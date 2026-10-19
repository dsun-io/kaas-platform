"""平台账号治理（`ws_admin_accounts.py`）—— 无数据库单元测试。

与 orchestrator 侧 `tests/test_admin_accounts.py` 同口径：
- 响应白名单（无 password_hash/token）；
- 角色映射（历史 admin → system_admin）；
- 鉴权：仅 internal + is_admin_role 放行，internal 普通账号与 customer 一律 403；
- 无凭据请求先被鉴权拦截（路由已注册，不是 404）；
- 分页：limit（上限 1000 截断）/offset 落到 SQL（LIMIT/OFFSET），响应附 total；
- 竞态修复：LAST_ADMIN 判定取自 FOR UPDATE 行锁查询（锁到的行数 ≤1 才 409）。

不连库：HTTP 断言只覆盖「鉴权先于取连接」的分支。
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import ws_admin_accounts  # noqa: E402,F401

client = TestClient(worker_main.app, raise_server_exceptions=False)

# 注意：worker 侧**不**写 `pytestmark = pytest.mark.unit` —— 该环境没注册 `unit`
# 标记（见 test_ws_files_team_scope.py:34 的同类说明），worker 的验收命令是整包 pytest。

_NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)

SYSTEM_ADMIN = {
    "id": 1, "email": "root@qa.test", "display_name": "根", "account_type": "internal",
    "role": "system_admin", "status": "active", "team_id": None, "console_access": False,
}
INTERNAL_MEMBER = {
    "id": 2, "email": "member@qa.test", "display_name": "成员", "account_type": "internal",
    "role": "user", "status": "active", "team_id": None, "console_access": False,
}
CUSTOMER = {
    "id": 3, "email": "buyer@qa.test", "display_name": "买家", "account_type": "customer",
    "role": "owner", "status": "active", "team_id": None, "console_access": False,
}


def _row(**over):
    base = {
        "id": 5, "email": "u5@qa.test", "display_name": "用户5", "account_type": "internal",
        "role": "user", "status": "active", "team_id": None, "console_access": False,
        "created_at": _NOW, "updated_at": _NOW, "team_name": None,
    }
    base.update(over)
    return base


def _as(user: dict):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.fixture(autouse=True)
def _clean_overrides():
    yield
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


# ── 响应白名单 / 角色映射 ────────────────────────────────────────────────────

def test_account_out_whitelist_has_no_sensitive_keys():
    payload = ws_admin_accounts._account_out(_row(role="admin", team_name="示例团队"))
    assert set(payload) == {
        "id", "email", "display_name", "account_type", "role", "status",
        "team_id", "team_name", "console_access", "created_at", "updated_at",
    }
    assert "password_hash" not in payload and "token" not in payload
    assert payload["role"] == "system_admin"
    assert payload["team_name"] == "示例团队"


def test_account_out_maps_legacy_and_unknown_roles():
    assert ws_admin_accounts._account_out(_row(role="admin"))["role"] == "system_admin"
    assert ws_admin_accounts._account_out(_row(role="owner"))["role"] == "customer_owner"
    assert ws_admin_accounts._account_out(_row(role="???"))["role"] == "customer_member"


# ── 鉴权判定 ─────────────────────────────────────────────────────────────────

def test_require_system_admin_rejects_internal_member():
    with pytest.raises(HTTPException) as exc:
        ws_admin_accounts._require_system_admin(INTERNAL_MEMBER)
    assert exc.value.status_code == 403


def test_require_system_admin_rejects_customer():
    with pytest.raises(HTTPException) as exc:
        ws_admin_accounts._require_system_admin(CUSTOMER)
    assert exc.value.status_code == 403


def test_require_system_admin_accepts_legacy_admin_role():
    ws_admin_accounts._require_system_admin({**SYSTEM_ADMIN, "role": "admin"})


def test_require_system_admin_accepts_system_admin():
    ws_admin_accounts._require_system_admin(SYSTEM_ADMIN)


# ── HTTP：无凭据 / 非管理员（鉴权先于取连接，不触库）─────────────────────────

def test_list_accounts_requires_credentials():
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code in (401, 403)
    assert resp.status_code != 404


def test_patch_account_requires_credentials():
    resp = client.patch("/api/v1/admin/accounts/2", json={"status": "disabled"})
    assert resp.status_code in (401, 403)
    assert resp.status_code != 404


def test_list_accounts_forbidden_for_internal_member():
    _as(INTERNAL_MEMBER)
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code == 403


def test_list_accounts_forbidden_for_customer():
    _as(CUSTOMER)
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code == 403


def test_patch_account_forbidden_for_customer():
    _as(CUSTOMER)
    resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})
    assert resp.status_code == 403


# ── 分页 / FOR UPDATE 竞态修复（桩连接，不触真库）────────────────────────────

class _StubTx:
    def __init__(self, conn):
        self._conn = conn

    async def __aenter__(self):
        return self._conn

    async def __aexit__(self, *exc):
        return False


class _StubAcquire:
    """伪装 `_acquire(request)`，把桩连接交给端点并记录全部 SQL。"""

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

    def _next(self, q, args):
        self.queries.append((q, args))
        assert self._results, "端点执行了多于预期的查询（桩结果已用尽）"
        return self._results.pop(0)

    def transaction(self):
        return _StubTx(self)

    async def fetch(self, q, *args):
        return self._next(q, args)

    async def fetchval(self, q, *args):
        return self._next(q, args)

    async def fetchrow(self, q, *args):
        return self._next(q, args)


def _patched_acquire(monkeypatch, conn):
    monkeypatch.setattr(
        ws_admin_accounts, "_acquire", lambda _req: _StubAcquire(conn)
    )


def test_list_accounts_pagination_total_and_limit_offset(monkeypatch):
    conn = _StubConn(10, [_row(id=1), _row(id=2)])  # total, 本页两行
    _patched_acquire(monkeypatch, conn)
    _as(SYSTEM_ADMIN)
    resp = client.get("/api/v1/admin/accounts?limit=2&offset=1")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total"] == 10                 # total 不受分页影响
    assert [a["id"] for a in body["accounts"]] == [1, 2]
    list_sql, bind_args = conn.queries[1]
    assert "LIMIT $1 OFFSET $2" in list_sql
    assert bind_args == (2, 1)


def test_list_accounts_out_of_range_pagination_is_422(monkeypatch):
    """已修 2026-10-19：limit/offset 越界 → 422（与 orchestrator Query 校验同口径，PARITY-DIFF-13）。"""
    _as(SYSTEM_ADMIN)
    for query in ("limit=99999&offset=-5", "limit=0", "offset=-1"):
        resp = client.get(f"/api/v1/admin/accounts?{query}")
        assert resp.status_code == 422, query


def test_patch_disable_last_admin_uses_for_update_lock(monkeypatch):
    """竞态修复：LAST_ADMIN 判定改自 FOR UPDATE 行锁查询，而非裸 count。"""
    target = _row(id=9, role="system_admin")
    conn = _StubConn(
        target,    # SELECT 目标行
        [9],       # FOR UPDATE 锁到的 active 管理员行（只剩目标一个）
    )
    _patched_acquire(monkeypatch, conn)
    _as(SYSTEM_ADMIN)
    resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "LAST_ADMIN"
    lock_sql, _ = conn.queries[1]
    assert "FOR UPDATE" in lock_sql and "count" not in lock_sql.lower()
