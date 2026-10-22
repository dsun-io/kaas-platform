"""团队「加入申请」API 的 Worker 行为测试（无数据库、无网络）。

覆盖（2026-10-22 新模块）：
- 注册时发起申请：团队已存在 → 建号 + pending 申请（team_id 留空）；
  团队不存在 404；留言超长 422；
- 团队名查重 `GET /teams/check-name`：存在/不存在/空名 422（只回布尔）；
- 管理员列表（状态过滤、非管理员 403、非法 status 422）；
- 审核通过：落 users.team_id + 申请 approved；重复审核 409；申请人已入他团 409；
- 驳回：写理由；理由超长 422；
- 申请人撤回：本人 200、他人 404、非 pending 409；
- `GET /me/join-application`：最近一条 + 团队名；没有则 null。

做法同 `test_teams_api.py`：假连接 + 依赖覆盖，不碰 Hyperdrive。
注意 `ws_join_applications._acquire` 是**模块级别名**（import 时取的 main._acquire），
所以要 patch 它自己，而不是 main。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
import ws_join_applications  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)


@pytest.fixture(autouse=True)
def _jwt_secret(monkeypatch):
    """注册成功会签 JWT：与 test_parity_auth 同口径，固定测试密钥。"""
    monkeypatch.setenv("JWT_SECRET", "join-applications-test-secret-0123456789abcdef")

ADMIN_USER = {"id": 3, "email": "lianjia@kaas.local", "display_name": "联佳",
              "account_type": "customer", "role": "owner", "team_id": 1}
MEMBER_USER = {"id": 9, "email": "newbie@kaas.local", "display_name": "新人",
               "account_type": "customer", "role": "user", "team_id": None}
_PASSWORD = "strongpass123"


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        if fetchrow is None:
            self._fetchrow = []
        elif isinstance(fetchrow, list):
            self._fetchrow = list(fetchrow)
        else:
            self._fetchrow = [fetchrow]
        self._fetchval = list(fetchval) if isinstance(fetchval, list) else (
            [] if fetchval is None else [fetchval])
        self._fetch = list(fetch) if isinstance(fetch, list) else (
            [] if fetch is None else [fetch])
        self.executed: list[tuple[str, tuple]] = []
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
        self.calls.append((sql, args))
        self.executed.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        return _FakeTxn()

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


@contextmanager
def _patched(conn, user=None, *, module=ws_join_applications):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = module._acquire
    module._acquire = fake_acquire
    if user is not None:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        module._acquire = old
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _team_row(**over):
    row = {"id": 1, "tenant_id": "default", "name": "安平县联佳丝网制品有限公司",
           "created_by": 3, "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc),
           "updated_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


def _application_row(**over):
    row = {"id": 11, "tenant_id": "default", "team_id": 1, "user_id": 9,
           "email": "newbie@qa.test", "display_name": "新人", "message": "想加入",
           "status": "pending", "reviewed_by": None, "reviewed_at": None,
           "reject_reason": None,
           "created_at": datetime(2026, 10, 22, tzinfo=timezone.utc),
           "updated_at": None}
    row.update(over)
    return row


def _user_row(**over):
    row = {"id": 9, "email": "newbie@qa.test", "display_name": "新人",
           "account_type": "customer", "role": "user", "status": "active"}
    row.update(over)
    return row


def _register_body(**over):
    body = {"email": "newbie@qa.test", "password": _PASSWORD, "display_name": "新人",
            "product_category": "fencing"}
    body.update(over)
    return body


# ════════════════════════════════════════════════════════════════════════════
# 1. 注册时发起加入申请
# ════════════════════════════════════════════════════════════════════════════

def test_register_with_application_creates_pending_without_joining():
    """团队已存在 → 建号（role=user、team_id=NULL）+ pending 申请，一个事务。"""
    conn = _FakeConn(
        fetchval=[None],                                     # 邮箱查重：没占用
        fetchrow=[_team_row(id=3, name="联佳"),               # 团队存在性查询
                  _user_row(),                               # INSERT users
                  {"id": 21}],                               # INSERT application RETURNING id
    )
    with _patched(conn, module=worker_main):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(apply_team_name="联佳", apply_message=" 我是销售部王五 "),
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "user"
    assert body["team_id"] is None and body["team_name"] is None
    assert body["application"] == {
        "id": 21, "team_id": 3, "team_name": "联佳", "status": "pending",
    }
    insert_sql, insert_args = next(
        (sql, args) for sql, args in conn.calls if "INSERT INTO team_join_applications" in sql
    )
    assert "'pending'" in insert_sql
    assert "我是销售部王五" in insert_args          # 留言已去首尾空白
    # 关键：没有把用户直接塞进团队
    assert "UPDATE users SET team_id=" not in conn.sql()


def test_register_application_team_not_found_404():
    """团队不存在 → 404 TEAM_NOT_FOUND（先于邮箱查重，与坏邀请码同口径）。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, module=worker_main):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(apply_team_name="不存在的团队")
        )
    assert resp.status_code == 404
    detail = resp.json()["detail"]
    assert detail["code"] == "TEAM_NOT_FOUND"
    assert "不存在" in detail["message"]


