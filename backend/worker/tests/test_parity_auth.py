"""S3 行为对等：认证 / 账号治理域（orchestrator ↔ worker）。

为什么有这份文件
----------------
方案 B（单 Worker + asyncpg）的终态是**删掉 orchestrator 业务壳**，此后线上行为
只由 worker 决定。所以这两个域今天必须先把「worker 现在的行为」和「orchestrator
现在的行为」逐条摆在一起：删壳那一刻若两侧不一致，就是线上行为漂移，而且没人会
再有机会在 orchestrator 侧发现它。

本文件做两件事
--------------
1. **钉死 worker 当前行为**（普通用例）：路径/方法、请求体必填与校验、错误码与错误体、
   响应键集、状态码语义、鉴权前置顺序。改坏任何一条都会红。
2. **显式登记与 orchestrator 的差异**（不许静默放过）：
   - 语义差异 → ``@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-n ...")``，
     用例断言的是 **orchestrator 口径**。今天必然 xfail（证明差异存在）；worker 修好后
     会 XPASS，strict 让 XPASS 变红 ⇒ 强迫摘掉标记。**这是棘轮，不是"放过"。**
   - 纯响应体形状/文案差异（状态码语义一致）→ 普通用例里用 ``PARITY-DIFF-n`` 注释点名。

不连库：HTTP 断言只覆盖「鉴权 / 校验先于取连接」的分支，以及用桩连接把 handler
跑到返回（failing 分支）。真实写入路径见 ``tests/integration/test_worker_write_paths.py``
（本地无 PG 自动 skip）。

差异清单（编号与下文用例一一对应；行号取 HEAD 快照）
-----------------------------------------------------
| #   | 端点                     | orchestrator                                                      | worker                                                              |
|-----|--------------------------|-------------------------------------------------------------------|---------------------------------------------------------------------|
| D1  | POST auth/bootstrap-admin| 缺 Bearer 头 → **401**（auth.py:369-371）                          | 403（main.py:282 把"缺头/码错"并成一档）                            |
| D2  | POST auth/bootstrap-admin| 密码 <8 → **422**（auth.py:387-388）                                | 不校验长度，直接落库（main.py:276-299）                             |
| D3  | POST auth/bootstrap-admin| 邮箱重复 → **409**（auth.py:390-393）                               | 无预检，靠 DB 唯一约束 → 500（main.py:291-297）                     |
| D4  | POST auth/bootstrap-admin| 响应**扁平** 11 键（auth.py:139-159, 412）                          | 嵌套 `{access_token,token_type,user{5 键}}`，无 plan（main.py:299）  |
| D5  | POST auth/bootstrap-admin| 配置/初始化/令牌 **先于** body 校验（auth.py:354-386）              | Pydantic 先校验 body ⇒ 空 body 恒 422（main.py:277）                |
| D6  | POST auth/login          | 响应扁平、含 plan（auth.py:139-159, 307）                           | 嵌套 `{access_token,token_type,user}`，无 plan（main.py:319）       |
| D7  | POST auth/login          | 账号禁用 → **403**（auth.py:300-301）                               | 401 "Invalid credentials"（main.py:310-311）                        |
| D8  | POST auth/login          | 邮箱 strip+lower（auth.py:289）                                     | 只 lower、不 strip（main.py:308）                                   |
| D9  | GET  auth/me             | 含 plan/effective_role/tenant_id（auth.py:334-338）                 | 无这三项；多 id/status（main.py:331-337）                           |
| D10 | POST auth/register       | 未知工位**总是** 422（auth.py:198 解析期校验）                      | 只在建团队时校验 ⇒ 无 team 时静默忽略（main.py:649-681）            |
| D11 | POST auth/register       | `workstations: []` → 开通**零个**（auth.py:98-104）                 | `[]` 视为"没传" → 开通**全部 9 个**（ws_teams.py:198-215）          |
| D12 | POST auth/register       | 邀请码无效先于邮箱重复（404）（auth.py:224-238）                    | 邮箱重复先于邀请码校验（409）（main.py:593-600）                    |
| D13 | GET  admin/accounts      | limit/offset 越界 → 422（admin_accounts.py:56-57 Query ge/le）       | 静默钳位（ws_admin_accounts.py:65-66）                              |
| D14 | GET/PATCH admin/accounts | 403 体 `{"error","message"}`（auth_utils.py:18-21）                 | 403 体仅 `{"error"}`（ws_admin_accounts.py:31-33）                  |
| D15 | 多个 POST                | 422 体是**字符串** detail（手写校验）                               | 422 体是 Pydantic **列表** detail（状态码一致）                     |
| D16 | 受保护端点               | 401 体 `{"error","message"}`（core/auth.py:201-221）                | 401 体是字符串（main.py:137-150）                                   |

D1–D4、D6–D7、D9–D13 用 xfail 钉；D5、D8、D14–D16 用普通用例 + 注释点名。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import ws_admin_accounts  # noqa: E402,F401
import ws_teams  # noqa: E402
from kaas_common.workstation.subscriptions import all_workstations  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

# 注意：worker 侧**不**写 `pytestmark = pytest.mark.unit` —— 该环境没注册 `unit`
# 标记（同 test_admin_accounts.py:33 的说明），worker 的验收命令是整包 pytest。

_ORIGINAL_ACQUIRE = worker_main._acquire
_ORIGINAL_ADMIN_ACQUIRE = ws_admin_accounts._acquire

# ≥32 字节，避免 PyJWT 的 InsecureKeyLengthWarning 噪声
_TEST_JWT_SECRET = "parity-auth-test-secret-0123456789abcdef"
_SETUP_TOKEN = "parity-setup-token-0123456789"
_PASSWORD = "password123"
_PASSWORD_HASH = worker_main._hash_password(_PASSWORD)  # bcrypt 只算一次

_NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)

# ── 路由面（orchestrator 侧来源：app/api/auth.py、app/api/admin_accounts.py）──

AUTH_ROUTES = {
    ("/api/v1/auth/register", "POST"),
    ("/api/v1/auth/login", "POST"),
    ("/api/v1/auth/logout", "POST"),
    ("/api/v1/auth/me", "GET"),
    ("/api/v1/auth/bootstrap-admin", "POST"),
    ("/api/v1/auth/forgot-password", "POST"),
    ("/api/v1/auth/reset-password", "POST"),
}

ADMIN_ACCOUNT_ROUTES = {
    ("/api/v1/admin/accounts", "GET"),
    ("/api/v1/admin/accounts/{user_id}", "PATCH"),
}

# orchestrator `_account_out`（admin_accounts.py:36-50）允许的键集 —— 两端必须逐字一致
_ACCOUNT_KEYS = {
    "id", "email", "display_name", "account_type", "role", "status",
    "team_id", "team_name", "console_access", "created_at", "updated_at",
}

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


# ── 环境与桩连接 ─────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """每个用例独立：JWT_SECRET 固定、可选密钥清空、依赖覆盖与 _acquire 归位。"""
    monkeypatch.setenv("JWT_SECRET", _TEST_JWT_SECRET)
    monkeypatch.delenv("ADMIN_SETUP_TOKEN", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
    worker_main.app.dependency_overrides.clear()
    yield
    worker_main.app.dependency_overrides.clear()
    worker_main._acquire = _ORIGINAL_ACQUIRE
    ws_admin_accounts._acquire = _ORIGINAL_ADMIN_ACQUIRE


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按调用顺序吐预设结果，并记录全部 SQL（含绑定参数）。

    三种方法各自一条队列：``fetchrow`` / ``fetchval`` / ``fetch``。
    """

    def __init__(self, *, fetchrow=None, fetchval=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self._fetch = list(fetch or [])
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
        return "UPDATE 1"

    def transaction(self):
        return _FakeTxn()

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)

    def statements(self) -> list[str]:
        return [sql for sql, _ in self.calls]


