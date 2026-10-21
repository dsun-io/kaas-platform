"""团队（三层组织）API 的 Worker 行为测试（无数据库、无网络）。

覆盖：建团队成为管理员、一人一团队、邀请码加入的四态（无效/撤销/已用/过期）、
邮箱点名邀请（已注册直接入队 / 未注册发码）、管理权限、不能移除管理员自己。

做法同 `test_four_domains.py`：把 `_acquire` 换成假连接、`_get_current_user`
换成依赖覆盖，不碰 Hyperdrive 也能把 handler 跑到返回。
"""
import os
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_teams  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.workstation.subscriptions import all_workstations  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

# u3 = 联佳账号（团队管理员）；u9 = 尚未加入任何团队的普通成员
ADMIN_USER = {"id": 3, "email": "lianjia@kaas.local", "display_name": "联佳",
              "account_type": "customer", "role": "owner", "team_id": 1}
MEMBER_USER = {"id": 9, "email": "newbie@kaas.local", "display_name": "新人",
               "account_type": "customer", "role": "user", "team_id": None}
PLATFORM_ADMIN = {"id": 1, "email": "admin@kaas.dev", "display_name": "平台管理员",
                  "account_type": "internal", "role": "system_admin", "team_id": None}


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按调用顺序吐预设结果；fetchrow/fetchval 都可给列表或单值。"""

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
        """本次请求执行过的**全部** SQL（含 fetchval/fetchrow 里的写语句）。"""
        return "\n".join(s for s, _ in self.calls)


@contextmanager
def _patched(conn, user):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old_acquire = ws_teams._acquire
    ws_teams._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        ws_teams._acquire = old_acquire
        worker_main.app.dependency_overrides.clear()


def _team_row(**over):
    row = {"id": 1, "tenant_id": "default", "name": "安平县联佳丝网制品有限公司",
           "created_by": 3, "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc),
           "updated_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


def _invite_row(**over):
    row = {"id": 7, "tenant_id": "default", "team_id": 1, "email": None, "token": "TOK123",
           "invited_by": 3, "status": "pending",
           "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
           "accepted_at": None, "accepted_by": None,
           "created_at": datetime(2026, 10, 11, tzinfo=timezone.utc)}
    row.update(over)
    return row


# ── 建团队 ──────────────────────────────────────────────────────────────────

def test_create_team_makes_creator_admin_and_joins():
    conn = _FakeConn(fetchval=[None],                       # 同名检查：没有
                     fetchrow=[_team_row(created_by=9)])    # INSERT RETURNING（创建者=我）
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={"name": "  安平县联佳丝网制品有限公司  "})
    assert resp.status_code == 201
    body = resp.json()
    assert body["is_admin"] is True and body["member_count"] == 1
    # 创建者自己入队 —— 没有这一步就会出现"建了团队但看不到自己的数据"
    assert "UPDATE users SET team_id=" in conn.sql()


def test_create_team_rejects_when_already_in_team():
    conn = _FakeConn()
    with _patched(conn, ADMIN_USER):        # ADMIN_USER 已有 team_id=1
        resp = client.post("/api/v1/teams", json={"name": "第二团队"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ALREADY_IN_TEAM"
    assert conn.executed == []              # 不查库也不写库


def test_create_team_rejects_blank_name():
    conn = _FakeConn()
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={"name": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_TEAM_NAME"


def test_create_team_rejects_duplicate_name():
    conn = _FakeConn(fetchval=[1])          # 同名检查：已存在
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={"name": "安平县联佳丝网制品有限公司"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "TEAM_NAME_TAKEN"


# ── 我的团队 ────────────────────────────────────────────────────────────────

def test_my_team_empty_when_not_joined():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, MEMBER_USER):
        resp = client.get("/api/v1/teams/me")
    assert resp.status_code == 200
    assert resp.json() == {"team": None, "is_admin": False, "member_count": 0}


def test_my_team_reports_admin_flag():
    conn = _FakeConn(fetchrow=[_team_row()], fetchval=[4])
    with _patched(conn, ADMIN_USER):
        resp = client.get("/api/v1/teams/me")
    body = resp.json()
    assert body["team"]["name"] == "安平县联佳丝网制品有限公司"
    assert body["is_admin"] is True and body["member_count"] == 4


# ── 管理权限 ────────────────────────────────────────────────────────────────

def test_non_admin_cannot_rename_team():
    """团队管理员才能管本团队：别人（非平台管理员）→ 403。"""
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)])
    with _patched(conn, MEMBER_USER):       # id=9，不是创建者
        resp = client.patch("/api/v1/teams/1", json={"name": "改个名"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_TEAM_ADMIN"


def test_platform_admin_can_manage_any_team():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3), _team_row(name="新名字")],
                     fetchval=[None, 4])
    with _patched(conn, PLATFORM_ADMIN):
        resp = client.patch("/api/v1/teams/1", json={"name": "新名字"})
    assert resp.status_code == 200
    assert resp.json()["name"] == "新名字"


def test_cannot_remove_team_admin_self():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)])
    with _patched(conn, ADMIN_USER):
        resp = client.delete("/api/v1/teams/1/members/3")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "CANNOT_REMOVE_SELF"


def test_remove_member_clears_team():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)], fetchval=[9])
    with _patched(conn, ADMIN_USER):
        resp = client.delete("/api/v1/teams/1/members/9")
    assert resp.status_code == 200 and resp.json()["removed"] is True
    assert "SET team_id=NULL" in conn.sql()


# ── 邀请 ────────────────────────────────────────────────────────────────────

def test_invite_unregistered_email_returns_token():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3),      # 团队
                               None,                          # 邮箱未注册
                               _invite_row(email="tim@buyer.com")])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/invites", json={"email": "Tim@Buyer.com"})
    assert resp.status_code == 201                            # 发码 = 新建了邀请资源
    body = resp.json()
    assert body["joined"] is False and body["token"] == "TOK123"
    assert body["email"] == "tim@buyer.com"                  # 邮箱统一小写


def test_invite_registered_email_joins_directly():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3), {"id": 9, "team_id": None}])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/invites", json={"email": "newbie@kaas.local"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["joined"] is True and body["user_id"] == 9
    assert "UPDATE users SET team_id=" in conn.sql()


def test_invite_registered_email_already_in_team_409():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3), {"id": 9, "team_id": 5}])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/invites", json={"email": "newbie@kaas.local"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ALREADY_IN_TEAM"


def test_generic_invite_without_email():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3), _invite_row(email=None)])
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/1/invites", json={})
    assert resp.status_code == 201
    assert resp.json()["email"] is None and resp.json()["token"] == "TOK123"


def test_revoke_invite():
    conn = _FakeConn(fetchrow=[_team_row(created_by=3)], fetchval=[7])
    with _patched(conn, ADMIN_USER):
        resp = client.delete("/api/v1/teams/1/invites/7")
    assert resp.status_code == 200 and resp.json() == {"revoked": True, "id": 7}


# ── 凭邀请码加入 ────────────────────────────────────────────────────────────

def test_join_success_sets_team_and_marks_invite_used():
    conn = _FakeConn(fetchrow=[_invite_row(token="TOK123"), _team_row()], fetchval=[2])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams/join", json={"token": "  TOK123  "})
    assert resp.status_code == 200
    assert resp.json()["joined"] is True
    sql = conn.sql()
    assert "UPDATE users SET team_id=" in sql
    assert "status='accepted'" in sql


def test_join_accepts_full_url_token():
    """用户常常把整条邀请链接粘进来 —— normalize_invite_token 要能取出 token。"""
    conn = _FakeConn(fetchrow=[_invite_row(token="TOK123"), _team_row()], fetchval=[2])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams/join",
                           json={"token": "https://kaas.powervoy.com/join?token=TOK123"})
    assert resp.status_code == 200


def test_join_rejects_unknown_token():
    conn = _FakeConn(fetchrow=[None])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams/join", json={"token": "NOPE"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "INVITE_NOT_FOUND"


def test_join_rejects_revoked_and_used_and_expired():
    cases = [("revoked", 410, "INVITE_REVOKED"),
             ("accepted", 409, "INVITE_ALREADY_USED")]
    for status, expected, code in cases:
        conn = _FakeConn(fetchrow=[_invite_row(status=status)])
        with _patched(conn, MEMBER_USER):
            resp = client.post("/api/v1/teams/join", json={"token": "TOK123"})
        assert resp.status_code == expected, status
        assert resp.json()["detail"]["code"] == code

    expired = _invite_row(expires_at=datetime.now(timezone.utc) - timedelta(days=1))
    conn = _FakeConn(fetchrow=[expired])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams/join", json={"token": "TOK123"})
    assert resp.status_code == 410
    assert resp.json()["detail"]["code"] == "INVITE_EXPIRED"


def test_join_rejected_when_already_in_team():
    conn = _FakeConn()
    with _patched(conn, ADMIN_USER):
        resp = client.post("/api/v1/teams/join", json={"token": "TOK123"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ALREADY_IN_TEAM"
    assert conn.executed == []


# ── 注册：团队选择 ──────────────────────────────────────────────────────────

def _register_body(**over):
    body = {"email": "tim@buyer.com", "password": "password123",
            "display_name": "Tim", "company_name": "Tim Trading",
            "product_category": "fencing"}
    body.update(over)
    return body


def test_register_rejects_both_team_actions():
    resp = client.post("/api/v1/auth/register",
                       json=_register_body(invite_token="T", team_name="X"))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "TEAM_ACTION_CONFLICT"


def test_register_validates_payload_without_touching_db():
    resp = client.post("/api/v1/auth/register", json=_register_body(password="short"))
    assert resp.status_code == 422
    resp = client.post("/api/v1/auth/register", json=_register_body(product_category="nope"))
    assert resp.status_code == 422
    resp = client.post("/api/v1/auth/register", json=_register_body(email="not-an-email"))
    assert resp.status_code == 422


def _user_row(**over):
    row = {"id": 42, "email": "tim@buyer.com", "display_name": "Tim",
           "account_type": "customer", "role": "owner", "status": "active"}
    row.update(over)
    return row


@contextmanager
def _jwt_env():
    """register 成功路径会签 token：测试进程内给 JWT_SECRET 兜底（os.environ 优先级）。"""
    old = os.environ.get("JWT_SECRET")
    os.environ["JWT_SECRET"] = "test-jwt-secret"
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("JWT_SECRET", None)
        else:
            os.environ["JWT_SECRET"] = old


@contextmanager
def _patched_main_acquire(conn):
    """register 定义在 main 模块，用的是 main 自己的 `_acquire`（与 ws_teams 那份不同名）。"""
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = worker_main._acquire
    worker_main._acquire = fake_acquire
    try:
        yield conn
    finally:
        worker_main._acquire = old


def test_register_success_sql_includes_is_tenant_admin():
    """回归（2026-10-19 生产 500）：生产 users.is_tenant_admin 是 NOT NULL **且无库默认值**，
    INSERT 缺列 → `null value in column "is_tenant_admin"` → 500（浏览器侧被 CORS 掩盖）。
    锁死：注册/初始化的 users INSERT 必须显式给该列。"""
    conn = _FakeConn(fetchval=[None, None],
                     fetchrow=[_user_row(), {"id": 7, "name": "Tim 团队"}])
    with _patched_main_acquire(conn), _jwt_env():
        resp = client.post("/api/v1/auth/register",
                           json=_register_body(team_name="Tim 团队"))
    assert resp.status_code == 200, resp.text
    insert_users = [s for s, _ in conn.calls if s.lstrip().startswith("INSERT INTO users")]
    assert insert_users, "注册没有执行 users INSERT？"
    assert all("is_tenant_admin" in s for s in insert_users)


def test_register_without_company_name_and_team_is_fine():
    """company_name 自 2026-10-19 起可选（注册页删了公司名输入框）；
    不传任何团队动作 = 真·无团队 —— 回归旧代码用 company_name 兜底建团队的口径漂移。"""
    body = _register_body()
    body.pop("company_name")
    conn = _FakeConn(fetchval=[None], fetchrow=[_user_row()])
    with _patched_main_acquire(conn), _jwt_env():
        resp = client.post("/api/v1/auth/register", json=body)
    assert resp.status_code == 200, resp.text
    assert resp.json()["team_id"] is None
    assert "INSERT INTO teams" not in conn.sql()

# ── 建团队时勾选工位（当前阶段全部免费）────────────────────────────────────

def test_create_team_opens_chosen_workstations():
    conn = _FakeConn(fetchval=[None], fetchrow=[_team_row(created_by=9)])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={
            "name": "安平县联佳丝网制品有限公司",
            "workstations": ["customers", "orders"]})
    assert resp.status_code == 201
    assert resp.json()["workstations"] == ["customers", "orders"]
    subs = [(sql, args) for sql, args in conn.calls if "INSERT INTO team_subscriptions" in sql]
    assert len(subs) == 2
    assert {a[1] for _, a in subs} == {"customers", "orders"}
    assert all("'signup'" in sql for sql, _ in subs)   # 免费阶段：直接 active


def test_create_team_without_selection_opens_all():
    """不传勾选 = 默认开通全部工位，免得新团队"什么都用不了"。"""
    conn = _FakeConn(fetchval=[None], fetchrow=[_team_row(created_by=9)])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={"name": "联佳团队"})
    assert resp.status_code == 201
    assert set(resp.json()["workstations"]) == set(all_workstations())


def test_create_team_rejects_unknown_workstation():
    conn = _FakeConn(fetchval=[None], fetchrow=[_team_row(created_by=9)])
    with _patched(conn, MEMBER_USER):
        resp = client.post("/api/v1/teams", json={"name": "X", "workstations": ["nope"]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "UNKNOWN_WORKSTATION"


# ── 全量团队列表（管理端 /admin/teams） ─────────────────────────────────────

_TEAM_ITEM_KEYS = {"id", "name", "created_by", "created_by_email", "created_by_name",
                   "member_count", "workstation_count", "workstation_codes", "created_at"}


def _team_list_row(**over):
    """全量列表的单行 —— 与 SQL 的列别名一一对应（含聚合结果）。"""
    row = {"id": 1, "name": "系统管理员团队", "created_by": 4,
           "created_by_email": "david@powervoy.com",
           "created_by_name": "David / 系统管理员",
           "member_count": 1, "workstation_count": 0, "workstation_codes": [],
           "created_at": datetime(2026, 10, 21, 1, 23, 45, tzinfo=timezone.utc)}
    row.update(over)
    return row


def test_list_teams_requires_token():
    """无 token → 401（由 _get_current_user 拦截，不查库）。"""
    resp = client.get("/api/v1/teams")
    assert resp.status_code == 401


def test_list_teams_forbidden_for_member():
    """普通成员 → 403 ADMIN_ONLY，且 handler 不触达数据库。"""
    conn = _FakeConn(fetch=[[_team_list_row()]])
    with _patched(conn, MEMBER_USER):
        resp = client.get("/api/v1/teams")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "ADMIN_ONLY"
    assert resp.json()["detail"]["error"] == "forbidden"
    assert conn.calls == []                 # 鉴权失败在 _acquire 之前返回


def test_list_teams_forbidden_for_customer_with_admin_role():
    """customer 账号即使被写入 system_admin 角色也不放行。

    与 `main._require_platform_ops` 同口径（internal + 管理员角色）：
    前端 /admin/teams 的 RouteGuard 用 isPlatformOperator 判定，后端必须一致，
    否则"角色提权"就能越权读全量团队。
    """
    impostor = {"id": 10, "email": "impostor@buyer.com", "display_name": "冒充者",
                "account_type": "customer", "role": "system_admin", "team_id": None}
    conn = _FakeConn(fetch=[[_team_list_row()]])
    with _patched(conn, impostor):
        resp = client.get("/api/v1/teams")
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "ADMIN_ONLY"
    assert conn.calls == []                 # 鉴权失败在 _acquire 之前返回


def test_list_teams_returns_all_fields_for_admin():
    row_old = _team_list_row(
        id=2, name="安平县联佳丝网制品有限公司", created_by=3,
        created_by_email="lianjia@kaas.local", created_by_name="联佳",
        member_count=4, workstation_count=2,
        workstation_codes=["customers", "orders"],
        created_at=datetime(2026, 10, 11, 8, 0, 0, tzinfo=timezone.utc))
    row_empty = _team_list_row()            # 无 active 订阅、1 个成员的团队
    conn = _FakeConn(fetch=[[row_old, row_empty]])
    with _patched(conn, PLATFORM_ADMIN):
        resp = client.get("/api/v1/teams")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2 and len(body["items"]) == 2
    assert conn.calls[0][1] == ("default",)   # 只查 DEFAULT_TENANT

    for item in body["items"]:
        assert set(item.keys()) == _TEAM_ITEM_KEYS
    # 顺序按 SQL 的 ORDER BY created_at, id 原样透出
    assert [i["id"] for i in body["items"]] == [2, 1]

    old, empty = body["items"]
    assert old["name"] == "安平县联佳丝网制品有限公司"
    assert old["created_by"] == 3
    assert old["created_by_email"] == "lianjia@kaas.local"
    assert old["created_by_name"] == "联佳"
    assert old["member_count"] == 4
    assert old["workstation_count"] == 2
    assert old["workstation_codes"] == ["customers", "orders"]
    assert old["created_at"] == "2026-10-11T08:00:00+00:00"

    assert empty["member_count"] == 1 and empty["workstation_count"] == 0
    assert empty["workstation_codes"] == []
    assert empty["created_at"] == "2026-10-21T01:23:45+00:00"

    sql = conn.sql()
    assert "t.tenant_id = $1" in sql
    assert "ORDER BY t.created_at, t.id" in sql
    assert "LEFT JOIN team_subscriptions ts" in sql
    assert "array_agg(ts.code ORDER BY ts.code)" in sql
    assert len(conn.calls) == 1             # 单条聚合查询：不再逐团队补查


def test_list_teams_counts_only_active_subscriptions():
    """非 active 的订阅不计入 count / codes（SQL 层只 JOIN active，聚合行透出）。"""
    conn = _FakeConn(fetch=[[_team_list_row(
        workstation_count=0, workstation_codes=[])]])
    with _patched(conn, PLATFORM_ADMIN):
        resp = client.get("/api/v1/teams")
    assert resp.status_code == 200
    item = resp.json()["items"][0]
    assert item["workstation_count"] == 0
    assert item["workstation_codes"] == []
    sql = conn.sql()
    # 语义锁死：LEFT JOIN 条件里带 active，聚合只取非空 code
    assert "ON ts.team_id = t.id AND ts.active" in sql
    assert "FILTER (WHERE ts.code IS NOT NULL)" in sql
