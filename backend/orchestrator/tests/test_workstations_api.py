"""工位订阅 API + 未开通拦截中间件的接口测试（orchestrator 端，需要 PostgreSQL）。

覆盖（与生产 Worker 的 `backend/worker/tests/test_workstations_api.py` 同口径）：
- 我的工位：无团队=空、团队开通=全员可用、个人额外开通、平台管理员=全部、has_team
- 团队订阅：管理员可读可写、成员 403、跨租户/不存在 404、未知编码 422、
  upsert 幂等、撤销=置 active=false（保留行）、停用/过期不计入生效编码
- 个人订阅：仅平台管理员（团队管理员 403）、目标用户不存在 404、撤销
- 拦截中间件：无 token 放行、永久放行路径放行、非工位路径放行、
  未开通 404 WORKSTATION_NOT_SUBSCRIBED、已开通放行、管理员不受限、
  缓存开关（命中不查库 / 开通后立即失效）、**任何异常都放行**

做法同 `test_teams_api.py`：patch `AuthContextMiddleware.dispatch` 注入 AuthContext，
用 `client` fixture（DB 依赖已被 conftest 覆盖成同一会话）。
中间件之所以能测：它只从 **Authorization header** 解 token，不看 `request.state.auth`，
所以"header 里放真 token + 中间件注入 auth"两者互不干扰。
"""
import time
from datetime import datetime, timedelta, timezone
import uuid

import pytest
from sqlalchemy import select

from app.core.auth import AuthContext, create_access_token
from app.db.models import Team, TeamSubscription, User, UserSubscription
from app.main import app
from app.middleware.auth import AuthContextMiddleware
from kaas_common.workstation.subscriptions import FULL_CHAIN, all_workstations
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db

TENANT = "qa_workstations"


# ── 认证 / 数据辅助 ──────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clear_subscription_cache():
    """每条用例前后都清进程内订阅缓存。

    缓存是**模块级全局**的，key 只有 user_id —— 不清就会跨用例串台
    （表现为"单跑通过、全跑失败"）。清在前后两侧：前侧防别人污染，后侧防自己漏出去。
    """
    from app.api import workstations as ws_api
    ws_api.invalidate_all()
    yield
    ws_api.invalidate_all()


@pytest.fixture(autouse=True)
def _middleware_uses_test_session(monkeypatch, db_session):
    """让中间件的**自建会话**也用本条用例的会话/事务。

    为什么必须这么干：中间件（和 `AuthContextMiddleware` / `TenantContextMiddleware` 一样）
    跑在 FastAPI 依赖注入之外，自己 `async_session_factory()` 开一个会话 —— 那是**另一条连接**，
    看不到本用例尚未提交的数据。于是"测试里刚建的团队订阅"对中间件不可见，
    表现成"明明开通了却仍 404"，而这条用例在真实请求路径上其实是对的。

    patch 成同一个会话后，中间件的读取与用例的写入处在**同一事务**里，
    且用例结束时的 rollback 仍然把一切清干净（不污染相邻用例）。
    """
    from app.db import session as db_session_module

    class _Factory:
        def __call__(self):
            return _SessionCtx(db_session)

    class _SessionCtx:
        def __init__(self, session):
            self._session = session

        async def __aenter__(self):
            return self._session

        async def __aexit__(self, *exc_info):
            # 不关闭：这是**共享的**用例会话，由 db_session fixture 统一收尾
            return False

    monkeypatch.setattr(db_session_module, "async_session_factory", _Factory())


@pytest.fixture
def as_user(monkeypatch):
    """切换"当前登录用户"（只影响路由层：注入 request.state.auth）。"""

    def _install(user_id: int, role: str = "user", tenant_id: str = TENANT):
        async def _dispatch(self, request, call_next):
            path = request.url.path
            if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
                return await call_next(request)
            request.state.tenant_id = tenant_id
            request.state.auth = AuthContext(
                user_id=user_id, account_type="customer", role=role, tenant_id=tenant_id)
            return await call_next(request)

        monkeypatch.setattr(AuthContextMiddleware, "dispatch", _dispatch)
        app.middleware_stack = None

    return _install


def _email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:8]}@qa.test"


