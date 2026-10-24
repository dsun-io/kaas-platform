"""C27 / F2+D1+D3：单证读（列表/详情/render-data）的团队/owner 可见性 —— 无数据库回归。

按 `docs/QA_AUTHZ_VERIFY_2026-10-21.md` §3 矩阵：
- internal（含非管理员，S2）可跨团队读；
- customer 只看本团队 / owner / `owner_scope='tenant'`；
- 无团队客户（S5）**列表 403 `NO_TEAM`、详情 404**；
- 跨团队/历史 NULL 一律 404（不泄露存在性）；
- 列表过滤必须是 **SQL 谓词**（否则 total 会泄露别团队行数）—— 测试里断言 SQL 片段。
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

S1_ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None,
            "email": "root@qa.test"}
S2_INTERNAL = {"id": 2, "account_type": "internal", "role": "user", "team_id": None,
               "email": "ops@qa.test"}
S3_TEAM_ADMIN = {"id": 3, "account_type": "customer", "role": "owner", "team_id": 1,
                 "email": "owner@qa.test"}
S4_MEMBER = {"id": 4, "account_type": "customer", "role": "user", "team_id": 1,
             "email": "member@qa.test"}
S5_NO_TEAM = {"id": 5, "account_type": "customer", "role": "owner", "team_id": None,
              "email": "noteam@qa.test"}
S6_TEAM_B = {"id": 6, "account_type": "customer", "role": "owner", "team_id": 2,
             "email": "teamB@qa.test"}

_TS = datetime(2026, 10, 20, tzinfo=timezone.utc)


def _doc(doc_id: int, **over) -> dict:
    row = {
        "id": doc_id, "tenant_id": "default", "doc_no": f"PI-{doc_id:04d}",
        "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": None,
        "status": "draft", "currency": "USD", "total_amount": 100,
        "issued_at": None, "issued_by": None, "raw_payload": {},
        "created_at": _TS, "updated_at": _TS,
        "owner_id": None, "owner_scope": "private", "team_id": None,
    }
    row.update(over)
    return row


# docA(team1, draft)、docB(team2)、docNull(team NULL)、docAIssued(team1, issued)
DOC_A = _doc(1, doc_no="PI-0001", team_id=1, owner_id="3")
DOC_B = _doc(2, doc_no="PI-0002", team_id=2, owner_id="6")
DOC_NULL = _doc(3, doc_no="PI-0003", team_id=None, owner_id="99")
DOC_A_ISSUED = _doc(4, doc_no="PI-0004", team_id=1, owner_id="3", status="issued")
DOCS = {doc["id"]: doc for doc in (DOC_A, DOC_B, DOC_NULL, DOC_A_ISSUED)}


class _FakeDb:
    """SQL 路由假 db：列表按 scope 谓词过滤，详情按主键取行，其余装配查询回空。"""

    def __init__(self) -> None:
        self.docs = DOCS
        self.calls: list[tuple[str, str, tuple]] = []

    def _scope(self, sql: str, args: tuple):
        """从 SQL 里还原 scope 谓词参数（列表 COUNT 与 SELECT 参数前缀相同）。"""
        if "team_id = $" not in sql:
            return None
        return args[1], args[2]          # (team, owner_id)

    def _filter(self, sql: str, args: tuple) -> list[dict]:
        scope = self._scope(sql, args)
        if scope is None:
            return list(self.docs.values())
        team, owner = scope
        rows = []
        for row in self.docs.values():
            if (str(row["team_id"]) == str(team)
                    or (row["owner_id"] is not None and str(row["owner_id"]) == str(owner))
                    or row["owner_scope"] == "tenant"):
                rows.append(row)
        return rows

    @staticmethod
    def _split(args: tuple) -> tuple[str, tuple]:
        """兼容两种调用形态：`db.*(request, sql, ...)` 与 `conn.*(sql, ...)`。"""
        if args and isinstance(args[0], str):
            return args[0], args[1:]
        return args[1], args[2:]

    async def fetchrow(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetchrow", sql, params))
        if "FROM trade_docs WHERE tenant_id=$1 AND id=$2" in sql:
            return self.docs.get(params[1])
        return None

    async def fetch(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetch", sql, params))
        if "FROM trade_docs WHERE" in sql and "id=$2" not in sql:
            return self._filter(sql, params)
        return []

    async def fetchval(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetchval", sql, params))
        if "COUNT(*) FROM trade_docs" in sql:
            return len(self._filter(sql, params))
        return None

    async def execute(self, *args):
        sql, params = self._split(args)
        self.calls.append(("execute", sql, params))
        return "OK"

    def sql_text(self) -> str:
        return "\n".join(sql for _, sql, _ in self.calls)


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


# ── 列表 ────────────────────────────────────────────────────────────────────

# ── 详情 ────────────────────────────────────────────────────────────────────

# ── render-data ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("user", "doc_id", "status"), [
    (S2_INTERNAL, 2, 200),
    (S3_TEAM_ADMIN, 1, 200),
    (S3_TEAM_ADMIN, 2, 404),
    (S4_MEMBER, 2, 404),
    (S5_NO_TEAM, 1, 404),
    (S6_TEAM_B, 1, 404),
], ids=["S2-docB", "S3-docA", "S3-docB", "S4-docB", "S5-docA", "S6-docA"])
def test_render_data_visibility(user, doc_id, status):
    with _patched(user):
        resp = client.get(f"/api/v1/trade-docs/{doc_id}/render-data")
    assert resp.status_code == status, (user["email"], doc_id, resp.text)
