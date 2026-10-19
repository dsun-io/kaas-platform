"""平台管理端点鉴权（安全审查 2026-10-19 · 高-1）—— 无数据库回归。

背景：`main.py` 的 6 个 `/api/v1/admin/*` 端点此前只挂 `Depends(_get_current_user)`，
任意 **customer** 账号都能写 feature flag / 读审计日志；前端仅按 `account_type==='internal'`
隐藏入口（route-guard.tsx），属「前端隐藏、后端不校验」。
本文件锁死：这 6 个端点必须是 **internal + 管理员角色**，其余一律 403。
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

ENDPOINTS = (
    ("get", "/api/v1/admin/feature_flag", None),
    ("post", "/api/v1/admin/feature_flag", {"flag_name": "use_v2", "flag_value": True}),
    ("get", "/api/v1/admin/tenants", None),
    ("post", "/api/v1/admin/tenants/reload", None),
    ("get", "/api/v1/admin/audit-log", None),
    ("get", "/api/v1/admin/archive-logs", None),
)


class _FakeDb:
    """冒充 platform/db：这些端点只用到 fetch/fetchrow/fetchval/execute。"""

    async def fetch(self, request, sql, *args, table=None):
        return []

    async def fetchrow(self, request, sql, *args, table=None):
        return {"id": 1, "flag_value": False}

    async def fetchval(self, request, sql, *args, table=None):
        return 0

    async def execute(self, request, sql, *args):
        return "INSERT 0 1"


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    worker_main.db = _FakeDb()
    yield
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _as(user: dict | None) -> None:
    if user is None:
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)
    else:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _call(method: str, path: str, body):
    if method == "post":
        return client.post(path, json=body) if body is not None else client.post(path)
    return client.get(path)


@pytest.mark.parametrize("user", [CUSTOMER, INTERNAL_MEMBER], ids=["customer", "internal-member"])
def test_non_platform_operator_gets_403(user):
    _as(user)
    for method, path, body in ENDPOINTS:
        resp = _call(method, path, body)
        assert resp.status_code == 403, (user["account_type"], method, path, resp.text)
        assert resp.json()["detail"]["error"] == "forbidden", (method, path, resp.text)


def test_no_token_still_401_before_403():
    """未登录先被鉴权拦（401），不是 403 —— 保持原语义。"""
    _as(None)
    for method, path, body in ENDPOINTS:
        resp = _call(method, path, body)
        assert resp.status_code == 401, (method, path, resp.text)


def test_platform_admin_allowed():
    _as(PLATFORM_ADMIN)
    for method, path, body in ENDPOINTS:
        resp = _call(method, path, body)
        assert resp.status_code == 200, (method, path, resp.text)


def test_feature_flag_write_by_admin_records_actor():
    _as(PLATFORM_ADMIN)
    resp = client.post(
        "/api/v1/admin/feature_flag",
        json={"flag_name": "use_v2", "flag_value": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["flag_name"] == "use_v2"
    assert body["new_value"] is True
