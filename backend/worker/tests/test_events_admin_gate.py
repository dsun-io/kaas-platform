"""`GET /api/v1/events` 平台运营闸门（前后端对齐审计 2026-10-20 · P1-1）—— 无数据库回归。

背景：前端 `/events` 整页在 `RouteGuard adminOnly` 里，但后端 `list_events_api`
此前只挂 `Depends(_get_current_user)` ⇒ **任意 customer token 都能读全租户事件**
（含其他客户 payload）。同文件 `_require_platform_ops`（`main.py:160-174`）已用在
6 个 `/api/v1/admin/*` 端点上 —— 事件审计漏网（审计见 `.tmp/align-report.md` §2 P1-1）。

本文件锁死：只有 **internal + 管理员角色** 能读事件列表，其余一律 403；
未登录仍是 401（鉴权先于授权，保持原语义）；管理员拿到的是原分页形状。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

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
    "role": "owner", "status": "active", "team_id": 5,
}


class _FakeDb:
    """冒充 platform/db：事件列表只用 fetchval(count) + fetch(rows)。"""

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append("fetch")
        return []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append("fetchrow")
        return None

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append("fetchval")
        return 0

    async def execute(self, request, sql, *args):
        self.calls.append("execute")
        return "OK"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    fake = _FakeDb()
    monkeypatch.setattr(worker_main, "db", fake)
    yield fake
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _as(user: dict | None) -> None:
    if user is None:
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)
    else:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


@pytest.mark.parametrize("user", [CUSTOMER, INTERNAL_MEMBER], ids=["customer", "internal-member"])
def test_non_platform_operator_gets_403(user, _setup):
    _as(user)
    resp = client.get("/api/v1/events")
    assert resp.status_code == 403, (user["account_type"], resp.text)
    assert resp.json()["detail"]["error"] == "forbidden", resp.text
    # 闸门在查库之前：非平台运营不应触发任何事件表查询（防"先查后拒"泄露形状）
    assert _setup.calls == [], _setup.calls


def test_no_token_still_401_before_403():
    """未登录先被鉴权拦（401），不是 403 —— 保持原语义。"""
    _as(None)
    resp = client.get("/api/v1/events")
    assert resp.status_code == 401, resp.text


def test_platform_admin_gets_paged_shape(_setup):
    _as(PLATFORM_ADMIN)
    resp = client.get("/api/v1/events")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {"items": [], "total": 0, "page": 1, "page_size": 20}
    assert "fetchval" in _setup.calls and "fetch" in _setup.calls


def test_platform_admin_paging_bounds_unchanged(_setup):
    """分页夹取语义不变：page<1 → 1，page_size>100 → 100（前端依赖此形状）。"""
    _as(PLATFORM_ADMIN)
    resp = client.get("/api/v1/events?page=0&page_size=999&event_type=audit")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["page"] == 1
    assert body["page_size"] == 100