def test_register_application_message_too_long_422():
    conn = _FakeConn()
    with _patched(conn, module=worker_main):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(apply_team_name="联佳", apply_message="长" * 201),
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "APPLICATION_MESSAGE_TOO_LONG"
    assert conn.calls == []          # 规则校验在建连接前，不碰库


# ════════════════════════════════════════════════════════════════════════════
# 2. 团队名查重（公开只读）
# ════════════════════════════════════════════════════════════════════════════

def test_check_name_reports_exists_without_leaking_list():
    conn = _FakeConn(fetchval=[1])
    with _patched(conn):
        resp = client.get("/api/v1/teams/check-name", params={"name": "  联佳  "})
    assert resp.status_code == 200
    assert resp.json() == {"name": "联佳", "exists": True}


def test_check_name_false_when_absent():
    conn = _FakeConn(fetchval=[None])
    with _patched(conn):
        resp = client.get("/api/v1/teams/check-name", params={"name": "新团队"})
    assert resp.json() == {"name": "新团队", "exists": False}


def test_check_name_blank_422():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.get("/api/v1/teams/check-name", params={"name": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_TEAM_NAME"


# ════════════════════════════════════════════════════════════════════════════
# 3. 管理员列表
# ════════════════════════════════════════════════════════════════════════════

def test_list_applications_for_admin():
    conn = _FakeConn(fetchrow=[_team_row()], fetch=[[_application_row()]])
    with _patched(conn, ADMIN_USER):
        resp = client.get("/api/v1/teams/1/join-applications")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["status"] == "pending"
    assert "status=$2" in conn.sql()          # 默认只看 pending


def test_list_applications_all_skips_status_filter():
    conn = _FakeConn(fetchrow=[_team_row()], fetch=[[_application_row()]])
    with _patched(conn, ADMIN_USER):
        resp = client.get("/api/v1/teams/1/join-applications?status=all")
    assert resp.status_code == 200
    assert "AND status=" not in conn.sql()


def test_list_applications_non_admin_403():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)])
    with _patched(conn, MEMBER_USER):
        resp = client.get("/api/v1/teams/1/join-applications")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_TEAM_ADMIN"


def test_list_applications_invalid_status_422():
    conn = _FakeConn()
    with _patched(conn, ADMIN_USER):
        resp = client.get("/api/v1/teams/1/join-applications?status=bogus")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_STATUS"
    assert conn.calls == []


# ════════════════════════════════════════════════════════════════════════════
# 4. 审核通过
# ════════════════════════════════════════════════════════════════════════════

