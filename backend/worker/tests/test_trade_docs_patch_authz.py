"""C27 / F2b（R-1 并入）：`PATCH /trade-docs/{id}` 的读+写闸门 —— 无数据库回归。

按 `docs/QA_AUTHZ_VERIFY_2026-10-21.md` §3 写矩阵：
- A1 改本团队 draft 字段：customer 成员（S4）**200**；
- A2 `draft→issued`（签发动作）：S4 **403 `TEAM_ADMIN_REQUIRED`**；
- A3 改已 issued 单：S4 **403**；
- 跨团队/历史 NULL/无团队：**404**（顺序 401→404→403→200/409）；
- internal 非管理员（S2）与团队管理员（S3）：允许。
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

S1_ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
S2_INTERNAL = {"id": 2, "account_type": "internal", "role": "user", "team_id": None}
S3_TEAM_ADMIN = {"id": 3, "account_type": "customer", "role": "owner", "team_id": 1}
S4_MEMBER = {"id": 4, "account_type": "customer", "role": "user", "team_id": 1}
S5_NO_TEAM = {"id": 5, "account_type": "customer", "role": "owner", "team_id": None}
S6_TEAM_B = {"id": 6, "account_type": "customer", "role": "owner", "team_id": 2}

_TS = datetime(2026, 10, 20, tzinfo=timezone.utc)


def _doc(doc_id: int, **over) -> dict:
    row = {
        "id": doc_id, "tenant_id": "default", "doc_no": f"PI-{doc_id:04d}",
        "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": None,
        "status": "draft", "currency": "USD", "total_amount": 100,
        "issued_at": None, "issued_by": None, "raw_payload": {},
        "created_at": _TS, "updated_at": _TS,
        "owner_id": None, "owner_scope": "private", "team_id": 1,
    }
    row.update(over)
    return row


DOC_A = _doc(1, owner_id="4", team_id=1)                       # 本团队 draft
DOC_A_ISSUED = _doc(2, owner_id="4", team_id=1, status="issued")
DOC_B = _doc(3, owner_id="6", team_id=2)
DOC_NULL = _doc(4, owner_id="99", team_id=None)
DOCS = {doc["id"]: doc for doc in (DOC_A, DOC_A_ISSUED, DOC_B, DOC_NULL)}
TEAM_CREATED_BY = {1: 3, 2: 6}          # team1 管理员 = S3 id 3；team2 = S6 id 6


class _FakeDb:
    def __init__(self) -> None:
        self.docs = {k: dict(v) for k, v in DOCS.items()}
        self.updates: list[tuple[str, tuple]] = []
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
            row = self.docs.get(params[1])
            return dict(row) if row else None
        if "FROM teams" in sql:
            created_by = TEAM_CREATED_BY.get(params[0])
            return {"created_by": created_by} if created_by is not None else None
        return None

    async def fetch(self, *args, table=None):
        self.calls.append(("fetch", *self._split(args)))
        return []

    async def fetchval(self, *args, table=None):
        self.calls.append(("fetchval", *self._split(args)))
        return None

    async def execute(self, *args):
        sql, params = self._split(args)
        self.calls.append(("execute", sql, params))
        self.updates.append((sql, params))
        if "UPDATE trade_docs SET" in sql:
            # 参数前两段固定是 (tenant, doc_id)；新状态永远是第 3 个参数
            self.docs[params[1]]["status"] = params[2]
        return "OK"


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


def _patch(doc_id: int, body: dict):
    return client.patch(f"/api/v1/trade-docs/{doc_id}", json=body)


def _doc_updates(fake: _FakeDb) -> int:
    return sum(1 for sql, _ in fake.updates if "UPDATE trade_docs SET" in sql)


# ── A1：改本团队 draft 字段 ────────────────────────────────────────────────

@pytest.mark.parametrize("user", [S1_ADMIN, S2_INTERNAL, S3_TEAM_ADMIN, S4_MEMBER],
                         ids=["S1", "S2", "S3", "S4"])
def test_a1_edit_draft_allowed_for_visible_team(user):
    with _patched(user) as fake:
        resp = _patch(1, {"currency": "EUR"})
    assert resp.status_code == 200, (user["email"], resp.text)
    assert _doc_updates(fake) == 1


@pytest.mark.parametrize("user", [S5_NO_TEAM, S6_TEAM_B], ids=["S5", "S6"])
def test_a1_cross_team_or_no_team_is_404_before_write(user):
    with _patched(user) as fake:
        resp = _patch(1, {"currency": "EUR"})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "DOC_NOT_FOUND"
    assert _doc_updates(fake) == 0


# ── A2：draft→issued（签发）仅团队管理员/internal ──────────────────────────

@pytest.mark.parametrize("user", [S1_ADMIN, S2_INTERNAL, S3_TEAM_ADMIN],
                         ids=["S1", "S2", "S3"])
def test_a2_issue_allowed_for_team_admin_or_internal(user):
    with _patched(user) as fake:
        resp = _patch(1, {"status": "issued"})
    assert resp.status_code == 200, (user["email"], resp.text)
    assert fake.docs[1]["status"] == "issued"


def test_a2_customer_member_issue_403_before_write():
    with _patched(S4_MEMBER) as fake:
        resp = _patch(1, {"status": "issued"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    assert _doc_updates(fake) == 0


@pytest.mark.parametrize("user", [S5_NO_TEAM, S6_TEAM_B], ids=["S5", "S6"])
def test_a2_cross_team_issue_404_before_403(user):
    with _patched(user) as fake:
        resp = _patch(1, {"status": "issued"})
    assert resp.status_code == 404, resp.text
    assert _doc_updates(fake) == 0


# ── A3：改已 issued 单 ─────────────────────────────────────────────────────

@pytest.mark.parametrize("user", [S1_ADMIN, S2_INTERNAL, S3_TEAM_ADMIN],
                         ids=["S1", "S2", "S3"])
def test_a3_edit_issued_allowed_for_team_admin_or_internal(user):
    with _patched(user):
        resp = _patch(2, {"currency": "EUR"})
    assert resp.status_code == 200, (user["email"], resp.text)


def test_a3_customer_member_edit_issued_403():
    with _patched(S4_MEMBER) as fake:
        resp = _patch(2, {"currency": "EUR"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    assert _doc_updates(fake) == 0


def test_a3_cross_team_edit_issued_404():
    with _patched(S6_TEAM_B) as fake:
        resp = _patch(2, {"currency": "EUR"})
    assert resp.status_code == 404, resp.text
    assert _doc_updates(fake) == 0


# ── 401 / 顺序 ─────────────────────────────────────────────────────────────

def test_no_token_401():
    with _patched(None) as fake:
        resp = _patch(1, {"currency": "EUR"})
    assert resp.status_code == 401
    assert _doc_updates(fake) == 0


def test_member_cannot_bypass_via_doc_no_on_issued_doc():
    """403（角色闸门）先于 409（DOC_NO_LOCKED）—— 不能靠改 doc_no 试探到业务码。"""
    with _patched(S4_MEMBER) as fake:
        resp = _patch(2, {"doc_no": "PI-HACK"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    assert _doc_updates(fake) == 0