class _DuplicateKeyConn(_FakeConn):
    """模拟 asyncpg 的唯一约束冲突（users.email 重复）。

    worker 的 bootstrap-admin 没有邮箱预检 ⇒ INSERT 撞库 → 异常冒到 CORS 中间件
    → 500（main.py:225-237 兜成 internal_error）。orchestrator 会先查重 → 409。
    """

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if sql.lstrip().startswith("INSERT INTO users"):
            raise RuntimeError(
                'duplicate key value violates unique constraint "users_email_key"')
        return self._fetchrow.pop(0) if self._fetchrow else None


@contextmanager
def _patched_main(conn, user=None):
    """把 main 的 `_acquire` 换成桩连接；可选注入依赖覆盖的当前用户。"""

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    worker_main._acquire = fake_acquire
    if user is not None:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        worker_main._acquire = _ORIGINAL_ACQUIRE
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


@contextmanager
def _patched_admin(conn, user=None):
    """ws_admin_accounts 在 import 期就把 `_acquire` 抓成模块全局，必须单独替换。"""

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    ws_admin_accounts._acquire = fake_acquire
    if user is not None:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        ws_admin_accounts._acquire = _ORIGINAL_ADMIN_ACQUIRE
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _as(user: dict) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _routes() -> set[tuple[str, str]]:
    out: set[tuple[str, str]] = set()
    for route in worker_main.app.routes:
        for method in getattr(route, "methods", None) or set():
            out.add((route.path, method))
    return out


# ── 造数 ────────────────────────────────────────────────────────────────────

def _login_row(**over):
    row = {
        "id": 5, "email": "buyer@qa.test", "password_hash": _PASSWORD_HASH,
        "display_name": "买家", "account_type": "customer", "role": "owner",
        "status": "active", "team_id": None, "console_access": False,
    }
    row.update(over)
    return row


def _user_row(**over):
    """register INSERT ... RETURNING 的形状（main.py:635-640）。"""
    row = {
        "id": 42, "email": "newbie@qa.test", "display_name": "新人",
        "account_type": "customer", "role": "owner", "status": "active",
    }
    row.update(over)
    return row


def _account_row(**over):
    row = {
        "id": 9, "email": "u9@qa.test", "display_name": "用户9",
        "account_type": "internal", "role": "user", "status": "active",
        "team_id": None, "console_access": False,
        "created_at": _NOW, "updated_at": _NOW, "team_name": None,
    }
    row.update(over)
    return row


def _invite_row(**over):
    row = {
        "id": 7, "team_id": 1, "status": "pending",
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
    }
    row.update(over)
    return row


def _register_body(**over):
    body = {
        "email": "newbie@qa.test", "password": _PASSWORD, "display_name": "新人",
        "product_category": "fencing",
    }
    body.update(over)
    return body


def _bootstrap_body(**over):
    body = {"email": "root@qa.test", "password": _PASSWORD, "display_name": "系统管理员"}
    body.update(over)
    return body


# ════════════════════════════════════════════════════════════════════════════
# 0. 路由面：路径 / 方法
# ════════════════════════════════════════════════════════════════════════════

def test_auth_route_surface_matches_orchestrator():
    """auth 域**恰好**这 7 条（多一条少一条都是漂移）。"""
    auth_routes = {pair for pair in _routes() if pair[0].startswith("/api/v1/auth")}
    assert auth_routes == AUTH_ROUTES