def _code(resp) -> str:
    return resp.json()["detail"]["code"]


def _bearer(user_id: int) -> dict:
    """真 JWT：中间件用它解出 user_id（`decode_access_token` 走真实密钥）。"""
    return {"Authorization": f"Bearer {create_access_token(user_id, 'customer')}"}


async def _mk_user(db, tag: str, *, role: str = "user", team_id=None) -> User:
    user = User(
        email=_email(tag), password_hash="x", display_name=tag,
        account_type="customer", role=role, plan="free", status="active",
        team_id=team_id,
    )
    db.add(user)
    await db.flush()
    return user


async def _mk_team(client, as_user, db, *, name: str | None = None, tag: str = "boss"):
    """建一个团队（走真实端点，创建者即团队管理员）：返回 (创建者, team_id)。"""
    admin = await _mk_user(db, tag, role="owner")
    as_user(admin.id, role="owner")
    resp = await client.post(
        "/api/v1/teams",
        # 不传 workstations = 开通**全部**（当前阶段全部免费，见 app/api/teams.py）。
        # 本文件的用例要精确控制"开通了哪些"，所以显式传空数组。
        json={"name": name or f"工位团队-{uuid.uuid4().hex[:6]}", "workstations": []},
    )
    assert resp.status_code == 201, resp.text
    return admin, resp.json()["id"]


async def _grant_team(db, team_id: int, code: str, *, active: bool = True, expires_at=None):
    """直接落一条团队订阅（用于"中间件能看到已开通"这类前置状态）。"""
    db.add(TeamSubscription(
        team_id=team_id, code=code, active=active, expires_at=expires_at, source="manual"))
    await db.flush()


async def _grant_user(db, user_id: int, code: str, *, active: bool = True, expires_at=None):
    db.add(UserSubscription(
        user_id=user_id, code=code, active=active, expires_at=expires_at, source="manual"))
    await db.flush()


# ── 我的工位 ────────────────────────────────────────────────────────────────

