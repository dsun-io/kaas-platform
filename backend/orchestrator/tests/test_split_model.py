"""「团队 / 用户(账号) / 业务客户」三概念拆分的契约测试（orchestrator 端，需 PostgreSQL）。

覆盖（对应本次拆分的四条业务要求）：
1. **customer 账号无 `user_customers` 绑定也能登录 / 取 `/me`**
   —— 旧逻辑"没有绑定就 403"，而绑定指向的公司行已由迁移 202610110008 删除，
   保留旧逻辑会把所有 customer 账号锁在门外。这里直接调**真实中间件**
   （`tests._REAL_AUTH_DISPATCH`，导入时抢在 conftest 替换之前固定下来的真身），
   确认放行且团队名/后台权限都取到了。
2. `/me`、`/login`、`/register` 返回 `team_id` / `team_name` / `console_access`，
   **不含** `customer_*`（前端契约 `frontend/src/lib/auth/types.ts`）。
3. 团队管理员可授予/收回成员的 `console_access`；非管理员 403；跨团队 404。
4. 客户工位 `POST /customers` 建的行是**业务客户**（带 `team_id`/`owner_id`），
   不参与账号归属。

做法同 `test_teams_api.py`：`as_user` fixture 把 AuthContext 注入 `request.state`。
"""
import uuid

import pytest
from sqlalchemy import delete, select
from starlette.requests import Request

from app.core.auth import AuthContext, create_access_token, hash_password
from app.db.models import Customer, Team, TeamSubscription, User, UserCustomer
from app.main import app
from app.middleware.auth import AuthContextMiddleware
from kaas_common.workstation.subscriptions import all_workstations
from tests import _REAL_AUTH_DISPATCH
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db

# 统一用自造租户：团队按租户隔离，混用 default 会让断言受种子数据影响
TENANT = "qa_split"


# ── 辅助 ────────────────────────────────────────────────────────────────────

@pytest.fixture
def as_user(monkeypatch):
    """切换"当前登录用户"（端点只读 request.state.auth，注入即可）。"""

    def _install(user_id: int, role: str = "user", tenant_id: str = TENANT,
                 team_id: int | None = None):
        async def _dispatch(self, request, call_next):
            path = request.url.path
            if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
                return await call_next(request)
            # 既注入 auth 也注入 tenant_id：否则 TenantContextMiddleware 会因
            # "customer 账号 + 无 X-Tenant-Id" 直接 401（与 conftest 同做法）
            request.state.tenant_id = tenant_id
            request.state.auth = AuthContext(
                user_id=user_id, account_type="customer", role=role,
                tenant_id=tenant_id, team_id=team_id)
            return await call_next(request)

        monkeypatch.setattr(AuthContextMiddleware, "dispatch", _dispatch)
        app.middleware_stack = None

    return _install


def _email(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:8]}@qa.test"


async def _mk_user(db, tag: str, *, role: str = "user", team_id=None,
                   console_access: bool = False, password: str = "password123") -> User:
    user = User(
        email=_email(tag), password_hash=hash_password(password),
        display_name=tag, account_type="customer", role=role, plan="free",
        status="active", team_id=team_id, console_access=console_access,
    )
    db.add(user)
    await db.flush()
    return user


async def _mk_team(client, as_user, db, *, name: str = "拆分测试团队", tag: str = "boss"):
    """建团队（不传 workstations = 全部开通），返回 (创建者, team_id)。"""
    admin = await _mk_user(db, tag, role="owner")
    as_user(admin.id, role="owner")
    resp = await client.post("/api/v1/teams", json={"name": name})
    assert resp.status_code == 201, resp.text
    return admin, resp.json()["id"]


def _req(path: str, token: str) -> Request:
    """构造一个最小可用的 Starlette Request（只带 Authorization header）。"""
    return Request({
        "type": "http", "method": "GET", "path": path, "raw_path": path.encode(),
        "query_string": b"", "headers": [(b"authorization", f"Bearer {token}".encode())],
        "scheme": "http", "server": ("test", 80), "client": ("test", 1234),
    })


async def _run_real_middleware(request: Request):
    """用**真实** `dispatch` 跑一次中间件。

    `call_next` 传一个立即返回的桩：本用例断言的是"中间件放不放行"——
    被拦下时中间件自己返回 JSONResponse（不调用 call_next），放行时返回我们给的桩。
    返回值语义：`None` = 放行，否则是被拦下的响应。
    """
    async def _call_next(_request):
        return None

    return await _REAL_AUTH_DISPATCH(AuthContextMiddleware(app), request, _call_next)