def test_admin_accounts_route_surface_matches_orchestrator():
    admin_routes = {
        pair for pair in _routes() if pair[0].startswith("/api/v1/admin/accounts")
    }
    assert admin_routes == ADMIN_ACCOUNT_ROUTES


# ════════════════════════════════════════════════════════════════════════════
# 1. POST /api/v1/auth/bootstrap-admin
# ════════════════════════════════════════════════════════════════════════════

def test_bootstrap_admin_503_when_setup_token_not_configured():
    """两端同口径：ADMIN_SETUP_TOKEN 未配置 → 503（main.py:278-280 / auth.py:355-356）。"""
    resp = client.post("/api/v1/auth/bootstrap-admin", json=_bootstrap_body())
    assert resp.status_code == 503
    assert "ADMIN_SETUP_TOKEN" in resp.json()["detail"]


def test_bootstrap_admin_requires_bearer_token(monkeypatch):
    """worker 现状：缺 Bearer 头 → 403（PARITY-DIFF-1；orchestrator 是 401）。

    证据：main.py:281-283 把「头缺失」和「码错误」并成同一个 403；
    orchestrator auth.py:369-371 先判断头前缀 → 401，再比对码 → 403。
    """
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    resp = client.post("/api/v1/auth/bootstrap-admin", json=_bootstrap_body())
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Invalid setup token"


def test_bootstrap_admin_rejects_wrong_token(monkeypatch):
    """两端一致：码错误 → 403（main.py:282-283 / auth.py:375-376）。"""
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    resp = client.post(
        "/api/v1/auth/bootstrap-admin",
        json=_bootstrap_body(),
        headers=_bearer("wrong-token"),
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Invalid setup token"


def test_bootstrap_admin_body_errors_precede_setup_checks():
    """PARITY-DIFF-5：worker 的 body 由 Pydantic 在进 handler **之前**校验。

    所以「ADMIN_SETUP_TOKEN 未配置 + 空 body」在 worker 得到 422，而 orchestrator
    （先 503 / 403 / 401、最后才读 body）得到 503。参数错误与鉴权/配置的先后顺序
    在两端是反的。这里锁 worker 现状（422 + 列表型 detail）。
    """
    resp = client.post("/api/v1/auth/bootstrap-admin", json={})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert isinstance(detail, list) and detail[0]["loc"] == ["body", "email"]


def test_bootstrap_admin_already_initialized_is_403(monkeypatch):
    """两端一致：已存在 system_admin → 403（main.py:286-290 / auth.py:358-366）。"""
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    conn = _FakeConn(fetchrow=[{"id": 1}])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/bootstrap-admin",
            json=_bootstrap_body(),
            headers=_bearer(_SETUP_TOKEN),
        )
    assert resp.status_code == 403
    assert "already initialized" in resp.json()["detail"]


def test_bootstrap_admin_creates_admin_with_nested_envelope(monkeypatch):
    """worker 现状：响应是 `{access_token, token_type, user{5 键}}`（PARITY-DIFF-4）。

    orchestrator 返回**扁平** 11 键（user_id/email/display_name/account_type/role/
    plan/team_id/team_name/console_access/access_token/token_type）。
    """
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    admin_row = {
        "id": 1, "email": "root@qa.test", "display_name": "系统管理员",
        "account_type": "internal", "role": "system_admin",
    }
    conn = _FakeConn(fetchrow=[None, admin_row])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/bootstrap-admin",
            json=_bootstrap_body(),
            headers=_bearer(_SETUP_TOKEN),
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"access_token", "token_type", "user"}
    assert body["token_type"] == "bearer"
    assert set(body["user"]) == {
        "id", "email", "display_name", "account_type", "role",
    }

    insert_sql = next(
        sql for sql, _ in conn.calls if sql.lstrip().startswith("INSERT INTO users")
    )
    # 反伪造：internal / system_admin / internal plan 全部是服务端硬编码
    assert "'internal'" in insert_sql and "'system_admin'" in insert_sql


# ── xfail：orchestrator 口径（修好后 XPASS ⇒ strict 让套件变红，提示摘标记）──

@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-1: orchestrator 缺 Bearer 头返回 401，worker 是 403")
def test_parity_diff_1_bootstrap_admin_missing_bearer_is_401(monkeypatch):
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    resp = client.post("/api/v1/auth/bootstrap-admin", json=_bootstrap_body())
    assert resp.status_code == 401


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-2: orchestrator 校验密码≥8 → 422，worker 不校验")
def test_parity_diff_2_bootstrap_admin_short_password_is_422(monkeypatch):
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    conn = _FakeConn(fetchrow=[None, {"id": 1, "email": "root@qa.test"}])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/bootstrap-admin",
            json=_bootstrap_body(password="short"),
            headers=_bearer(_SETUP_TOKEN),
        )
    assert resp.status_code == 422


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-3: orchestrator 邮箱重复 → 409，worker 无预检撞库 500")
def test_parity_diff_3_bootstrap_admin_duplicate_email_is_409(monkeypatch):
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    conn = _DuplicateKeyConn(fetchrow=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/bootstrap-admin",
            json=_bootstrap_body(),
            headers=_bearer(_SETUP_TOKEN),
        )
    assert resp.status_code == 409


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-4: orchestrator 响应扁平（含 plan/team_*），worker 嵌套 user")
def test_parity_diff_4_bootstrap_admin_flat_response(monkeypatch):
    monkeypatch.setenv("ADMIN_SETUP_TOKEN", _SETUP_TOKEN)
    admin_row = {
        "id": 1, "email": "root@qa.test", "display_name": "系统管理员",
        "account_type": "internal", "role": "system_admin",
    }
    conn = _FakeConn(fetchrow=[None, admin_row])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/bootstrap-admin",
            json=_bootstrap_body(),
            headers=_bearer(_SETUP_TOKEN),
        )
    assert set(resp.json()) == {
        "user_id", "email", "display_name", "account_type", "role", "plan",
        "team_id", "team_name", "console_access", "access_token", "token_type",
    }


