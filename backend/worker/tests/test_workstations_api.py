"""工位订阅：开通/撤销 + 未开通拦截（Worker 行为测试，无数据库）。

授权模型：业务不以租户鉴权，而是"这个团队/个人开通了哪些工位"。
这里验证最关键的一条：**未开通的工位 API 返回 404**，而账号/团队/订阅接口永远放行
（否则用户没法"去开通"，会死锁）。
"""
import os
import sys
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_workstations  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.workstation.subscriptions import (  # noqa: E402
    FULL_CHAIN, all_workstations, has_workstation, is_always_allowed, workstation_of,
)

# 中间件要解 token；worker 的 JWT 密钥按请求期从绑定/os.environ 读
os.environ["JWT_SECRET"] = "test-secret-workstation-0123456789abcdef"
client = TestClient(worker_main.app, raise_server_exceptions=True)


def _user(uid: int, role: str = "user", team_id=None) -> dict:
    """`_get_current_user` 会读整行（含 status），这里给全。"""
    return {"id": uid, "email": f"u{uid}@kaas.local", "display_name": f"用户{uid}",
            "account_type": "customer", "role": role, "status": "active",
            "team_id": team_id}


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按 SQL 关键词给结果，够中间件 + 客户详情路由跑通。"""

    def __init__(self, *, user=None, team_codes=(), user_codes=(), customer=None):
        self.user = user
        self.team_codes = list(team_codes)
        self.user_codes = list(user_codes)
        self.customer = customer
        self.executed: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        if "FROM users" in sql:
            return self.user
        if "FROM customers" in sql:
            return self.customer
        return None

    async def fetchval(self, sql, *args):
        return None

    async def fetch(self, sql, *args):
        if "team_subscriptions" in sql:
            return [{"code": c} for c in self.team_codes]
        if "user_subscriptions" in sql:
            return [{"code": c} for c in self.user_codes]
        return []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        return "UPDATE 1"

    def transaction(self):
        return _FakeTxn()


@contextmanager
def _patched(conn):
    """同时替换中间件与路由用的 `_acquire`（它们分属两个模块）。"""

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old_mw = ws_workstations._acquire
    old_main = worker_main._acquire
    ws_workstations._acquire = fake_acquire
    worker_main._acquire = fake_acquire
    ws_workstations._CODES_CACHE.clear()
    try:
        yield conn
    finally:
        ws_workstations._acquire = old_mw
        worker_main._acquire = old_main
        ws_workstations._CODES_CACHE.clear()


def _token(user_id: int) -> str:
    return worker_main._create_token(user_id, None)


def _customer_row():
    # team_id 与测试用户的团队一致（5），否则会被 §10.3 判定为不可见 → 404
    return {"id": 1, "tenant_id": "default", "name": "联佳丝网", "company_name": "联佳丝网",
            "owner_id": None, "owner_scope": "private", "team_id": 5, "is_deleted": False}


# ── 共享内核：路径 → 工位映射（判定真源，两端共用）─────────────────────────

def test_workstation_path_mapping():
    assert workstation_of("/api/v1/customers") == "customers"
    assert workstation_of("/api/v1/customers/12/inquiries") == "customers"
    assert workstation_of("/api/v1/trade-docs/3/render-data") == "trade-docs"
    assert workstation_of("/api/v1/orders/9/payment-schedules") == "orders"
    # 边界：/orders 不应把 /orders-x 也算进来
    assert workstation_of("/api/v1/orders-x") is None
    # 不属于任何收费工位
    assert workstation_of("/api/v1/healthcheck") is None
    # P2 内部 RPC 入口必须被**同一张映射表**覆盖（否则工位闸门放过未开通账号，
    # 2026-10-24 灰度实测踩到：新路径未登记 ⇒ 直接算出报价，绕过商业限制）。
    assert workstation_of("/api/v1/internal/engine/quote/calculate") == "quotes"
    assert workstation_of("/api/v1/internal/engine/quote/verify") == "quotes"


def test_always_allowed_paths_never_blocked():
    for path in ("/api/v1/auth/login", "/api/v1/teams/me",
                 "/api/v1/me/workstations", "/api/v1/admin/tenants", "/health"):
        assert is_always_allowed(path) is True, path


def test_full_chain_unlocks_every_workstation():
    codes = {FULL_CHAIN}
    for ws in all_workstations():
        assert has_workstation(codes, ws) is True, ws
    assert has_workstation(set(), "customers") is False


# ── 拦截中间件 ──────────────────────────────────────────────────────────────

def test_unsubscribed_workstation_returns_404():
    """没开通 customers 工位 → 访问客户接口 404（且带工位标识）。"""
    user = _user(9, team_id=5)
    with _patched(_FakeConn(user=user)):
        resp = client.get("/api/v1/customers/1",
                          headers={"Authorization": f"Bearer {_token(9)}"})
    assert resp.status_code == 404
    assert resp.json()["code"] == "WORKSTATION_NOT_SUBSCRIBED"
    assert resp.json()["workstation"] == "customers"


def test_team_subscription_unlocks_workstation():
    """团队开通 full_chain → 团队成员可以进入该工位（不再是 404 未开通）。"""
    user = _user(9, team_id=5)
    conn = _FakeConn(user=user, team_codes=[FULL_CHAIN], customer=_customer_row())
    with _patched(conn):
        resp = client.get("/api/v1/customers/1",
                          headers={"Authorization": f"Bearer {_token(9)}"})
    assert resp.status_code == 200
    assert resp.json().get("company_name") == "联佳丝网"


def test_personal_subscription_unlocks_workstation():
    """个人额外开通也能解锁（团队没有该工位时）。"""
    user = _user(9, team_id=5)
    conn = _FakeConn(user=user, team_codes=[], user_codes=["customers"],
                     customer=_customer_row())
    with _patched(conn):
        resp = client.get("/api/v1/customers/1",
                          headers={"Authorization": f"Bearer {_token(9)}"})
    assert resp.status_code == 200


def test_platform_admin_bypasses_subscription():
    user = _user(1, role="system_admin")
    conn = _FakeConn(user=user, customer=_customer_row())
    with _patched(conn):
        resp = client.get("/api/v1/customers/1",
                          headers={"Authorization": f"Bearer {_token(1)}"})
    assert resp.status_code == 200


def test_always_allowed_endpoint_not_blocked_by_middleware():
    """账号/团队/订阅类接口永远放行 —— 否则用户没法"去开通工位"。"""
    user = _user(9, team_id=5)
    conn = _FakeConn(user=user)
    with _patched(conn):
        resp = client.get("/api/v1/me/workstations",
                          headers={"Authorization": f"Bearer {_token(9)}"})
    assert resp.status_code == 200
    assert resp.json()["workstations"] == []          # 什么都没开通
    assert resp.json()["has_team"] is True


def test_request_without_token_is_left_to_route_auth():
    """没带 token 不由中间件拦（认证是路由依赖的职责）→ 路由自己回 401。"""
    with _patched(_FakeConn(user=_user(9, team_id=5))):
        resp = client.get("/api/v1/customers/1")
    assert resp.status_code == 401