@pytest.fixture
def real_middleware(monkeypatch, db_engine):
    """把中间件内部自建的会话工厂指向测试库。

    否则真实中间件会去连 `.env` 里的生产库 —— 那测出来的东西没有意义
    （而且本用例造的账号在生产库里根本不存在）。
    """
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    monkeypatch.setattr("app.db.session.async_session_factory", factory)
    yield


@pytest.fixture
async def committed_account(db_engine):
    """**真落库**的账号 + 团队（用例结束自行清理）。

    为什么要一个"看得见"的账号：`db_session` 走的是"外层事务 + savepoint"隔离，
    真实中间件用的是它自己那条连接 —— 未提交的行它根本读不到，测试会假绿/假红。
    所以这里用独立会话显式 commit，teardown 再物理删除。
    """
    from sqlalchemy.ext.asyncio import AsyncSession

    tag = uuid.uuid4().hex[:8]
    created: dict = {}

    async with AsyncSession(db_engine, expire_on_commit=False) as db:
        team = Team(tenant_id=TENANT, name=f"无绑定团队-{tag}", created_by=None)
        db.add(team)
        await db.flush()
        user = User(
            email=f"nobind-{tag}@qa.test", password_hash=hash_password("password123"),
            display_name=f"nobind-{tag}", account_type="customer", role="owner",
            plan="free", status="active", team_id=team.id, console_access=True,
        )
        db.add(user)
        await db.flush()
        team.created_by = user.id          # 创建者即团队管理员
        created = {"user_id": user.id, "team_id": team.id, "team_name": team.name}
        await db.commit()

    yield created

    async with AsyncSession(db_engine) as db:
        await db.execute(delete(User).where(User.id == created["user_id"]))
        await db.execute(delete(Team).where(Team.id == created["team_id"]))
        await db.commit()


# ── 1. 无绑定也能登录 / 取 /me ───────────────────────────────────────────────

class TestNoBindingRequired:
    async def test_middleware_does_not_require_binding(self, db_engine, committed_account,
                                                       real_middleware):
        """真实中间件：customer 账号**没有** `user_customers` 绑定 → 不再 403。"""
        created = committed_account
        user_id, team_id = created["user_id"], created["team_id"]

        # 前提确认：这个账号确实一条绑定都没有（旧逻辑正是在这里 403）
        from sqlalchemy.ext.asyncio import AsyncSession

        async with AsyncSession(db_engine) as db:
            assert (await db.execute(
                select(UserCustomer).where(UserCustomer.user_id == user_id))).first() is None

        request = _req("/api/v1/customers", create_access_token(user_id, "customer"))
        denied = await _run_real_middleware(request)

        assert denied is None, "无绑定的 customer 账号不该被中间件拦下"
        auth = request.state.auth
        assert auth.user_id == user_id
        assert auth.customer_id is None          # 没有绑定 → 字段为 None，但**不拦**
        assert auth.customer_code is None
        assert auth.tenant_id == "default"       # 租户固定 default，不参与业务鉴权
        assert auth.team_id == team_id
        assert auth.team_name == created["team_name"]   # 团队名来自 users.team_id
        assert auth.console_access is True

    async def test_middleware_rejects_bad_token(self, db_engine, real_middleware):
        """对照：中间件仍然拦截无效 token（拆分没有把鉴权一起削弱）。"""
        denied = await _run_real_middleware(_req("/api/v1/customers", "not-a-jwt"))
        assert denied is not None and denied.status_code == 401

    async def test_login_works_without_binding(self, client, db_session):
        """端到端：无绑定的账号能登录拿到 token（登录不依赖绑定）。"""
        user = await _mk_user(db_session, "login", role="owner")

        resp = await client.post("/api/v1/auth/login",
                                 json={"email": user.email, "password": "password123"})
        assert resp.status_code == 200, resp.text
        out = resp.json()
        assert out["access_token"]
        assert out["account_type"] == "customer"
        assert out["team_id"] is None            # 没团队也是合法状态


# ── 2. 响应体契约 ────────────────────────────────────────────────────────────

