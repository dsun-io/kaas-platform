"""个人信息编辑（TODO F3）守卫：改显示名 / 改密码的边界（无数据库、无网络）。

为什么单独锁：
1. **只能改自己**：id 来自 token，body 里不接受 user_id —— 越权改他人资料是账号劫持面；
2. **邮箱不提供自助修改**：它是登录标识，改它需要验证新邮箱的链路（当前没有）；
3. **改密码必须验旧密码**：否则拿到 token（XSS/共享设备）就能直接改密码永久接管账号；
4. 校验先于落库：空名/超长/短密码不应该先写一次库再报错。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}


class _FakeConn:
    def __init__(self, fetchrow=None):
        self._fetchrow = list(fetchrow or [])
        self.queries: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.queries.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def execute(self, sql, *args):
        self.queries.append((sql, args))
        return "UPDATE 1"


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


def _user_row(**over):
    row = {
        "id": 1, "email": "admin@kaas.test", "display_name": "平台管理员",
        "account_type": "internal", "role": "system_admin", "plan": "internal",
        "team_id": None, "console_access": False, "is_tenant_admin": False,
    }
    row.update(over)
    return row


def test_patch_me_updates_own_display_name():
    conn = _FakeConn(fetchrow=[_user_row(display_name="新名字")])
    with _patched(conn):
        resp = client.patch("/api/v1/auth/me", json={"display_name": "  新名字  "})

    assert resp.status_code == 200
    body = resp.json()
    assert body["display_name"] == "新名字"       # 前后空格被裁掉
    assert body["user_id"] == 1
    assert body["effective_role"] == "system_admin"
    # 只更新**本人**（token 里的 id），不接受 body 传别人的 id
    sql, args = conn.queries[0]
    assert "UPDATE users SET display_name=$1" in sql
    assert args[1] == ADMIN["id"]


def test_patch_me_rejects_blank_before_touching_db():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.patch("/api/v1/auth/me", json={"display_name": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "DISPLAY_NAME_REQUIRED"
    assert conn.queries == []


def test_patch_me_rejects_too_long_before_touching_db():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.patch("/api/v1/auth/me", json={"display_name": "x" * 65})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "DISPLAY_NAME_TOO_LONG"
    assert conn.queries == []


def test_patch_me_ignores_injected_user_id():
    """body 里塞 user_id 也不能改别人：路由只认 token 里的 id（多余键被 Pydantic 忽略）。"""
    conn = _FakeConn(fetchrow=[_user_row(display_name="改名")])
    with _patched(conn):
        resp = client.patch(
            "/api/v1/auth/me", json={"display_name": "改名", "user_id": 999})
    assert resp.status_code == 200
    _sql, args = conn.queries[0]
    assert args[1] == 1          # 仍是自己


def test_change_password_requires_current_password():
    old_hash = worker_main._hash_password("oldpass123")
    conn = _FakeConn(fetchrow=[{"password_hash": old_hash}])
    with _patched(conn):
        resp = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "wrong-pass", "new_password": "newpass123"},
        )
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "INVALID_CURRENT_PASSWORD"
    assert not any("UPDATE users SET password_hash" in q for q, _ in conn.queries)


def test_change_password_updates_hash_when_old_matches():
    old_hash = worker_main._hash_password("oldpass123")
    conn = _FakeConn(fetchrow=[{"password_hash": old_hash}])
    with _patched(conn):
        resp = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "oldpass123", "new_password": "newpass456"},
        )
    assert resp.status_code == 200
    updates = [(q, a) for q, a in conn.queries if "UPDATE users SET password_hash" in q]
    assert len(updates) == 1
    new_hash = updates[0][1][0]
    assert new_hash != old_hash
    assert worker_main._verify_password("newpass456", new_hash)


def test_change_password_rejects_short_new_password():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.post(
            "/api/v1/auth/change-password",
            json={"current_password": "oldpass123", "new_password": "short"},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PASSWORD_TOO_SHORT"
    assert conn.queries == []       # 校验先于落库