def test_approve_joins_applicant_and_marks_approved():
    conn = _FakeConn(
        fetchrow=[_team_row(),                                   # team_or_404
                  _application_row(),                            # 申请行 FOR UPDATE
                  {"id": 9, "team_id": None},                    # 申请人
                  _application_row(status="approved", reviewed_by=3)],  # UPDATE RETURNING
        fetchval=[5],                                            # member_count
    )
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/approve")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] is True
    assert body["member_count"] == 5
    assert body["application"]["status"] == "approved"
    # 入团与状态落库都发生
    assert any("UPDATE users SET team_id=" in sql for sql, _ in conn.executed)
    assert "status='approved'" in conn.sql()
    assert "FOR UPDATE" in conn.sql()          # 并发保护


def test_approve_twice_409():
    conn = _FakeConn(fetchrow=[_team_row(), _application_row(status="approved")])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/approve")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "APPLICATION_ALREADY_REVIEWED"


def test_approve_when_applicant_already_in_team_409():
    conn = _FakeConn(fetchrow=[_team_row(), _application_row(),
                               {"id": 9, "team_id": 7}])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/approve")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ALREADY_IN_TEAM"
    assert not any("UPDATE users SET team_id=" in sql for sql, _ in conn.executed)


def test_approve_application_of_other_team_404():
    conn = _FakeConn(fetchrow=[_team_row(), _application_row(team_id=2)])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/approve")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "APPLICATION_NOT_FOUND"


def test_approve_non_admin_403():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/approve")
    assert resp.status_code == 403


# ════════════════════════════════════════════════════════════════════════════
# 5. 驳回
# ════════════════════════════════════════════════════════════════════════════

def test_reject_writes_reason():
    conn = _FakeConn(
        fetchrow=[_team_row(), _application_row(),
                  _application_row(status="rejected", reject_reason="请用公司邮箱", reviewed_by=3)],
    )
    with _patched(conn, ADMIN_USER):
        resp = client.post(
            "/api/v1/teams/1/join-applications/11/reject",
            json={"reason": " 请用公司邮箱 "},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] is True
    assert body["application"]["status"] == "rejected"
    assert body["application"]["reject_reason"] == "请用公司邮箱"
    assert "status='rejected'" in conn.sql()


def test_reject_reason_too_long_422():
    conn = _FakeConn()
    with _patched(conn, ADMIN_USER):
        resp = client.post(
            "/api/v1/teams/1/join-applications/11/reject",
            json={"reason": "长" * 201},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "REJECT_REASON_TOO_LONG"


def test_reject_without_reason_ok():
    conn = _FakeConn(
        fetchrow=[_team_row(), _application_row(), _application_row(status="rejected")],
    )
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/join-applications/11/reject", json={})
    assert resp.status_code == 200
    assert resp.json()["application"]["reject_reason"] is None


# ════════════════════════════════════════════════════════════════════════════
# 6. 申请人撤回
# ════════════════════════════════════════════════════════════════════════════

def test_cancel_by_owner():
    conn = _FakeConn(
        fetchrow=[_application_row(), _application_row(status="canceled")],
        fetchval=["联佳"],
    )
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/join-applications/11/cancel")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["canceled"] is True
    assert body["application"]["status"] == "canceled"
    assert body["application"]["team_name"] == "联佳"


def test_cancel_by_other_user_404():
    conn = _FakeConn(fetchrow=[_application_row(user_id=42)])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/join-applications/11/cancel")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "APPLICATION_NOT_FOUND"


def test_cancel_non_pending_409():
    conn = _FakeConn(fetchrow=[_application_row(status="approved")])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/join-applications/11/cancel")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "APPLICATION_ALREADY_REVIEWED"


# ════════════════════════════════════════════════════════════════════════════
# 7. 我的最近一条申请
# ════════════════════════════════════════════════════════════════════════════

def test_my_join_application_returns_latest_with_team_name():
    conn = _FakeConn(fetchrow=[_application_row(team_name="联佳")])
    with _patched(conn, MEMBER_USER):
        resp = client.get("/api/v1/me/join-application")
    assert resp.status_code == 200
    app = resp.json()["application"]
    assert app["team_name"] == "联佳"
    assert app["status"] == "pending"


def test_my_join_application_null_when_none():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, MEMBER_USER):
        resp = client.get("/api/v1/me/join-application")
    assert resp.json() == {"application": None}