class TestAuthResponseShape:
    async def test_me_has_team_fields_and_no_customer_fields(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        as_user(admin.id, role="owner")

        resp = await client.get("/api/v1/auth/me")
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert body["team_id"] == team_id
        assert body["team_name"] == "拆分测试团队"
        assert body["console_access"] is False
        for gone in ("customer_id", "customer_code", "customer_name"):
            assert gone not in body, f"/me 不该再返回 {gone}"
        assert "access_token" not in body        # /me 不发 token

    async def test_login_returns_team_fields(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)

        resp = await client.post("/api/v1/auth/login",
                                 json={"email": admin.email, "password": "password123"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["team_id"] == team_id
        assert body["team_name"] == "拆分测试团队"
        assert body["console_access"] is False
        assert body["access_token"]
        assert "customer_id" not in body

    async def test_register_returns_team_fields(self, client, db_session):
        """注册响应体同样是 team_* / console_access（前端注册页读的就是它）。"""
        email = _email("newbie")
        resp = await client.post("/api/v1/auth/register", json={
            "email": email, "password": "password123", "display_name": "新人",
            "company_name": f"新人公司-{uuid.uuid4().hex[:6]}",
            "product_category": "fencing", "team_name": "注册即建团队",
        })
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["team_name"] == "注册即建团队"
        assert body["console_access"] is False
        assert body["access_token"]
        for gone in ("customer_id", "customer_code", "customer_name"):
            assert gone not in body, f"注册响应不该再返回 {gone}"


# ── 3. console_access 授予 / 收回 ────────────────────────────────────────────

class TestConsoleAccess:
    async def test_admin_grants_and_revokes(self, client, db_session, as_user):
        admin, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        as_user(admin.id, role="owner")

        grant = await client.put(
            f"/api/v1/teams/{team_id}/members/{mate.id}/console-access",
            json={"allowed": True})
        assert grant.status_code == 200, grant.text
        assert grant.json() == {"user_id": mate.id, "console_access": True}

        listed = (await client.get(f"/api/v1/teams/{team_id}/members")).json()
        by_id = {row["user_id"]: row for row in listed["items"]}
        assert by_id[mate.id]["console_access"] is True
        assert by_id[admin.id]["console_access"] is False

        revoke = await client.put(
            f"/api/v1/teams/{team_id}/members/{mate.id}/console-access",
            json={"allowed": False})
        assert revoke.status_code == 200, revoke.text
        assert revoke.json() == {"user_id": mate.id, "console_access": False}

    async def test_member_cannot_grant(self, client, db_session, as_user):
        """普通成员（非团队管理员）→ 403 NOT_TEAM_ADMIN。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        other = await _mk_user(db_session, "other", team_id=team_id)

        as_user(mate.id, role="user")
        resp = await client.put(
            f"/api/v1/teams/{team_id}/members/{other.id}/console-access",
            json={"allowed": True})
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"]["code"] == "NOT_TEAM_ADMIN"

    async def test_cross_team_member_404(self, client, db_session, as_user):
        """跨团队成员 → 404 MEMBER_NOT_FOUND（越权授予不能靠"猜 id"成功）。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        _, other_team_id = await _mk_team(client, as_user, db_session,
                                          name="别的团队", tag="other")
        stranger = await _mk_user(db_session, "stranger", team_id=other_team_id)

        as_user(admin.id, role="owner")
        resp = await client.put(
            f"/api/v1/teams/{team_id}/members/{stranger.id}/console-access",
            json={"allowed": True})
        assert resp.status_code == 404, resp.text
        assert resp.json()["detail"]["code"] == "MEMBER_NOT_FOUND"
        # 该成员仍在原团队，且没有被授予
        assert (await db_session.execute(
            select(User.team_id).where(User.id == stranger.id))).scalar_one() == other_team_id
        assert (await db_session.execute(
            select(User.console_access).where(User.id == stranger.id))).scalar_one() is False

    async def test_platform_admin_can_grant(self, client, db_session, as_user):
        """平台管理员兜底：能管任意团队（判定走内核 is_team_admin）。"""
        _, team_id = await _mk_team(client, as_user, db_session)
        mate = await _mk_user(db_session, "mate", team_id=team_id)
        root = await _mk_user(db_session, "root", role="system_admin")

        as_user(root.id, role="system_admin")
        resp = await client.put(
            f"/api/v1/teams/{team_id}/members/{mate.id}/console-access",
            json={"allowed": True})
        assert resp.status_code == 200, resp.text
        assert resp.json()["console_access"] is True


# ── 4. 客户工位建的是"业务客户" ──────────────────────────────────────────────

class TestBusinessCustomer:
    async def test_created_row_is_business_customer(self, client, db_session, as_user):
        """`POST /customers` 的行带 team_id/owner_id，且**不产生**任何账号绑定。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        # AuthContext 的 team_id 在真实中间件里来自 users.team_id；注入型 as_user
        # 不会自动读库，所以要显式带上，否则 POST /customers 落库的 team_id 是 NULL。
        as_user(admin.id, role="owner", team_id=team_id)

        name = f"业务客户-{uuid.uuid4().hex[:8]}"
        resp = await client.post("/api/v1/customers", json={"company_name": name})
        assert resp.status_code == 201, resp.text
        row = (await db_session.execute(
            select(Customer).where(Customer.name == name))).scalar_one()

        assert row.team_id == team_id              # 归属团队（可见性判定用）
        assert row.owner_id == str(admin.id)       # 归属创建者
        assert row.created_by == str(admin.id)
        assert row.is_deleted is False
        # 业务客户不参与账号归属：不会因此多出 user_customers 绑定
        assert (await db_session.execute(
            select(UserCustomer).where(UserCustomer.customer_id == row.id))).first() is None

    async def test_account_is_not_a_customer_row(self, client, db_session, as_user):
        """账号归属靠 `users.team_id`，账号本身不会在 `customers` 里留行。"""
        admin, team_id = await _mk_team(client, as_user, db_session)
        user = (await db_session.execute(
            select(User).where(User.id == admin.id))).scalar_one()
        assert user.team_id == team_id
        assert (await db_session.execute(
            select(Customer).where(Customer.name == user.display_name))).first() is None


# ── 5. 建团队的 workstations 参数 ────────────────────────────────────────────

class TestTeamWorkstations:
    async def test_default_grants_all_workstations(self, client, db_session, as_user):
        """不传 workstations = 开通全部（当前阶段全部免费）。"""
        admin = await _mk_user(db_session, "boss", role="owner")
        as_user(admin.id, role="owner")
        resp = await client.post("/api/v1/teams", json={"name": "全工位团队"})
        assert resp.status_code == 201, resp.text
        team_id = resp.json()["id"]

        rows = (await db_session.execute(
            select(TeamSubscription).where(TeamSubscription.team_id == team_id))).scalars().all()
        assert {r.code for r in rows} == set(all_workstations())
        assert {r.source for r in rows} == {"signup"}

    async def test_explicit_subset(self, client, db_session, as_user):
        admin = await _mk_user(db_session, "boss", role="owner")
        as_user(admin.id, role="owner")
        resp = await client.post(
            "/api/v1/teams",
            json={"name": "单工位团队", "workstations": ["customers", " Quotes "]})
        assert resp.status_code == 201, resp.text
        team_id = resp.json()["id"]

        rows = (await db_session.execute(
            select(TeamSubscription).where(TeamSubscription.team_id == team_id))).scalars().all()
        assert {r.code for r in rows} == {"customers", "quotes"}    # 内核负责去空白/小写

    async def test_unknown_workstation_422_writes_nothing(self, client, db_session, as_user):
        admin = await _mk_user(db_session, "boss", role="owner")
        as_user(admin.id, role="owner")
        resp = await client.post(
            "/api/v1/teams",
            json={"name": "坏工位团队", "workstations": ["customers", "nope"]})
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "UNKNOWN_WORKSTATION"
        assert (await db_session.execute(
            select(Team).where(Team.name == "坏工位团队"))).first() is None

    async def test_register_with_workstations(self, client, db_session):
        resp = await client.post("/api/v1/auth/register", json={
            "email": _email("ws"), "password": "password123", "display_name": "工位新人",
            "company_name": f"工位公司-{uuid.uuid4().hex[:6]}",
            "product_category": "fencing", "team_name": "注册选工位团队",
            "workstations": ["customers"],
        })
        assert resp.status_code == 200, resp.text
        team_id = resp.json()["team_id"]

        rows = (await db_session.execute(
            select(TeamSubscription).where(TeamSubscription.team_id == team_id))).scalars().all()
        assert {r.code for r in rows} == {"customers"}
        assert {r.source for r in rows} == {"signup"}

    async def test_register_unknown_workstation_422(self, client, db_session):
        email = _email("badws")
        resp = await client.post("/api/v1/auth/register", json={
            "email": email, "password": "password123", "display_name": "坏工位",
            "company_name": f"坏工位公司-{uuid.uuid4().hex[:6]}",
            "product_category": "fencing", "team_name": "坏工位注册团队",
            "workstations": ["not_a_workstation"],
        })
        assert resp.status_code == 422, resp.text
        assert resp.json()["detail"]["code"] == "UNKNOWN_WORKSTATION"
        # 整个注册不落库
        assert (await db_session.execute(
            select(User).where(User.email == email))).first() is None
