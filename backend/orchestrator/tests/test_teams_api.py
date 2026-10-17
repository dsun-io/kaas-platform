"""团队（三层组织）管理 API 的接口测试（orchestrator 端，需要 PostgreSQL）。

覆盖（与生产 Worker 的 `backend/worker/tests/test_teams_api.py` 同口径）：
- 建团队：创建者即团队管理员并自动入队；一人一团队；名称规范化；同租户重名
- 我的团队：未入队 → team=null；管理员标记与成员数
- 管理权限：团队管理员 / 平台管理员可管，其他人 403；跨团队 404
- 成员：列表（is_admin 指"本团队管理员"）、移除、不能移除团队管理员本人
- 邀请：通用码 / 邮箱点名（已注册直入、未注册发码、已有团队 409）、列表、撤销
- 凭码加入：四态（无效 404 / 撤销 410 / 已用 409 / 过期 410）+ 整条链接可粘贴
- 注册扩展：invite_token / team_name / 两者同给 422；码无效时整个注册不落库

做法同 `test_trade_docs_api.py`：patch `AuthContextMiddleware.dispatch` 注入 AuthContext、
用 `client` fixture（DB 依赖已被 conftest 覆盖成同一会话），因此断言能看到端点写的行。
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.auth import AuthContext
from app.db.models import Customer, Team, TeamInvite, User, UserCustomer
from app.main import app
from app.middleware.auth import AuthContextMiddleware
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db

# 测试统一用一个"自造"租户：团队按租户隔离，混用默认租户会让断言受种子数据影响
TENANT = "qa_teams"


# ── 认证/数据辅助 ────────────────────────────────────────────────────────────

@pytest.fixture
def as_user(monkeypatch):
    """切换"当前登录用户"。

    端点全程只读 `request.state.auth`（`Depends(get_auth_context)`），所以注入
    一个 AuthContext 就能以任意用户身份调接口，不必真的走登录。
    """

    def _install(user_id: int, role: str = "user", tenant_id: str = TENANT):
        async def _dispatch(self, request, call_next):
            path = request.url.path
            if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
                return await call_next(request)
            # 既注入 auth，也注入 tenant_id：否则 TenantContextMiddleware 会因
            # "customer 账号 + 无 X-Tenant-Id" 直接 401（与 conftest 的 customer 分支同做法）
            request.state.tenant_id = tenant_id
            request.state.auth = AuthContext(
                user_id=user_id, account_type="customer", role=role, tenant_id=tenant_id)
            return await call_next(request)

        monkeypatch.setattr(AuthContextMiddleware, "dispatch", _dispatch)
        # dispatch 被替换后必须让 middleware stack 重建，否则仍跑旧绑定
        app.middleware_stack = None

    return _install


def _email(tag: str) -> str:
    """每个用例用独立邮箱：并发/复用测试库时不会互相撞唯一约束。"""
    return f"{tag}-{uuid.uuid4().hex[:8]}@qa.test"


def _code(resp) -> str:
    return resp.json()["detail"]["code"]


async def _mk_user(db, tag: str, *, role: str = "user", team_id=None,
                   display_name: str | None = None) -> User:
    """直接落一个 users 行（团队用 API 建，用户用这里造）。"""
    user = User(
        email=_email(tag), password_hash="x",
        display_name=display_name or tag,
        account_type="customer", role=role, plan="free", status="active",
        team_id=team_id,
    )
    db.add(user)
    await db.flush()
    return user


async def _team_id_of(db, user_id: int):
    """从库里重新读 team_id（绕开 identity map，确保断言看到的是落库结果）。"""
    return (await db.execute(
        select(User.team_id).where(User.id == user_id)
    )).scalar_one()


async def _mk_team(client, as_user, db, *, name: str = "联佳丝网", tag: str = "boss"):
    """建一个团队：返回 (创建者, team_id)。创建者即团队管理员。"""
    admin = await _mk_user(db, tag, role="owner")
    as_user(admin.id, role="owner")
    resp = await client.post("/api/v1/teams", json={"name": name})
    assert resp.status_code == 201, resp.text
    return admin, resp.json()["id"]


async def _mk_invite(client, as_user, team_id: int, *, email: str | None = None):
    """以团队管理员身份发一张邀请。"""
    resp = await client.post(f"/api/v1/teams/{team_id}/invites", json={"email": email})
    assert resp.status_code == 201, resp.text
    return resp.json()


def _register_body(**over) -> dict:
    # 公司名也带随机后缀：回滚用例靠它断言"这个客户一行都没建"，
    # 名字重复会让人怀疑是别人建的那一行。
    body = {
        "email": _email("newbie"), "password": "password123",
        "display_name": "新人", "company_name": f"新人贸易-{uuid.uuid4().hex[:8]}",
        "product_category": "fencing",
    }
    body.update(over)
    return body


# ── 建团队 ──────────────────────────────────────────────────────────────────

class TestCreateTeam:
    async def test_creator_becomes_admin_and_joins(self, client, db_session, as_user):
        """建团队 + 入队在同一事务：创建者是团队管理员，member_count=1。"""
        boss = await _mk_user(db_session, "boss", role="owner")
        as_user(boss.id, role="owner")

        resp = await client.post("/api/v1/teams", json={"name": "  安平县  联佳丝网  "})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["name"] == "安平县 联佳丝网"      # 内核规范化：去首尾 + 折叠内部空白
        assert body["created_by"] == boss.id
        assert body["is_admin"] is True
        assert body["member_count"] == 1
        assert await _team_id_of(db_session, boss.id) == body["id"]

        team = (await db_session.execute(
            select(Team).where(Team.id == body["id"]))).scalar_one()
        assert team.tenant_id == TENANT

    async def test_already_in_team_rejected(self, client, db_session, as_user):
        """一人一团队：已有团队不能再建（409 ALREADY_IN_TEAM）。"""
        admin, _ = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.post("/api/v1/teams", json={"name": "第二个团队"})
        assert resp.status_code == 409
        assert _code(resp) == "ALREADY_IN_TEAM"

    async def test_blank_name_rejected(self, client, db_session, as_user):
        """空白名称 → 422，且一行都不写。"""
        user = await _mk_user(db_session, "blank", role="owner")
        as_user(user.id, role="owner")
        resp = await client.post("/api/v1/teams", json={"name": "   "})
        assert resp.status_code == 422
        assert _code(resp) == "INVALID_TEAM_NAME"
        assert (await db_session.execute(
            select(Team).where(Team.tenant_id == TENANT))).first() is None

    async def test_duplicate_name_rejected(self, client, db_session, as_user):
        """同租户同名 → 409 TEAM_NAME_TAKEN。"""
        await _mk_team(client, as_user, db_session, name="重名团队", tag="first")
        second = await _mk_user(db_session, "second", role="owner")
        as_user(second.id, role="owner")
        resp = await client.post("/api/v1/teams", json={"name": "重名团队"})
        assert resp.status_code == 409
        assert _code(resp) == "TEAM_NAME_TAKEN"


# ── 我的团队 ────────────────────────────────────────────────────────────────

class TestMyTeam:
    async def test_empty_when_not_joined(self, client, db_session, as_user):
        user = await _mk_user(db_session, "solo")
        as_user(user.id)
        resp = await client.get("/api/v1/teams/me")
        assert resp.status_code == 200
        assert resp.json() == {"team": None, "is_admin": False, "member_count": 0}

    async def test_reports_team_admin_flag_and_count(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        await _mk_user(db_session, "mate", team_id=team_id)

        as_user(admin.id, role="owner")
        body = (await client.get("/api/v1/teams/me")).json()
        assert body["team"]["id"] == team_id
        assert body["team"]["name"] == "联佳丝网"
        assert body["is_admin"] is True
        assert body["member_count"] == 2


# ── 管理权限（改名） ────────────────────────────────────────────────────────

class TestUpdateTeam:
    async def test_admin_renames(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "新名字"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "新名字"
        assert resp.json()["is_admin"] is True

    async def test_member_cannot_rename(self, client, db_session, as_user):
        """团队成员 ≠ 团队管理员：非创建者改名 403 NOT_TEAM_ADMIN。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(mate.id, role="user")
        resp = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "我要改名"})
        assert resp.status_code == 403
        assert _code(resp) == "NOT_TEAM_ADMIN"

    async def test_platform_admin_can_manage_any_team(self, client, db_session, as_user):
        """平台管理员（system_admin）兜底：能管任意团队。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        resp = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "运维改名"})
        assert resp.status_code == 200, resp.text
        assert resp.json()["name"] == "运维改名"

    async def test_unknown_team_404(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        resp = await client.patch("/api/v1/teams/999999", json={"name": "不存在"})
        assert resp.status_code == 404
        assert _code(resp) == "TEAM_NOT_FOUND"

    async def test_duplicate_name_rejected(self, client, db_session, as_user):
        await _mk_team(client, as_user, db_session, name="甲团队", tag="jia")
        other, team_id = await _mk_team(client, as_user, db_session, name="乙团队", tag="yi")
        as_user(other.id, role="owner")
        resp = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "甲团队"})
        assert resp.status_code == 409
        assert _code(resp) == "TEAM_NAME_TAKEN"


# ── 成员 ────────────────────────────────────────────────────────────────────

class TestMembers:
    async def test_list_members_admin_only_with_flags(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)

        as_user(mate.id, role="user")
        assert (await client.get(f"/api/v1/teams/{team_id}/members")).status_code == 403

        as_user(admin.id, role="owner")
        resp = await client.get(f"/api/v1/teams/{team_id}/members")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 2
        by_id = {row["user_id"]: row for row in body["items"]}
        assert by_id[admin.id]["is_admin"] is True          # 团队管理员
        assert by_id[mate.id]["is_admin"] is False
        assert by_id[mate.id]["email"] == mate.email
        assert by_id[mate.id]["role"] == "user"

    async def test_remove_member_clears_team(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(admin.id, role="owner")

        resp = await client.delete(f"/api/v1/teams/{team_id}/members/{mate.id}")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"removed": True, "user_id": mate.id}
        assert await _team_id_of(db_session, mate.id) is None

    async def test_cannot_remove_team_admin(self, client, db_session, as_user):
        """不能移除团队管理员本人：否则团队没人能管理。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.delete(f"/api/v1/teams/{team_id}/members/{admin.id}")
        assert resp.status_code == 409
        assert _code(resp) == "CANNOT_REMOVE_SELF"

    async def test_remove_non_member_404(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        stranger = await _mk_user(db_session, "stranger")
        as_user(admin.id, role="owner")
        resp = await client.delete(f"/api/v1/teams/{team_id}/members/{stranger.id}")
        assert resp.status_code == 404
        assert _code(resp) == "MEMBER_NOT_FOUND"


# ── 邀请 ────────────────────────────────────────────────────────────────────

class TestInvites:
    async def test_generic_invite_creates_token(self, client, db_session, as_user):
        """email 留空 → 通用邀请码：201 + 14 天有效期。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")

        resp = await client.post(f"/api/v1/teams/{team_id}/invites", json={})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["joined"] is False
        assert body["email"] is None
        assert isinstance(body["invite_id"], int)
        assert len(body["token"]) == 24

        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == body["invite_id"]))).scalar_one()
        assert row.tenant_id == TENANT
        assert row.team_id == team_id
        assert row.status == "pending"
        assert row.invited_by == admin.id
        # 有效期 = now + INVITE_TTL_DAYS(14) 天，允许 5 分钟误差
        delta = row.expires_at - datetime.now(timezone.utc)
        assert timedelta(days=13, hours=23) < delta < timedelta(days=14, minutes=5)

    async def test_invite_unregistered_email_returns_token(self, client, db_session, as_user):
        """邮箱未注册 → 发码，邮箱统一小写。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")

        resp = await client.post(f"/api/v1/teams/{team_id}/invites",
                                 json={"email": "  Tim@Buyer.com "})
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["joined"] is False
        assert body["email"] == "tim@buyer.com"
        assert body["token"]

    async def test_invite_registered_email_joins_directly(self, client, db_session, as_user):
        """邮箱已注册且无团队 → 直接入队（200，不产生邀请行）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate")
        as_user(admin.id, role="owner")

        resp = await client.post(f"/api/v1/teams/{team_id}/invites",
                                 json={"email": mate.email})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"joined": True, "user_id": mate.id, "email": mate.email}
        assert await _team_id_of(db_session, mate.id) == team_id
        assert (await db_session.execute(
            select(TeamInvite).where(TeamInvite.team_id == team_id))).first() is None

    async def test_invite_registered_email_already_in_team(self, client, db_session, as_user):
        """对方已有团队 → 409 ALREADY_IN_TEAM（不能抢人）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        _, other_team_id = await _mk_team(client, as_user, db_session,
                                         name="别的团队", tag="other")
        taken = await _mk_user(db_session, "taken", team_id=other_team_id)
        as_user(admin.id, role="owner")

        resp = await client.post(f"/api/v1/teams/{team_id}/invites",
                                 json={"email": taken.email})
        assert resp.status_code == 409
        assert _code(resp) == "ALREADY_IN_TEAM"

    async def test_list_invites_admin_only_newest_first(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)

        as_user(mate.id, role="user")
        assert (await client.get(f"/api/v1/teams/{team_id}/invites")).status_code == 403

        as_user(admin.id, role="owner")
        first = await _mk_invite(client, as_user, team_id)
        second = await _mk_invite(client, as_user, team_id, email="tim@buyer.com")

        resp = await client.get(f"/api/v1/teams/{team_id}/invites")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 2
        assert [row["id"] for row in body["items"]] == [second["invite_id"], first["invite_id"]]
        row = body["items"][0]
        assert row["token"] == second["token"]
        assert row["status"] == "pending"
        assert row["email"] == "tim@buyer.com"
        assert row["accepted_at"] is None and row["accepted_by"] is None
        assert row["created_at"] and row["expires_at"]

    async def test_revoke_invite(self, client, db_session, as_user):
        """撤销 → status='revoked'，此后不能再用（410）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)

        resp = await client.delete(
            f"/api/v1/teams/{team_id}/invites/{invite['invite_id']}")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"revoked": True, "id": invite["invite_id"]}

        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == invite["invite_id"]))).scalar_one()
        assert row.status == "revoked"

        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        join = await client.post("/api/v1/teams/join", json={"token": invite["token"]})
        assert join.status_code == 410
        assert _code(join) == "INVITE_REVOKED"

    async def test_revoke_unknown_invite_404(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.delete(f"/api/v1/teams/{team_id}/invites/999999")
        assert resp.status_code == 404
        assert _code(resp) == "INVITE_NOT_FOUND"


# ── 凭邀请码加入 ────────────────────────────────────────────────────────────

class TestJoin:
    async def test_join_sets_team_and_marks_invite_used(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)

        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        resp = await client.post("/api/v1/teams/join",
                                 json={"token": f"  {invite['token']}  "})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["joined"] is True
        assert body["team"]["id"] == team_id
        assert body["team"]["is_admin"] is False

        assert await _team_id_of(db_session, newbie.id) == team_id
        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == invite["invite_id"]))).scalar_one()
        assert row.status == "accepted"
        assert row.accepted_by == newbie.id
        assert row.accepted_at is not None

    async def test_join_accepts_full_invite_url(self, client, db_session, as_user):
        """用户常把整条链接粘进来 —— 内核 normalize_invite_token 负责取出 token。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)
        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        resp = await client.post("/api/v1/teams/join", json={
            "token": f"https://kaas.example.com/join?token={invite['token']}"})
        assert resp.status_code == 200, resp.text

    async def test_join_unknown_token_404(self, client, db_session, as_user):
        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        resp = await client.post("/api/v1/teams/join", json={"token": "NOPE-NOPE"})
        assert resp.status_code == 404
        assert _code(resp) == "INVITE_NOT_FOUND"

    async def test_join_empty_token_422(self, client, db_session, as_user):
        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        resp = await client.post("/api/v1/teams/join", json={"token": "   "})
        assert resp.status_code == 422
        assert _code(resp) == "INVALID_INVITE_TOKEN"

    async def test_join_used_invite_409(self, client, db_session, as_user):
        """一个码只能用一次：第二个人拿到同一个码 → 409。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)

        first = await _mk_user(db_session, "first")
        as_user(first.id)
        assert (await client.post("/api/v1/teams/join",
                                  json={"token": invite["token"]})).status_code == 200

        second = await _mk_user(db_session, "second")
        as_user(second.id)
        resp = await client.post("/api/v1/teams/join", json={"token": invite["token"]})
        assert resp.status_code == 409
        assert _code(resp) == "INVITE_ALREADY_USED"

    async def test_join_expired_invite_410(self, client, db_session, as_user):
        _, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)

        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == invite["invite_id"]))).scalar_one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        await db_session.commit()

        newbie = await _mk_user(db_session, "newbie")
        as_user(newbie.id)
        resp = await client.post("/api/v1/teams/join", json={"token": invite["token"]})
        assert resp.status_code == 410
        assert _code(resp) == "INVITE_EXPIRED"

    async def test_join_rejected_when_already_in_team(self, client, db_session, as_user):
        admin, _ = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.post("/api/v1/teams/join", json={"token": "ANY"})
        assert resp.status_code == 409
        assert _code(resp) == "ALREADY_IN_TEAM"


# ── 注册时的团队选择 ────────────────────────────────────────────────────────

class TestRegisterTeamActions:
    """`POST /api/v1/auth/register` 的两个可选字段（公开路径，无需注入 auth）。"""

    async def test_plain_register_unchanged(self, client, db_session):
        """不带团队字段 → 与既有注册完全一致（仍是 customer/owner，不建团队）。"""
        body = _register_body()
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["email"] == body["email"]
        assert out["role"] == "owner"
        assert out["access_token"]

        user = (await db_session.execute(
            select(User).where(User.email == body["email"]))).scalar_one()
        assert user.team_id is None

    async def test_both_team_actions_rejected(self, client):
        resp = await client.post("/api/v1/auth/register",
                                 json=_register_body(invite_token="T", team_name="X"))
        assert resp.status_code == 422
        assert _code(resp) == "TEAM_ACTION_CONFLICT"

    async def test_register_with_team_name_creates_team(self, client, db_session):
        """team_name → 注册者成为团队管理员；注册**不再**创建客户行（拆分模型）。"""
        body = _register_body(team_name="  新人  团队 ")
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 200, resp.text
        out = resp.json()

        user = (await db_session.execute(
            select(User).where(User.email == body["email"]))).scalar_one()
        team = (await db_session.execute(
            select(Team).where(Team.id == user.team_id))).scalar_one()
        assert team.name == "新人 团队"          # 内核规范化
        assert team.created_by == user.id        # 创建者即团队管理员
        # 2026-10-11 裁决：注册不再新建租户，tenant 恒为 default（隔离靠团队）
        assert team.tenant_id == "default"
        assert user.role == "owner"

        # 拆分模型：响应体不再有 customer_*，公司身份由 team 承载
        assert out["team_id"] == team.id
        assert out["team_name"] == "新人 团队"
        assert "customer_id" not in out
        assert (await db_session.execute(
            select(Customer).where(Customer.name == body["company_name"]))).first() is None

    async def test_register_with_invite_token_joins(self, client, db_session, as_user):
        """invite_token → 注册者直接入队，邀请码同时被标记为已用。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)

        body = _register_body(invite_token=invite["token"])
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 200, resp.text
        out = resp.json()

        user = (await db_session.execute(
            select(User).where(User.email == body["email"]))).scalar_one()
        assert user.team_id == team_id
        assert user.role == "user"                # 加入者是普通成员，不是负责人

        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == invite["invite_id"]))).scalar_one()
        assert row.status == "accepted"
        assert row.accepted_by == user.id

        # 成员与团队必须同租户，否则成员建的记录和团队数据互相看不见（团队等于空壳）。
        # 注册只建账号 + 入队，**不再建客户行**（拆分模型），所以这里校验团队本身。
        team = (await db_session.execute(
            select(Team).where(Team.id == team_id))).scalar_one()
        assert team.tenant_id == TENANT
        assert out["team_id"] == team_id
        assert "customer_id" not in out

    async def test_register_with_bad_invite_token_writes_nothing(self, client, db_session):
        """码无效 → 404，且**整个注册不落库**（用户/客户/绑定一行都不留）。"""
        body = _register_body(invite_token="NOT-A-REAL-TOKEN")
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 404
        assert _code(resp) == "INVITE_NOT_FOUND"

        assert (await db_session.execute(
            select(User).where(User.email == body["email"]))).first() is None
        assert (await db_session.execute(
            select(Customer).where(Customer.name == body["company_name"]))).first() is None

    async def test_register_with_expired_invite_token_writes_nothing(self, client, db_session, as_user):
        """码过期 → 410，同样整体不落库。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        invite = await _mk_invite(client, as_user, team_id)
        row = (await db_session.execute(
            select(TeamInvite).where(TeamInvite.id == invite["invite_id"]))).scalar_one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
        await db_session.commit()

        body = _register_body(invite_token=invite["token"])
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 410
        assert _code(resp) == "INVITE_EXPIRED"
        assert (await db_session.execute(
            select(User).where(User.email == body["email"]))).first() is None

    async def test_register_with_invalid_team_name_writes_nothing(self, client, db_session):
        """团队名超长 → 422 INVALID_TEAM_NAME，且整个注册不落库。"""
        body = _register_body(team_name="长" * 41)      # 内核上限 40 字
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 422
        assert _code(resp) == "INVALID_TEAM_NAME"
        assert (await db_session.execute(
            select(User).where(User.email == body["email"]))).first() is None

    async def test_register_ignores_whitespace_only_team_name(self, client, db_session):
        """只有空白的 team_name 视为"没给"（与 Worker 同口径），注册照常，不建团队。"""
        body = _register_body(team_name="   ")
        resp = await client.post("/api/v1/auth/register", json=body)
        assert resp.status_code == 200, resp.text

        user = (await db_session.execute(
            select(User).where(User.email == body["email"]))).scalar_one()
        assert user.team_id is None
        assert (await db_session.execute(
            select(Team).where(Team.created_by == user.id))).first() is None