# ════════════════════════════════════════════════════════════════════════════
# 2. POST /api/v1/auth/login
# ════════════════════════════════════════════════════════════════════════════

def test_login_success_envelope_is_nested_user(monkeypatch):
    """worker 现状：`{access_token, token_type, user{...}}`（PARITY-DIFF-6）。

    orchestrator 是**扁平** 11 键且含 `plan`（auth.py:139-159, 307）。
    前端 `lib/auth/auth-context.tsx:56-68` 的 buildUser 读的是扁平字段 ——
    目前被「登录后 window.location 跳转 + /auth/me 重新 buildUser」掩盖。
    """
    conn = _FakeConn(fetchrow=[_login_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "buyer@qa.test", "password": _PASSWORD}
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"access_token", "token_type", "user"}
    assert body["token_type"] == "bearer"
    user = body["user"]
    assert set(user) == {
        "id", "email", "display_name", "account_type", "role", "status",
        "team_id", "console_access", "user_id", "team_name",
    }
    assert user["user_id"] == user["id"]
    assert "password_hash" not in user
    assert "plan" not in user  # PARITY-DIFF-6：orchestrator 一定有 plan


def test_login_bad_password_and_unknown_user_are_401(monkeypatch):
    """两端一致（状态码）：坏密码 / 无此账号 → 401（main.py:310-313 / auth.py:297-298）。"""
    conn = _FakeConn(fetchrow=[_login_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "buyer@qa.test", "password": "wrong"}
        )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid credentials"

    conn = _FakeConn(fetchrow=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "ghost@qa.test", "password": _PASSWORD}
        )
    assert resp.status_code == 401


def test_login_disabled_account_is_401_in_worker(monkeypatch):
    """worker 现状：禁用账号 → 401（PARITY-DIFF-7；orchestrator 是 403）。

    证据：main.py:310-311 先判 `status != "active"` 再验密码，统一 401；
    orchestrator auth.py:300-301 密码通过后才判 status → 403 "Account is disabled"。
    """
    conn = _FakeConn(fetchrow=[_login_row(status="disabled")])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "buyer@qa.test", "password": _PASSWORD}
        )
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid credentials"


def test_login_does_not_strip_email_before_lookup():
    """worker 现状：只 `.lower()` 不 `.strip()`（PARITY-DIFF-8）。

    证据：main.py:308 直接把 `body.email.lower()` 绑进 SQL；orchestrator auth.py:289
    是 `(body.get("email") or "").strip().lower()`。带空白的邮箱在 worker 查不到人。
    """
    conn = _FakeConn(fetchrow=[_login_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login",
            json={"email": "  Buyer@QA.test  ", "password": _PASSWORD},
        )
    assert resp.status_code == 200
    lookup_sql, lookup_args = conn.calls[0]
    assert "FROM users WHERE email=$1" in lookup_sql
    assert lookup_args[0] == "  buyer@qa.test  "  # 只小写，空白原样进 SQL


def test_login_lowercases_email():
    """两端一致：邮箱大小写归一（main.py:308 → lower）。"""
    conn = _FakeConn(fetchrow=[_login_row()])
    with _patched_main(conn):
        client.post(
            "/api/v1/auth/login", json={"email": "BUYER@QA.TEST", "password": _PASSWORD}
        )
    _, args = conn.calls[0]
    assert args[0] == "buyer@qa.test"


def test_login_missing_fields_is_422():
    """两端同为 422，但错误体形状不同（PARITY-DIFF-15：Pydantic 列表 vs 字符串）。"""
    resp = client.post("/api/v1/auth/login", json={"email": "buyer@qa.test"})
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], list)


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-7: orchestrator 禁用账号返回 403，worker 是 401")
def test_parity_diff_7_login_disabled_account_is_403():
    conn = _FakeConn(fetchrow=[_login_row(status="disabled")])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "buyer@qa.test", "password": _PASSWORD}
        )
    assert resp.status_code == 403


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-6: orchestrator login 响应扁平且含 plan")
def test_parity_diff_6_login_flat_response_with_plan():
    conn = _FakeConn(fetchrow=[_login_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/login", json={"email": "buyer@qa.test", "password": _PASSWORD}
        )
    assert set(resp.json()) == {
        "user_id", "email", "display_name", "account_type", "role", "plan",
        "team_id", "team_name", "console_access", "access_token", "token_type",
    }


# ════════════════════════════════════════════════════════════════════════════
# 3. GET /api/v1/auth/me
# ════════════════════════════════════════════════════════════════════════════

def test_me_requires_credentials_401():
    """受保护端点：无凭据 401（不是 404）。错误体是字符串（PARITY-DIFF-16）。"""
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Missing bearer token"


def test_me_response_keys_worker_flat():
    """worker 现状：扁平 10 键（PARITY-DIFF-9）。

    orchestrator GET /me（auth.py:334-338）= 账号 9 键 + effective_role + tenant_id，
    其中 `plan` / `effective_role` 是前端 `hooks/use-role.ts:33-38` 直接消费的字段。
    worker 没有 effective_role ⇒ `effectiveRole` 退化成原始 role（历史 admin 不会被
    映射成 system_admin），也缺 plan / tenant_id；多出 id / status。
    """
    _as(CUSTOMER)
    resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "id", "email", "display_name", "account_type", "role", "status",
        "team_id", "console_access", "user_id", "team_name",
    }
    assert body["user_id"] == body["id"] == 3
    assert body["account_type"] == "customer"


