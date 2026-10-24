"""C27 / F1+D5：AI 配置（读 + 写/执行）必须平台运营 admin-only —— 无数据库回归。

背景（`docs/QA_AUTHZ_AUDIT_2026-10-21.md`）：`chain.py` 的 8 个 `/ai/*` 端点此前
只挂 `Depends(_get_current_user)`，任意登录账号（包括 customer）都能读服务商密钥掩码、
改 `base_url`、跑任务。Lead 裁决 D5：**读端点也收紧**（`GET /ai/tasks` 默认收紧）。

本文件按 `docs/QA_AUTHZ_VERIFY_2026-10-21.md` §2 矩阵钉：
- S1（internal + 管理员）⇒ 200；
- S2（internal 非管理员）/S3（customer 团队管理员）/S4（customer 成员）⇒ 403 `forbidden`；
- S7（无凭据）⇒ 401（鉴权先于 403）。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import chain  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

S1_ADMIN = {"id": 1, "email": "root@qa.test", "account_type": "internal",
            "role": "system_admin", "team_id": None}
S2_INTERNAL = {"id": 2, "email": "ops@qa.test", "account_type": "internal",
               "role": "user", "team_id": None}
S3_TEAM_ADMIN = {"id": 3, "email": "owner@qa.test", "account_type": "customer",
                 "role": "owner", "team_id": 10}
S4_MEMBER = {"id": 4, "email": "member@qa.test", "account_type": "customer",
             "role": "user", "team_id": 10}

READ_ENDPOINTS = (
    ("get", "/api/v1/ai/tasks", None),
    ("get", "/api/v1/ai/providers", None),
    ("get", "/api/v1/ai/task-bindings", None),
    ("get", "/api/v1/ai/usage", None),
)
WRITE_ENDPOINTS = (
    ("put", "/api/v1/ai/providers/deepseek", {"model": "deepseek-chat"}),
    ("post", "/api/v1/ai/providers/deepseek/test", None),
    ("put", "/api/v1/ai/task-bindings/config_validation", {"enabled": False}),
    ("post", "/api/v1/ai/tasks/config_validation/run", {"payload": {}}),
)
ALL_ENDPOINTS = READ_ENDPOINTS + WRITE_ENDPOINTS
# P3 步骤3（2026-10-24）：以下 GET handler 已删除（门面已放量，off 回退改为回滚代码）；
# 内核不再注册这些路由 ⇒ 从「期望路由面/鉴权矩阵」里减去，而不是放宽断言。
ALL_ENDPOINTS = [
    item for item in ALL_ENDPOINTS
    if item[1] not in ("/api/v1/ai/providers", "/api/v1/ai/usage")
]



class _FakeDb:
    """8 个端点的 db 依赖：列表/绑定/用量走 fetch，单行走 fetchrow/fetchval。"""

    def __init__(self) -> None:
        self.calls = 0

    async def fetch(self, request, sql, *args, table=None):
        self.calls += 1
        return []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls += 1
        return {
            "provider": "deepseek", "api_key": "sk-test", "model": None,
            "base_url": None, "enabled": False, "id": 1,
        }

    async def fetchval(self, request, sql, *args, table=None):
        self.calls += 1
        return 0

    async def execute(self, request, sql, *args):
        self.calls += 1
        return "OK"


class _FakeConn:
    async def fetch(self, sql, *args):
        return []

    async def fetchrow(self, sql, *args):
        return {
            "provider": "deepseek", "api_key": "sk-test", "model": None,
            "base_url": None, "enabled": False, "id": 1,
        }

    async def fetchval(self, sql, *args):
        return 0

    async def execute(self, sql, *args):
        return "OK"

    def transaction(self):
        class _Tx:
            async def __aenter__(self_inner):
                return self_inner

            async def __aexit__(self_inner, *exc):
                return False

        return _Tx()


@contextmanager
def _patched(user: dict | None):
    fake_db = _FakeDb()
    fake_conn = _FakeConn()

    @asynccontextmanager
    async def fake_acquire(request):
        yield fake_conn

    old_db, old_acquire = worker_main.db, worker_main._acquire
    old_chain_acquire, old_chain_chat = chain._acquire, chain._openai_chat
    old_run = chain.run_ai_task

    async def fake_chat(*args, **kwargs):
        return "ok", {}

    async def fake_run(conn, task_key, payload):
        return {"task_key": task_key, "path": "template", "ok": True}

    worker_main.db = fake_db
    worker_main._acquire = fake_acquire
    chain._acquire = fake_acquire
    chain._openai_chat = fake_chat
    chain.run_ai_task = fake_run
    if user is None:
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)
    else:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield fake_db
    finally:
        worker_main.db = old_db
        worker_main._acquire = old_acquire
        chain._acquire = old_chain_acquire
        chain._openai_chat = old_chain_chat
        chain.run_ai_task = old_run
        worker_main.app.dependency_overrides.clear()


def _call(method: str, path: str, body):
    fn = getattr(client, method)
    if body is not None and method in ("put", "post"):
        return fn(path, json=body)
    return fn(path)


@pytest.mark.parametrize("user", [S2_INTERNAL, S3_TEAM_ADMIN, S4_MEMBER],
                         ids=["internal-member", "customer-team-admin", "customer-member"])
@pytest.mark.parametrize("method,path,body", ALL_ENDPOINTS)
def test_non_platform_operator_gets_403(user, method, path, body):
    with _patched(user) as db:
        resp = _call(method, path, body)
    assert resp.status_code == 403, (user["account_type"], method, path, resp.text)
    assert resp.json()["detail"]["error"] == "forbidden", (method, path, resp.text)
    assert db.calls == 0, f"{method} {path} 拒绝必须发生在查库/执行之前"


@pytest.mark.parametrize("method,path,body", ALL_ENDPOINTS)
def test_no_token_401_before_403(method, path, body):
    with _patched(None):
        resp = _call(method, path, body)
    assert resp.status_code == 401, (method, path, resp.text)


@pytest.mark.parametrize("method,path,body", ALL_ENDPOINTS)
def test_platform_admin_allowed(method, path, body):
    with _patched(S1_ADMIN):
        resp = _call(method, path, body)
    assert resp.status_code not in (401, 403), (method, path, resp.text)
    assert resp.status_code == 200, (method, path, resp.text)
