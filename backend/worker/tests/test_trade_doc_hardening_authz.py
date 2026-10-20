"""C27b：单证加固**写**端点角色闸门（团队管理员 / internal）—— 无数据库回归。

用户 2026-10-21 拍板：facts confirm / doc-set PUT / receipts POST / verify-export
（以及同族的 doc-set 回执登记）必须限团队管理员或 internal；普通客户成员 403
`TEAM_ADMIN_REQUIRED`，跨团队/无团队 404（可见性先判），未登录 401。
读端点（GET facts/doc-set/receipts）不受影响 —— 由既有 `test_trade_doc_hardening_api.py` /
`test_trade_doc_packing_api.py` 的 200 断言守住。
"""
from __future__ import annotations

import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

S1_ADMIN = {"id": 1, "email": "root@qa.test", "account_type": "internal", "role": "system_admin", "team_id": None}
S2_INTERNAL = {"id": 2, "email": "ops@qa.test", "account_type": "internal", "role": "user", "team_id": None}
S3_TEAM_ADMIN = {"id": 3, "email": "owner@qa.test", "account_type": "customer", "role": "owner", "team_id": 1}
S4_MEMBER = {"id": 4, "email": "member@qa.test", "account_type": "customer", "role": "user", "team_id": 1}
S5_NO_TEAM = {"id": 5, "email": "noteam@qa.test", "account_type": "customer", "role": "owner", "team_id": None}
S6_TEAM_B = {"id": 6, "email": "teamB@qa.test", "account_type": "customer", "role": "user", "team_id": 2}

_TS = datetime(2026, 10, 20, tzinfo=timezone.utc)


def _doc(doc_id: int, **over) -> dict:
    row = {
        "id": doc_id, "tenant_id": "default", "doc_no": f"PI-{doc_id:04d}",
        "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": None,
        "status": "draft", "currency": "USD", "total_amount": 100,
        "issued_at": None, "issued_by": None, "raw_payload": {},
        "created_at": _TS, "updated_at": _TS,
        "owner_id": "3", "owner_scope": "private", "team_id": 1,
    }
    row.update(over)
    return row


DOC_A = _doc(1, team_id=1, owner_id="3")
DOC_B = _doc(2, team_id=2, owner_id="6")
DOCS = {1: DOC_A, 2: DOC_B}
TEAM_CREATED_BY = {1: 3, 2: 99}


class _FakeDb:
    def __init__(self) -> None:
        self.writes: list[tuple[str, tuple]] = []
        self.calls: list[tuple[str, str, tuple]] = []

    @staticmethod
    def _split(args: tuple) -> tuple[str, tuple]:
        if args and isinstance(args[0], str):
            return args[0], args[1:]
        return args[1], args[2:]

    async def fetchrow(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetchrow", sql, params))
        if "FROM trade_docs WHERE tenant_id=$1 AND id=$2" in sql:
            return DOCS.get(params[1])
        if "FROM teams" in sql:
            created_by = TEAM_CREATED_BY.get(params[0])
            return {"created_by": created_by} if created_by is not None else None
        if "INSERT INTO trade_doc_receipts" in sql:
            return {
                "id": 9, "doc_id": params[1], "schedule_type": params[2],
                "schedule_amount": params[3], "received_amount": params[4],
                "currency": params[5], "received_at": params[6],
                "bank_ref": params[7], "diff": params[8],
                "diff_reason": params[9], "fx_rate_used": params[10],
                "status": params[11], "notes": params[12], "created_by": params[13],
                "created_at": _TS,
            }
        if "UPDATE trade_doc_doc_set_items" in sql:
            return {
                "doc_type": params[2], "role": "required", "issuer": "ours",
                "trigger_expr": None, "evidence_required": False,
                "status": params[3], "waived_reason": params[4],
                "received_doc_id": params[5], "received_at": _TS,
            }
        return None

    async def fetch(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetch", sql, params))
        return []

    async def fetchval(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetchval", sql, params))
        return None

    async def execute(self, *args):
        sql, params = self._split(args)
        self.calls.append(("execute", sql, params))
        self.writes.append((sql, params))
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
    fake = _FakeDb()

    @asynccontextmanager
    async def fake_acquire(request):
        yield fake

    old_db, old_acquire = worker_main.db, worker_main._acquire
    worker_main.db = fake
    worker_main._acquire = fake_acquire
    if user is None:
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)
    else:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield fake
    finally:
        worker_main.db = old_db
        worker_main._acquire = old_acquire
        worker_main.app.dependency_overrides.clear()


# 5 条写端点（含 doc-set 回执登记这一同族写口）
WRITE_CALLS = (
    ("post", "/api/v1/trade-docs/1/facts/confirm", {}),
    ("put", "/api/v1/trade-docs/1/doc-set", {"items": []}),
    ("post", "/api/v1/trade-docs/1/receipts", {"received_amount": "100"}),
    ("post", "/api/v1/trade-docs/1/verify-export",
     {"texts": [], "image_counts": {"stamp": 1}}),
    ("post", "/api/v1/trade-docs/1/doc-set/pl/receipt",
     {"action": "waive", "waived_reason": "不需要"}),
)


def _call(method: str, path: str, body: dict):
    fn = getattr(client, method)
    return fn(path, json=body)


def _success_status(path: str) -> int:
    """`POST receipts` 语义是 201（创建）；其余写端点 200。"""
    return 201 if path.endswith("/receipts") else 200


@pytest.mark.parametrize("method,path,body", WRITE_CALLS)
def test_customer_member_403_before_write(method, path, body):
    with _patched(S4_MEMBER) as fake:
        resp = _call(method, path, body)
    assert resp.status_code == 403, (method, path, resp.text)
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    assert fake.writes == [], (method, path, fake.writes)


@pytest.mark.parametrize("method,path,body", WRITE_CALLS)
@pytest.mark.parametrize("user", [S5_NO_TEAM, S6_TEAM_B], ids=["S5-no-team", "S6-teamB"])
def test_cross_team_or_no_team_404_before_403(user, method, path, body):
    with _patched(user) as fake:
        resp = _call(method, path, body)
    assert resp.status_code == 404, (user["email"], method, path, resp.text)
    assert resp.json()["detail"]["code"] == "DOC_NOT_FOUND"
    assert fake.writes == []


@pytest.mark.parametrize("method,path,body", WRITE_CALLS)
def test_no_token_401(method, path, body):
    with _patched(None) as fake:
        resp = _call(method, path, body)
    assert resp.status_code == 401, (method, path)
    assert fake.writes == []


@pytest.mark.parametrize("method,path,body", WRITE_CALLS)
@pytest.mark.parametrize("user", [S1_ADMIN, S2_INTERNAL, S3_TEAM_ADMIN],
                         ids=["S1-admin", "S2-internal", "S3-team-admin"])
def test_privileged_passes_gate(user, method, path, body):
    with _patched(user) as fake:
        resp = _call(method, path, body)
    assert resp.status_code == _success_status(path), (
        user["email"], method, path, resp.text)
    assert resp.status_code != 403