def test_me_fetches_team_name_from_teams_table():
    """两端一致：team_name 来自 users.team_id → teams.name（main.py:322-328 / auth.py:132-136）。"""
    user = {**CUSTOMER, "team_id": 7}
    conn = _FakeConn(fetchrow=[{"name": "联佳丝网"}])
    with _patched_main(conn, user=user):
        resp = client.get("/api/v1/auth/me")
    assert resp.status_code == 200
    assert resp.json()["team_name"] == "联佳丝网"
    assert "FROM teams WHERE id=$1" in conn.calls[0][0]


def test_me_rejects_inactive_user():
    """两端一致（状态码）：token 有效但账号非 active → 401（main.py:148-150 / core/auth.py:197-202）。"""
    token = worker_main._create_token(3)
    conn = _FakeConn(fetchrow=[_login_row(status="disabled")])
    with _patched_main(conn):
        resp = client.get("/api/v1/auth/me", headers=_bearer(token))
    assert resp.status_code == 401
    assert resp.json()["detail"] == "User not found or inactive"


def test_me_rejects_invalid_token():
    """两端一致（状态码）：坏 token → 401（main.py:128-134 / core/auth.py:218-219）。"""
    resp = client.get("/api/v1/auth/me", headers=_bearer("not-a-jwt"))
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid token"


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-9: orchestrator /me 含 plan/effective_role/tenant_id")
def test_parity_diff_9_me_has_plan_effective_role_tenant_id():
    _as(CUSTOMER)
    resp = client.get("/api/v1/auth/me")
    body = resp.json()
    assert {"plan", "effective_role", "tenant_id"} <= set(body)


# ════════════════════════════════════════════════════════════════════════════
# 4. POST /api/v1/auth/logout（公开、无状态）
# ════════════════════════════════════════════════════════════════════════════

def test_logout_is_public_and_body_matches_orchestrator():
    """两端一致：无凭据也 200，响应体逐字相同（main.py:340-348 / auth.py:310-313）。"""
    resp = client.post("/api/v1/auth/logout")
    assert resp.status_code == 200
    assert resp.json() == {"message": "Logged out (client should discard token)"}


# ════════════════════════════════════════════════════════════════════════════
# 5. 忘记密码 / 重置密码（两端同契约）
# ════════════════════════════════════════════════════════════════════════════

def test_forgot_password_validation_422():
    """两端一致：缺 email / 无 @ → 422，detail 为同一句字符串（main.py:437-439）。"""
    for payload in ({"email": ""}, {"email": "no-at-sign"}):
        resp = client.post("/api/v1/auth/forgot-password", json=payload)
        assert resp.status_code == 422, payload
        assert resp.json()["detail"] == "validation_error: email is required"


def test_forgot_password_unknown_email_is_ok_and_writes_nothing():
    """两端一致：不泄露邮箱存在性 —— 未注册也 200，且不写 token 行。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/forgot-password", json={"email": "ghost@qa.test"}
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "message": "如果该邮箱已注册，重置链接已发送"}
    assert "INSERT INTO password_reset_tokens" not in conn.sql()


def test_forgot_password_active_user_writes_single_use_token():
    """两端一致：active 账号 → 先作废旧 token 再写新 token（main.py:446-459 / auth.py:450-460）。"""
    conn = _FakeConn(fetchrow=[{"id": 5, "email": "u5@qa.test", "status": "active"}])
    with _patched_main(conn):
        resp = client.post("/api/v1/auth/forgot-password", json={"email": "u5@qa.test"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert "UPDATE password_reset_tokens SET used_at=NOW()" in conn.sql()
    assert "INSERT INTO password_reset_tokens" in conn.sql()


def test_reset_password_validation_422():
    """两端一致：缺 token → 422；新密码 <8 → 422（main.py:473-479 / auth.py:471-478）。"""
    resp = client.post(
        "/api/v1/auth/reset-password",
        json={"token": "", "new_password": "newpassword1"},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "validation_error: token is required"

    resp = client.post(
        "/api/v1/auth/reset-password",
        json={"token": "some-token", "new_password": "short"},
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == "validation_error: Password must be at least 8 characters"


def test_reset_password_invalid_token_is_400_with_same_body():
    """两端一致：无效/过期/已用统一 400 + 同一错误体（main.py:490-494 / auth.py:480-485）。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/reset-password",
            json={"token": "nope", "new_password": "newpassword1"},
        )
    assert resp.status_code == 400
    assert resp.json()["detail"] == {
        "error": "invalid_token", "message": "重置链接无效或已过期，请重新申请",
    }


def test_reset_password_success_updates_hash_and_burns_tokens():
    """两端一致：写入新哈希、同用户其余 token 一并作废（main.py:495-503 / auth.py:487-489）。"""
    conn = _FakeConn(fetchrow=[{"token_id": 1, "user_id": 5, "status": "active"}])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/reset-password",
            json={"token": "good-token", "new_password": "newpassword1"},
        )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True, "message": "密码已重置，请用新密码登录"}
    assert "UPDATE users SET password_hash=$1" in conn.sql()
    assert "UPDATE password_reset_tokens SET used_at=NOW()" in conn.sql()


# ════════════════════════════════════════════════════════════════════════════
# 6. POST /api/v1/auth/register
# ════════════════════════════════════════════════════════════════════════════