class TestMyWorkstations:
    async def test_no_team_no_subscription_is_empty(self, client, db_session, as_user):
        user = await _mk_user(db_session, "solo")
        as_user(user.id)
        resp = await client.get("/api/v1/me/workstations")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "workstations": [], "codes": [], "is_admin": False, "has_team": False}

    async def test_team_subscription_unlocks_every_member(self, client, db_session, as_user):
        """团队开通 = 全员可用：成员自己没有任何个人订阅也能看到工位。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        await _grant_team(db_session, team_id, FULL_CHAIN)
        mate = await _mk_user(db_session, "mate", team_id=team_id)

        as_user(mate.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["has_team"] is True
        assert body["codes"] == [FULL_CHAIN]
        # 全工位套餐 → 内核清单里的每个工位都在
        assert body["workstations"] == list(all_workstations())
        assert body["is_admin"] is False

    async def test_personal_subscription_adds_one_workstation(self, client, db_session, as_user):
        """个人可额外开通：团队没开，个人开一个 shipments 就只有它。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        await _grant_user(db_session, mate.id, "shipments")

        as_user(mate.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["workstations"] == ["shipments"]
        assert body["codes"] == ["shipments"]

    async def test_inactive_and_expired_are_ignored(self, client, db_session, as_user):
        """active=false / 已过期 都不计入生效编码（判定真源在内核）。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        await _grant_team(db_session, team_id, "orders", active=False)
        await _grant_team(db_session, team_id, "quotes", expires_at=datetime.now(timezone.utc) - timedelta(days=1))
        await _grant_user(db_session, mate.id, "shipments", active=False)

        as_user(mate.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["workstations"] == []
        assert body["codes"] == []

    async def test_platform_admin_sees_all_workstations(self, client, db_session, as_user):
        """平台管理员不受限：不必查表也返回全部工位。"""
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["is_admin"] is True
        assert body["workstations"] == list(all_workstations())
        assert body["codes"] == [FULL_CHAIN]


# ── 团队订阅 ────────────────────────────────────────────────────────────────

class TestTeamSubscriptions:
    async def test_admin_opens_and_reads_back(self, client, db_session, as_user):
        """开通 → 200 契约字段；列表能看到该行。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")

        resp = await client.put(f"/api/v1/teams/{team_id}/subscriptions/customers",
                                json={"active": True})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "code": "customers", "active": True, "expires_at": None, "source": "manual"}

        listed = await client.get(f"/api/v1/teams/{team_id}/subscriptions")
        assert listed.status_code == 200, listed.text
        body = listed.json()
        assert body["total"] == 1
        assert body["items"][0]["code"] == "customers"
        assert body["items"][0]["active"] is True
        assert body["items"][0]["source"] == "manual"
        assert body["items"][0]["created_at"] is not None
        assert body["items"][0]["expires_at"] is None

    async def test_upsert_is_idempotent(self, client, db_session, as_user):
        """幂等：连开两次只留一行（唯一约束上的 ON CONFLICT DO UPDATE）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        url = f"/api/v1/teams/{team_id}/subscriptions/orders"

        first = await client.put(url, json={"active": True})
        second = await client.put(url, json={"active": True})
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()

        rows = (await db_session.execute(
            select(TeamSubscription).where(TeamSubscription.team_id == team_id)
        )).scalars().all()
        assert [r.code for r in rows] == ["orders"]

    async def test_full_chain_code_accepted(self, client, db_session, as_user):
        """全工位套餐编码也是合法输入（它不是工位 key，但必须能开通）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.put(f"/api/v1/teams/{team_id}/subscriptions/{FULL_CHAIN}",
                                json={"active": True})
        assert resp.status_code == 200, resp.text
        assert resp.json()["code"] == FULL_CHAIN

    async def test_unknown_code_422(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.put(f"/api/v1/teams/{team_id}/subscriptions/nope",
                                json={"active": True})
        assert resp.status_code == 422
        assert _code(resp) == "UNKNOWN_WORKSTATION"

    async def test_expires_at_roundtrip_and_bad_format(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        url = f"/api/v1/teams/{team_id}/subscriptions/intel"

        ok = await client.put(url, json={"active": True, "expires_at": "2026-12-31T00:00:00+08:00"})
        assert ok.status_code == 200, ok.text
        assert ok.json()["expires_at"] is not None

        bad = await client.put(url, json={"active": True, "expires_at": "12月31日"})
        assert bad.status_code == 422
        assert _code(bad) == "INVALID_EXPIRES_AT"

    async def test_member_cannot_read_or_write(self, client, db_session, as_user):
        """团队成员 ≠ 团队管理员：读和写都要 403 NOT_TEAM_ADMIN。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(mate.id, role="user")

        read = await client.get(f"/api/v1/teams/{team_id}/subscriptions")
        assert read.status_code == 403
        assert _code(read) == "NOT_TEAM_ADMIN"

        write = await client.put(f"/api/v1/teams/{team_id}/subscriptions/customers",
                                 json={"active": True})
        assert write.status_code == 403
        assert _code(write) == "NOT_TEAM_ADMIN"

    async def test_platform_admin_manages_any_team(self, client, db_session, as_user):
        _, team_id = await _mk_team(client, as_user, db_session)
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        resp = await client.put(f"/api/v1/teams/{team_id}/subscriptions/quotes",
                                json={"active": True})
        assert resp.status_code == 200, resp.text

    async def test_unknown_team_404(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        resp = await client.get("/api/v1/teams/999999/subscriptions")
        assert resp.status_code == 404
        assert _code(resp) == "TEAM_NOT_FOUND"

    async def test_other_tenant_team_is_404(self, client, db_session, as_user):
        """跨租户的 team_id 一律当不存在（不泄露别家团队是否存在）。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin", tenant_id="qa_workstations_other")
        resp = await client.get(f"/api/v1/teams/{team_id}/subscriptions")
        assert resp.status_code == 404
        assert _code(resp) == "TEAM_NOT_FOUND"

    async def test_revoke_keeps_row_but_flags_inactive(self, client, db_session, as_user):
        """撤销 = 置 active=false 并**保留行**（列表里仍能看到历史）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        await client.put(f"/api/v1/teams/{team_id}/subscriptions/leadgen", json={"active": True})

        resp = await client.delete(f"/api/v1/teams/{team_id}/subscriptions/leadgen")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"revoked": True, "code": "leadgen"}

        row = (await db_session.execute(
            select(TeamSubscription).where(TeamSubscription.team_id == team_id))).scalar_one()
        assert row.active is False

        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(mate.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert "leadgen" not in body["workstations"]

    async def test_revoke_unknown_subscription_404(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.delete(f"/api/v1/teams/{team_id}/subscriptions/outreach")
        assert resp.status_code == 404
        assert _code(resp) == "SUBSCRIPTION_NOT_FOUND"

    async def test_inactive_code_opens_but_does_not_unlock(self, client, db_session, as_user):
        """`active=false` 的开通记录本身合法（列表可见），但不构成生效订阅。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")
        resp = await client.put(f"/api/v1/teams/{team_id}/subscriptions/research",
                                json={"active": False})
        assert resp.status_code == 200, resp.text
        assert resp.json()["active"] is False

        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(mate.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["workstations"] == []


# ── 个人订阅（仅平台管理员）─────────────────────────────────────────────────

class TestUserSubscriptions:
    async def test_platform_admin_grants_and_reads_back(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        target = await _mk_user(db_session, "target")
        as_user(root.id, role="system_admin")

        resp = await client.put(f"/api/v1/users/{target.id}/subscriptions/shipments",
                                json={"active": True})
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "code": "shipments", "active": True, "expires_at": None, "source": "manual"}

        listed = await client.get(f"/api/v1/users/{target.id}/subscriptions")
        assert listed.status_code == 200, listed.text
        assert listed.json()["total"] == 1
        assert listed.json()["items"][0]["code"] == "shipments"

        as_user(target.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["workstations"] == ["shipments"]

    async def test_team_admin_cannot_grant_personal(self, client, db_session, as_user):
        """个人开通只给平台管理员：团队管理员也不行（403 ADMIN_ONLY）。"""
        admin, _ = await _mk_team(client, as_user, db_session)
        target = await _mk_user(db_session, "target")
        as_user(admin.id, role="owner")

        listed = await client.get(f"/api/v1/users/{target.id}/subscriptions")
        assert listed.status_code == 403
        assert _code(listed) == "ADMIN_ONLY"

        put = await client.put(f"/api/v1/users/{target.id}/subscriptions/shipments",
                               json={"active": True})
        assert put.status_code == 403
        assert _code(put) == "ADMIN_ONLY"

    async def test_unknown_user_404(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        as_user(root.id, role="system_admin")
        resp = await client.put("/api/v1/users/999999/subscriptions/shipments",
                                json={"active": True})
        assert resp.status_code == 404
        assert _code(resp) == "USER_NOT_FOUND"

    async def test_upsert_idempotent(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        target = await _mk_user(db_session, "target")
        as_user(root.id, role="system_admin")
        url = f"/api/v1/users/{target.id}/subscriptions/trade-docs"

        await client.put(url, json={"active": True})
        await client.put(url, json={"active": True})
        rows = (await db_session.execute(
            select(UserSubscription).where(UserSubscription.user_id == target.id)
        )).scalars().all()
        assert [r.code for r in rows] == ["trade-docs"]

    async def test_revoke(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        target = await _mk_user(db_session, "target")
        as_user(root.id, role="system_admin")
        await client.put(f"/api/v1/users/{target.id}/subscriptions/outreach",
                         json={"active": True})

        resp = await client.delete(f"/api/v1/users/{target.id}/subscriptions/outreach")
        assert resp.status_code == 200, resp.text
        assert resp.json() == {"revoked": True, "code": "outreach"}
        row = (await db_session.execute(
            select(UserSubscription).where(UserSubscription.user_id == target.id))).scalar_one()
        assert row.active is False

        as_user(target.id)
        body = (await client.get("/api/v1/me/workstations")).json()
        assert body["workstations"] == []

    async def test_revoke_unknown_subscription_404(self, client, db_session, as_user):
        root = await _mk_user(db_session, "root", role="system_admin")
        target = await _mk_user(db_session, "target")
        as_user(root.id, role="system_admin")
        resp = await client.delete(f"/api/v1/users/{target.id}/subscriptions/intel")
        assert resp.status_code == 404
        assert _code(resp) == "SUBSCRIPTION_NOT_FOUND"


# ── 拦截中间件 ──────────────────────────────────────────────────────────────

class TestSubscriptionGuard:
    """未开通工位 → 404。

    这些用例刻意**不发** `as_user` 注入：中间件只看 Authorization header，
    而路由层被 mock 成"无论谁调都放行"，于是"能不能走到 handler"完全由中间件决定。
    """

    async def test_no_token_passes_through(self, client, db_session):
        """没有 token → 放行（认证是路由自己的职责，中间件不越权）。"""
        resp = await client.get("/api/v1/customers")
        assert resp.status_code != 404
        assert resp.json().get("code") != "WORKSTATION_NOT_SUBSCRIBED"

    async def test_always_allowed_path_passes_even_with_bad_token(self, client, db_session):
        """`is_always_allowed` 的路径（团队/订阅/我的工位）即便 token 是垃圾也放行。"""
        headers = {"Authorization": "Bearer not-a-real-jwt"}
        for path in ("/api/v1/me/workstations", "/api/v1/teams/me",
                     "/api/v1/enums/business-types"):
            resp = await client.get(path, headers=headers)
            assert resp.json().get("code") != "WORKSTATION_NOT_SUBSCRIBED", path

    async def test_path_without_workstation_passes(self, client, db_session):
        """不属于任何收费工位的路径（如产品定义）不拦。"""
        user = await _mk_user(db_session, "solo")
        resp = await client.get("/api/v1/tenant-products", headers=_bearer(user.id))
        assert resp.status_code != 404

    async def test_unsubscribed_workstation_404(self, client, db_session):
        """未开通 → 404 + 契约错误体（不暴露"工位存在"）。"""
        user = await _mk_user(db_session, "solo")
        resp = await client.get("/api/v1/customers", headers=_bearer(user.id))
        assert resp.status_code == 404, resp.text
        assert resp.json() == {
            "error": "not_found", "code": "WORKSTATION_NOT_SUBSCRIBED",
            "workstation": "customers",
            "detail": "该工位未开通，请在“工位开通”里启用",
        }

    async def test_subscribed_workstation_passes(self, client, db_session):
        """团队开通了 customers → 放行。直接落库建团队，避免依赖 POST /teams。"""
        team = Team(tenant_id=TENANT, name=f"中间件团队-{uuid.uuid4().hex[:6]}")
        db_session.add(team)
        await db_session.flush()
        await _grant_team(db_session, team.id, "customers")
        user = await _mk_user(db_session, "mate", team_id=team.id)

        resp = await client.get("/api/v1/customers", headers=_bearer(user.id))
        assert resp.status_code != 404

    async def test_full_chain_code_unlocks_every_workstation(self, client, db_session):
        team = Team(tenant_id=TENANT, name=f"全套团队-{uuid.uuid4().hex[:6]}")
        db_session.add(team)
        await db_session.flush()
        await _grant_team(db_session, team.id, FULL_CHAIN)
        user = await _mk_user(db_session, "mate", team_id=team.id)

        for path in ("/api/v1/customers", "/api/v1/orders", "/api/v1/quotations",
                     "/api/v1/shipments", "/api/v1/trade-docs"):
            resp = await client.get(path, headers=_bearer(user.id))
            assert resp.status_code != 404, path

    async def test_platform_admin_is_never_blocked(self, client, db_session):
        root = await _mk_user(db_session, "root", role="system_admin")
        resp = await client.get("/api/v1/customers", headers=_bearer(root.id))
        assert resp.status_code != 404

    async def test_expired_subscription_blocks(self, client, db_session):
        """过期订阅不算数（`expires_at > now()` 才算有效）。"""
        team = Team(tenant_id=TENANT, name=f"过期团队-{uuid.uuid4().hex[:6]}")
        db_session.add(team)
        await db_session.flush()
        await _grant_team(db_session, team.id, "orders",
                          expires_at=datetime.now(timezone.utc) - timedelta(seconds=5))
        user = await _mk_user(db_session, "mate", team_id=team.id)

        resp = await client.get("/api/v1/orders", headers=_bearer(user.id))
        assert resp.status_code == 404
        assert resp.json()["workstation"] == "orders"

    async def test_result_is_cached_then_invalidated(self, client, db_session):
        """缓存命中就不查库；开通后**立即失效**，不必等 30 秒 TTL。"""
        from app.api import workstations as ws_api

        user = await _mk_user(db_session, "solo")
        assert (await client.get("/api/v1/orders", headers=_bearer(user.id))).status_code == 404
        assert ws_api.cached_subscription(user.id) is not None      # 负结果也进缓存

        await _grant_user(db_session, user.id, "orders")
        # 缓存还在 → 仍然 404（证明上一次判定来自缓存而非每次都查库）
        assert (await client.get("/api/v1/orders", headers=_bearer(user.id))).status_code == 404

        ws_api.invalidate_users([user.id])
        assert (await client.get("/api/v1/orders", headers=_bearer(user.id))).status_code != 404

    async def test_cache_entry_expires(self, client, db_session):
        """TTL 到期后缓存失效（回源拿到最新判定）。"""
        from app.api import workstations as ws_api

        user = await _mk_user(db_session, "solo")
        await client.get("/api/v1/orders", headers=_bearer(user.id))
        hit = ws_api.cached_subscription(user.id)
        assert hit is not None and hit[0] > time.monotonic()

        # 手工把过期时间拨到过去 = 模拟 30 秒后
        _cached = ws_api._SUBSCRIPTION_CACHE[user.id]
        ws_api._SUBSCRIPTION_CACHE[user.id] = (time.monotonic() - 1, _cached[1], _cached[2])
        assert ws_api.cached_subscription(user.id) is None

        await _grant_user(db_session, user.id, "orders")
        assert (await client.get("/api/v1/orders", headers=_bearer(user.id))).status_code != 404

    async def test_internal_failure_fails_open(self, client, db_session, monkeypatch):
        """中间件内部异常 → **放行**（订阅校验故障不能让整个服务不可用）。

        让「读缓存」这一步直接抛异常（模拟订阅链路本身坏了）。注意必须替换
        `cached_subscription` 本身：`_SUBSCRIPTION_CACHE` 只被 `.get()` 访问，
        换 dict 子类的 `__getitem__` 根本不会触发。
        """
        from app.api import workstations as ws_api

        def _boom(_user_id):
            raise RuntimeError("cache exploded")

        monkeypatch.setattr(ws_api, "cached_subscription", _boom)
        user = await _mk_user(db_session, "solo")
        resp = await client.get("/api/v1/customers", headers=_bearer(user.id))
        assert resp.status_code != 404

    async def test_db_failure_fails_open(self, client, db_session, monkeypatch):
        """DB 不通 → 同样放行（token 解不开也是一种，二者都走同一个 except）。"""
        from app.api import workstations as ws_api

        async def _boom(*args, **kwargs):
            raise RuntimeError("db is on fire")

        monkeypatch.setattr(ws_api, "_live_codes", _boom)
        user = await _mk_user(db_session, "solo")
        resp = await client.get("/api/v1/customers", headers=_bearer(user.id))
        assert resp.status_code != 404

    async def test_undecodable_token_fails_open(self, client, db_session):
        """token 解不开 → 放行，交给路由自身鉴权（中间件不越权判 401）。"""
        resp = await client.get("/api/v1/customers",
                                headers={"Authorization": "Bearer not-a-jwt"})
        assert resp.status_code != 404

    async def test_unknown_user_passes_through(self, client, db_session):
        """token 里的用户已不存在 → 放行，让路由鉴权去 401（中间件不伪造 404）。"""
        resp = await client.get("/api/v1/customers", headers=_bearer(987654321))
        assert resp.status_code != 404


# ── 契约护栏：编码清单必须与共享内核一致 ────────────────────────────────────

class TestContractWithSharedKernel:
    async def test_codes_match_kernel(self, client, db_session):
        """开通接口接受的编码 = 内核工位清单 ∪ {full_chain}，一个不多一个不少。

        这是防漂移的护栏：以后往 `WORKSTATION_PATHS` 加工位、或改工位 key 时，
        接口会自动跟上；反之若谁在本端点里另写一份清单，这里立刻失败。
        """
        from app.api.workstations import _known_codes
        assert _known_codes() == set(all_workstations()) | {FULL_CHAIN}
