"""C27 / F3：confirm / pdf 角色闸门（团队管理员或 internal）—— 无数据库回归。

按 `docs/QA_AUTHZ_VERIFY_2026-10-21.md` §4：
- 顺序 **401 → 404（不可见/无团队）→ 403（可见但角色不足）→ 200/422/409（业务校验）**；
- customer 普通成员（S4）confirm/pdf 均 **403 `TEAM_ADMIN_REQUIRED`**；
- 跨团队（S6）与无团队（S5）**404**（可见性先于角色）；
- internal 非管理员（S2）与团队管理员（S3）放行到业务层（本测试用空单据断言不是 403）。
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

import ws_docs_ext  # noqa: E402
import ws_files  # noqa: E402
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
        "owner_id": "3", "owner_scope": "private", "team_id": 1,
    }
    row.update(over)
    return row


DOC_A = _doc(1, owner_id="3", team_id=1)
DOC_B = _doc(2, owner_id="6", team_id=2)
DOCS = {1: DOC_A, 2: DOC_B}
TEAM_CREATED_BY = {1: 3, 2: 6}


class _FakeDb:
    def __init__(self) -> None:
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
        return None

    async def fetch(self, *args, table=None):
        self.calls.append(("fetch", *self._split(args)))
        return []

    async def fetchval(self, *args, table=None):
        self.calls.append(("fetchval", *self._split(args)))
        return None

    async def execute(self, *args):
        self.calls.append(("execute", *self._split(args)))
        return "OK"

    def queried_tables(self) -> str:
        return "\n".join(sql for _, sql, _ in self.calls)


@contextmanager
def _patched(user: dict | None):
    fake = _FakeDb()

    @asynccontextmanager
    async def fake_acquire(request):
        yield fake

    old = {
        "main_db": worker_main.db,
        "ext_db": ws_docs_ext.db,
        "files_db": ws_files.db,
        "acquire": worker_main._acquire,
    }
    worker_main.db = fake
    ws_docs_ext.db = fake
    ws_files.db = fake
    worker_main._acquire = fake_acquire
    if user is None:
        worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)
    else:
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield fake
    finally:
        worker_main.db = old["main_db"]
        ws_docs_ext.db = old["ext_db"]
        ws_files.db = old["files_db"]
        worker_main._acquire = old["acquire"]
        worker_main.app.dependency_overrides.clear()


CONFIRM = "/api/v1/trade-docs/{doc_id}/confirm"
PDF = "/api/v1/trade-docs/{doc_id}/pdf"


# ── confirm ────────────────────────────────────────────────────────────────

def test_confirm_customer_member_403_before_business_queries():
    with _patched(S4_MEMBER) as fake:
        resp = client.post(CONFIRM.format(doc_id=1), json={})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    tables = fake.queried_tables()
    # 拒绝必须发生在读行项/事实之前（只允许 trade_docs + teams 两次查询）
    assert "trade_doc_items" not in tables
    assert fake.calls and len(fake.calls) <= 2, fake.calls


@pytest.mark.parametrize("user", [S5_NO_TEAM, S6_TEAM_B], ids=["S5-no-team", "S6-teamB"])
def test_confirm_cross_team_or_no_team_404_before_403(user):
    with _patched(user) as fake:
        resp = client.post(CONFIRM.format(doc_id=1), json={})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "DOC_NOT_FOUND"
    assert fake.calls and len(fake.calls) == 1, fake.calls


@pytest.mark.parametrize("user", [S2_INTERNAL, S3_TEAM_ADMIN], ids=["S2", "S3"])
def test_confirm_team_admin_or_internal_passes_gate(user):
    with _patched(user):
        resp = client.post(CONFIRM.format(doc_id=1), json={})
    # 空单据会在业务校验被拒（422/409），但**不是**角色闸门的 403
    assert resp.status_code != 403, resp.text
    assert resp.status_code in (409, 422), resp.text


def test_confirm_no_token_401():
    with _patched(None):
        resp = client.post(CONFIRM.format(doc_id=1), json={})
    assert resp.status_code == 401


# ── pdf ────────────────────────────────────────────────────────────────────

def test_pdf_customer_member_403_before_render():
    with _patched(S4_MEMBER) as fake:
        resp = client.post(PDF.format(doc_id=1), json={"html": "<p>x</p>"})
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"
    assert fake.calls and len(fake.calls) <= 2, fake.calls


@pytest.mark.parametrize("user", [S5_NO_TEAM, S6_TEAM_B], ids=["S5-no-team", "S6-teamB"])
def test_pdf_cross_team_or_no_team_404(user):
    with _patched(user):
        resp = client.post(PDF.format(doc_id=1), json={"html": "<p>x</p>"})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "DOC_NOT_FOUND"


@pytest.mark.parametrize("user", [S1_ADMIN, S2_INTERNAL, S3_TEAM_ADMIN],
                         ids=["S1", "S2", "S3"])
def test_pdf_privileged_passes_gate(user):
    with _patched(user):
        resp = client.post(PDF.format(doc_id=1), json={"html": "<p>x</p>"})
    # 测试环境没有 Browser Rendering / REST token ⇒ 503；关键是没被角色闸门拦
    assert resp.status_code == 503, resp.text
    assert resp.json()["detail"]["code"] == "PDF_RENDERER_NOT_CONFIGURED"


def test_pdf_no_token_401():
    with _patched(None):
        resp = client.post(PDF.format(doc_id=1), json={"html": "<p>x</p>"})
    assert resp.status_code == 401