def test_register_rejects_both_team_actions():
    """两端一致：邀请码 + 团队名同时给 → 422 TEAM_ACTION_CONFLICT（main.py:588-591）。"""
    resp = client.post(
        "/api/v1/auth/register", json=_register_body(invite_token="T", team_name="X")
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "error": "validation", "code": "TEAM_ACTION_CONFLICT",
        "detail": "只能二选一：凭邀请码加入现有团队，或新建一个团队",
    }


def test_register_field_rules_422_without_db():
    """字段规则（密码长度/分类白名单/邮箱格式）在建连接前校验，两端状态码一致。"""
    resp = client.post("/api/v1/auth/register", json=_register_body(password="short"))
    assert resp.status_code == 422
    resp = client.post(
        "/api/v1/auth/register", json=_register_body(product_category="nope")
    )
    assert resp.status_code == 422
    resp = client.post("/api/v1/auth/register", json=_register_body(email="not-an-email"))
    assert resp.status_code == 422


def test_register_required_fields_422_pydantic_shape():
    """PARITY-DIFF-15：worker 由 Pydantic 返回列表型 detail（orchestrator 是字符串）。"""
    resp = client.post(
        "/api/v1/auth/register",
        json={"email": "a@b.co", "password": _PASSWORD, "product_category": "fencing"},
    )
    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], list)


def test_register_duplicate_email_409():
    """两端一致：邮箱占用 → 409，detail 逐字相同（main.py:595-596 / auth.py:236-238）。"""
    conn = _FakeConn(fetchval=["taken"])
    with _patched_main(conn):
        resp = client.post("/api/v1/auth/register", json=_register_body())
    assert resp.status_code == 409
    assert resp.json()["detail"] == "conflict: Email already registered"


def test_register_plain_success_shape_and_anti_forgery():
    """worker 现状：扁平 10 键、无 plan（PARITY-DIFF-6 家族）；反伪造与 orchestrator 同。

    body 里的 account_type/role/plan 一律忽略，服务端硬编码 customer + free
    （main.py:636-640 / auth.py:243-252）。
    """
    conn = _FakeConn(fetchval=[None], fetchrow=[_user_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json={
                **_register_body(),
                "account_type": "internal",
                "role": "system_admin",
                "plan": "pro",
            },
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "user_id", "email", "display_name", "account_type", "role",
        "team_id", "team_name", "console_access", "access_token", "token_type",
    }
    assert body["account_type"] == "customer"
    assert body["role"] == "owner"
    assert body["team_id"] is None and body["team_name"] is None
    assert "plan" not in body  # PARITY-DIFF-6 家族：orchestrator 一定回 plan="free"

    insert_sql, insert_args = next(
        (sql, args) for sql, args in conn.calls
        if sql.lstrip().startswith("INSERT INTO users")
    )
    assert "'customer'" in insert_sql and "'free'" in insert_sql
    assert "system_admin" not in insert_args
    assert "internal" not in insert_args


def test_register_bad_invite_token_404():
    """两端一致：码不存在 → 404 INVITE_NOT_FOUND（main.py:605-607 / auth.py:264-266）。"""
    conn = _FakeConn(fetchval=[None], fetchrow=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(invite_token="NOPE")
        )
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "not_found", "code": "INVITE_NOT_FOUND"}


def test_register_invalid_team_name_422():
    """两端一致：团队名不合法 → 422（内核 code 直接透出）。"""
    conn = _FakeConn(fetchval=[None])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(team_name="长" * 41)
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_TEAM_NAME"


def test_register_team_name_taken_409():
    """两端一致：团队重名 → 409 TEAM_NAME_TAKEN（main.py:625-631 / teams.py:230-241）。"""
    conn = _FakeConn(fetchval=[None, "exists"])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(team_name="重复团队")
        )
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "TEAM_NAME_TAKEN"
    assert "已存在同名团队" in detail["message"]


def test_register_with_team_grants_chosen_workstations():
    """两端一致：显式工位清单 → 只开通这些（main.py:649-656 / auth.py:88-104）。"""
    conn = _FakeConn(
        fetchval=[None, None],
        fetchrow=[_user_row(), {"id": 3, "name": "新团队"}],
    )
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(team_name="新团队", workstations=["customers"]),
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["team_id"] == 3
    assert body["team_name"] == "新团队"
    subs = [args for sql, args in conn.calls if "INSERT INTO team_subscriptions" in sql]
    assert subs == [(3, "customers")]


def test_register_unknown_workstation_with_team_is_422():
    """两端一致（有 team_name 时）：未知工位 → 422 UNKNOWN_WORKSTATION，且不写订阅。"""
    conn = _FakeConn(
        fetchval=[None, None],
        fetchrow=[_user_row(), {"id": 3, "name": "新团队"}],
    )
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(team_name="新团队", workstations=["nope"]),
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "UNKNOWN_WORKSTATION"
    assert "INSERT INTO team_subscriptions" not in conn.sql()


def test_register_with_invite_joins_as_regular_member():
    """两端一致：凭码入队 → role=user，邀请标记 accepted，响应带团队名。

    （main.py:658-667 / auth.py:243, 264-265）
    """
    conn = _FakeConn(
        fetchval=[None],
        fetchrow=[_invite_row(), _user_row(role="user"), {"name": "联佳丝网"}],
    )
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(invite_token="INV-TOKEN")
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["role"] == "user"
    assert body["team_id"] == 1
    assert body["team_name"] == "联佳丝网"
    assert "UPDATE users SET team_id" in conn.sql()
    assert "UPDATE team_invites SET status='accepted'" in conn.sql()


# ── 差异登记（xfail / 现状钉死）─────────────────────────────────────────────

def test_register_unknown_workstation_without_team_is_silently_ignored():
    """worker 现状：**没有 team_name 时**未知工位被静默忽略（PARITY-DIFF-10）。

    根因：worker 只有在建团队分支里才调 `_resolve_signup_workstations`
    （main.py:649-681），而 orchestrator 在**解析请求体时**就校验（auth.py:198）。
    影响：带未知工位的注册请求，orchestrator 422，worker 200 —— 客户端拿到成功
    响应却不知道自己写错了工位 key。
    """
    conn = _FakeConn(fetchval=[None], fetchrow=[_user_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(workstations=["not_a_workstation"]),
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["team_id"] is None
    assert "team_subscriptions" not in conn.sql()


def test_resolve_signup_workstations_treats_empty_list_as_all():
    """worker 现状的根因（PARITY-DIFF-11）：`if not chosen` 把 `[]` 当"没传"。

    证据：ws_teams.py:198-215。orchestrator `_validate_workstations([])` 返回空
    frozenset，`_grant_signup_workstations` 见空集直接 return（auth.py:98-104）——
    即「传空数组 = 一个工位都不开」。
    """
    assert ws_teams._resolve_signup_workstations(None) == list(all_workstations())
    assert ws_teams._resolve_signup_workstations([]) == list(all_workstations())


def test_register_empty_workstations_opens_every_workstation():
    """worker 现状：`workstations: []` + 建团队 → 开通**全部 9 个**（PARITY-DIFF-11）。

    orchestrator 同请求只开通 0 个。前端 `lib/auth/types.ts:19` 明确写着
    「不传 ≠ 空数组：不传后端开通全部，传空数组会得到一个什么都用不了的团队」
    —— 即前端按 orchestrator 语义理解。
    """
    conn = _FakeConn(
        fetchval=[None, None],
        fetchrow=[_user_row(), {"id": 3, "name": "空白工位团队"}],
    )
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(team_name="空白工位团队", workstations=[]),
        )

    assert resp.status_code == 200, resp.text
    subs = [args for sql, args in conn.calls if "INSERT INTO team_subscriptions" in sql]
    assert len(subs) == len(all_workstations())  # worker：9 条；orchestrator：0 条


def test_register_duplicate_email_precedes_invite_validation():
    """worker 现状：邮箱占用先于邀请码校验（PARITY-DIFF-12）。

    证据：main.py:593-600 先查邮箱、后查邀请码；orchestrator auth.py:224-238
    先 resolve 邀请码（会 404/410/409），再查邮箱。同时给"已占用邮箱 + 坏邀请码"，
    worker 回 409（邮箱），orchestrator 回 404（INVITE_NOT_FOUND）。
    """
    conn = _FakeConn(fetchval=["taken"])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(invite_token="NOPE")
        )
    assert resp.status_code == 409
    assert resp.json()["detail"] == "conflict: Email already registered"


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-10: orchestrator 无 team_name 时也校验未知工位 → 422")
def test_parity_diff_10_register_unknown_workstation_is_422():
    conn = _FakeConn(fetchval=[None], fetchrow=[_user_row()])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(workstations=["not_a_workstation"]),
        )
    assert resp.status_code == 422


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-11: orchestrator 把 workstations=[] 当“零开通”")
def test_parity_diff_11_register_empty_workstations_grants_none():
    conn = _FakeConn(
        fetchval=[None, None],
        fetchrow=[_user_row(), {"id": 3, "name": "空白工位团队"}],
    )
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register",
            json=_register_body(team_name="空白工位团队", workstations=[]),
        )
    assert resp.status_code == 200
    assert "INSERT INTO team_subscriptions" not in conn.sql()


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-12: orchestrator 邀请码校验先于邮箱查重（404 优先）")
def test_parity_diff_12_register_invite_error_precedes_email_conflict():
    conn = _FakeConn(fetchval=["taken"])
    with _patched_main(conn):
        resp = client.post(
            "/api/v1/auth/register", json=_register_body(invite_token="NOPE")
        )
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "INVITE_NOT_FOUND"


# ════════════════════════════════════════════════════════════════════════════
# 7. GET  /api/v1/admin/accounts
# ════════════════════════════════════════════════════════════════════════════

def test_admin_accounts_requires_credentials_401():
    """鉴权先于取连接（不是 404）。错误体是字符串（PARITY-DIFF-16）。"""
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Missing bearer token"


def test_admin_accounts_forbidden_for_non_admin_body():
    """两端一致（状态码 403），错误体略有差异（PARITY-DIFF-14：orchestrator 多 message）。"""
    _as(INTERNAL_MEMBER)
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code == 403
    assert resp.json()["detail"] == {"error": "forbidden"}

    _as(CUSTOMER)
    resp = client.get("/api/v1/admin/accounts")
    assert resp.status_code == 403


def test_admin_accounts_list_shape_and_whitelist():
    """两端一致：`{accounts, total}` + 11 键白名单 + 角色映射（main.py:53-77 / admin_accounts.py:53-89）。"""
    conn = _FakeConn(
        fetchval=[2],
        fetch=[
            [
                _account_row(id=1, role="system_admin"),
                _account_row(id=2, role="admin", team_id=5, team_name="联佳丝网"),
            ]
        ],
    )
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.get("/api/v1/admin/accounts")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"accounts", "total"}
    assert body["total"] == 2
    assert set(body["accounts"][0]) == _ACCOUNT_KEYS
    assert set(body["accounts"][1]) == _ACCOUNT_KEYS
    # 历史 admin → system_admin（与 orchestrator effective_role 同源）
    assert body["accounts"][1]["role"] == "system_admin"
    assert body["accounts"][1]["team_name"] == "联佳丝网"
    assert all("password_hash" not in account for account in body["accounts"])
    assert all("token" not in account for account in body["accounts"])


def test_admin_accounts_list_clamps_pagination():
    """worker 现状：limit/offset 静默钳位（PARITY-DIFF-13）。

    证据：ws_admin_accounts.py:65-66 `max(1, min(limit,1000))` / `max(0, offset)`；
    orchestrator 用 Query(500, ge=1, le=1000) → 越界直接 422。
    """
    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.get("/api/v1/admin/accounts?limit=99999&offset=-5")
    assert resp.status_code == 200
    limit_sql, args = next((s, a) for s, a in conn.calls if "LIMIT $1 OFFSET $2" in s)
    assert args == (1000, 0)

    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.get("/api/v1/admin/accounts?limit=0")
    assert resp.status_code == 200
    _, args = next((s, a) for s, a in conn.calls if "LIMIT $1 OFFSET $2" in s)
    # `limit or 500`（ws_admin_accounts.py:65）会把 0 吞成默认 500；orchestrator 是 422
    assert args == (500, 0)


@pytest.mark.xfail(strict=True, reason="PARITY-DIFF-13: orchestrator 分页越界返回 422，worker 静默钳位")
def test_parity_diff_13_admin_list_out_of_range_is_422():
    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.get("/api/v1/admin/accounts?limit=99999")
    assert resp.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# 8. PATCH /api/v1/admin/accounts/{user_id}
# ════════════════════════════════════════════════════════════════════════════

def test_admin_patch_requires_credentials_401():
    resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})
    assert resp.status_code == 401


def test_admin_patch_forbidden_for_customer():
    _as(CUSTOMER)
    resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})
    assert resp.status_code == 403


def test_admin_patch_rejects_unknown_status_422():
    """两端一致：只接受 active|disabled，其余 422 + 同一错误体。"""
    _as(SYSTEM_ADMIN)
    resp = client.patch("/api/v1/admin/accounts/9", json={"status": "deleted"})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {
        "error": "validation_error", "message": "status must be active|disabled",
    }


def test_admin_patch_unknown_user_404():
    """两端一致：目标不存在 → 404 `{"error":"not_found"}`。"""
    conn = _FakeConn(fetchrow=[None])
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.patch("/api/v1/admin/accounts/999", json={"status": "disabled"})
    assert resp.status_code == 404
    assert resp.json()["detail"] == {"error": "not_found"}


def test_admin_patch_cannot_disable_self_409():
    """两端一致：禁停自己 → 409 SELF_PROTECT。"""
    conn = _FakeConn(fetchrow=[_account_row(id=1, role="system_admin")])
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.patch("/api/v1/admin/accounts/1", json={"status": "disabled"})
    assert resp.status_code == 409
    assert resp.json()["detail"] == {"error": "conflict", "code": "SELF_PROTECT"}


def test_admin_patch_cannot_disable_last_admin_409_with_for_update():
    """两端一致：最后一名 active 管理员 → 409 LAST_ADMIN，判定取自 FOR UPDATE 行锁。"""
    conn = _FakeConn(
        fetchrow=[_account_row(id=9, role="system_admin")],
        fetch=[[{"id": 9}]],
    )
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})

    assert resp.status_code == 409
    assert resp.json()["detail"] == {"error": "conflict", "code": "LAST_ADMIN"}
    lock_sql = next(sql for sql, _ in conn.calls if "FOR UPDATE" in sql)
    assert "count" not in lock_sql.lower()


def test_admin_patch_disable_writes_status_and_returns_account():
    """两端一致：停用写 status、响应 `{"account": 11 键}`。"""
    conn = _FakeConn(
        fetchrow=[
            _account_row(id=9, role="user", status="active"),
            _account_row(id=9, role="user", status="disabled"),
        ]
    )
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.patch("/api/v1/admin/accounts/9", json={"status": "disabled"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"account"}
    assert set(body["account"]) == _ACCOUNT_KEYS
    assert body["account"]["status"] == "disabled"
    assert "UPDATE users SET status=$2, updated_at=now()" in conn.sql()


def test_admin_patch_restore_writes_active_status():
    """两端一致：恢复（disabled → active）同样走写路径，且不受保护规则拦截。"""
    conn = _FakeConn(
        fetchrow=[
            _account_row(id=9, role="user", status="disabled"),
            _account_row(id=9, role="user", status="active"),
        ]
    )
    with _patched_admin(conn, SYSTEM_ADMIN):
        resp = client.patch("/api/v1/admin/accounts/9", json={"status": "active"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["account"]["status"] == "active"
    assert "FOR UPDATE" not in conn.sql()  # 恢复不需要锁管理员行


# ════════════════════════════════════════════════════════════════════════════
# 9. 鉴权前置顺序（未登录 vs 参数错误谁先返回）
# ════════════════════════════════════════════════════════════════════════════

def test_dependency_auth_precedes_body_validation():
    """依赖式鉴权（Depends）先于请求体校验 —— 与 orchestrator 同口径。

    无凭据 + 非法 body 必须是 401，而不是 422：否则等于告诉未登录者"参数长什么样"。
    """
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/admin/accounts").status_code == 401
    assert client.patch(
        "/api/v1/admin/accounts/9", json={"status": "not-a-status"}
    ).status_code == 401


def test_public_body_first_endpoints_are_auth_free():
    """login/register/forgot/reset 本来就没有前置鉴权，body 校验先于业务校验（两端一致）。"""
    assert client.post("/api/v1/auth/login", json={}).status_code == 422
    assert client.post("/api/v1/auth/register", json={}).status_code == 422
    assert client.post("/api/v1/auth/forgot-password", json={}).status_code == 422
    assert client.post("/api/v1/auth/reset-password", json={}).status_code == 422
