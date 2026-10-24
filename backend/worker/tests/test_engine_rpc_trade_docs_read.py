"""P3 第五批切片金标：GET /api/v1/trade-docs（列表）+ /{doc_id}（详情）旧 vs 新。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §8（切片范式）；与前几批同范式。

本文件锁七件事：
1. **提取不变**（main.py 的 handler 抽成纯投影是行为不变的）：旧路径响应 == fixture.response，
   且旧路径实际执行的 SQL 文本/绑定参数/顺序 == fixture.old_sql（含**逐行的链路更晚单证检查**）；
2. 新路径（供数 RPC）响应 == fixture.response，并且**零 DB 调用**；
3. 读闸门复用同一份：列表 403 NO_TEAM（无团队）、详情 404 DOC_NOT_FOUND（不存在/不可见/无团队）
   —— old body == new body；门面 SQL 谓词只是下推，内核 _doc_visible 再判一次；
4. 时间戳口径（docs §8.9）：零微秒 ⇒ 无小数；非零 ⇒ 6 位；
5. NUMERIC 归一：total_amount 是 float（与旧路径 FastAPI 序列化 Decimal 同口径）；
6. render_check：无对账记录 ⇒ null（不是 false）；有记录 ⇒ 四个字段齐全；
7. 一处实现：两个 RPC 函数只做投影接线，旧 handler 与 RPC 调用同一份纯投影。

fixture 由旧路径生成（backend/ts-migration/golden/gen_engine_trade_docs_read_fixtures.py）；
TS 侧 tests/engine-trade-docs-read.test.ts 读**同一份**文件。
⇒ 任一侧供数/投影语义漂移都会在 CI 变红；**禁止**在测试里自更新 fixture。
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import ws_workstations  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2]
GOLDEN = BACKEND / "ts-migration" / "golden"
LIST_FIXTURE = json.loads(
    (GOLDEN / "engine-trade-docs-list.fixture.json").read_text(encoding="utf-8"))
DETAIL_FIXTURE = json.loads(
    (GOLDEN / "engine-trade-docs-detail.fixture.json").read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
ACTOR = LIST_FIXTURE["actor"]

client = TestClient(worker_main.app, raise_server_exceptions=False)


def _load_harness():
    path = GOLDEN / "diff_responses.py"
    spec = importlib.util.spec_from_file_location("golden_diff_responses", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GOLDEN_DIFF = _load_harness()


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _dumps(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# ── 旧路径桩：按 fixture 的 dataset 返回行（asyncpg 行形状）─────────────────
def _py_doc_row(row: dict) -> dict:
    out = dict(row)
    for field in ("issued_at", "created_at", "updated_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    if out.get("total_amount") is not None:
        out["total_amount"] = Decimal(str(out["total_amount"]))
    return out


class _OldPathDB:
    def __init__(self, list_ds: dict, detail_ds: dict, mode: str = "list"):
        self.list_ds = list_ds
        self.detail_ds = detail_ds
        self.mode = mode
        self.calls: list = []

    def _ds(self) -> dict:
        return self.list_ds if self.mode == "list" else self.detail_ds

    def _record(self, sql: str, params) -> None:
        self.calls.append((_norm(sql), list(params)))

    def _later(self, doc_id: int):
        rows = self._ds().get("later_docs") or []
        if self.mode == "detail":
            # 详情的锁定查询是 SELECT 1（dataset 行是 {locked:1}）：非空即 locked
            return 1 if rows else None
        later_ids = {int(r["doc_id"]) for r in rows
                     if isinstance(r, dict) and r.get("doc_id") is not None}
        return 1 if doc_id in later_ids else None

    async def fetchrow(self, request, sql, *args, **kwargs):
        self._record(sql, args)
        wanted = int(args[1])
        for row in self._ds().get("trade_docs") or []:
            if int(row["id"]) == wanted:
                return _py_doc_row(row)
        return None


class _FakeConn:
    def __init__(self, stub: _OldPathDB):
        self.stub = stub

    async def fetchval(self, sql, *args):
        self.stub._record(sql, args)
        ds = self.stub._ds()
        if "COUNT(*)" in sql:
            rows = ds.get("trade_docs_total") or []
            return rows[0]["count"] if rows else 0
        if "FROM trade_docs" in sql and "AND id>$3" in sql:
            return self.stub._later(int(args[2]))
        raise AssertionError("unexpected fetchval: " + sql)

    async def fetch(self, sql, *args):
        self.stub._record(sql, args)
        ds = self.stub._ds()
        if "FROM trade_docs" in sql:
            return [_py_doc_row(r) for r in ds.get("trade_docs") or []]
        if "FROM trade_doc_render_checks" in sql:
            return [dict(r) for r in ds.get("render_checks") or []]
        if "FROM entity_links" in sql:
            return [dict(r) for r in ds.get("entity_links") or []]
        raise AssertionError("unexpected fetch: " + sql)


class _FakeAcquire:
    def __init__(self, stub: _OldPathDB):
        self.stub = stub

    async def __aenter__(self):
        return _FakeConn(self.stub)

    async def __aexit__(self, *exc):
        return False


def _old_actor(actor: dict | None = None) -> dict:
    row = dict(actor or ACTOR)
    row.setdefault("email", "buyer@qa.test")
    row.setdefault("display_name", "买家")
    row.setdefault("status", "active")
    row.setdefault("console_access", False)
    row.setdefault("plan", "free")
    return row


@pytest.fixture()
def old_path_db(monkeypatch):
    stub = _OldPathDB(LIST_FIXTURE["datasets"], DETAIL_FIXTURE["datasets"])
    monkeypatch.setattr(worker_main.db, "fetchrow", stub.fetchrow)
    monkeypatch.setattr(worker_main, "_acquire", lambda request: _FakeAcquire(stub))
    try:
        yield stub
    finally:
        worker_main.app.dependency_overrides.clear()


def _as_user(actor: dict | None = None) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = (
        lambda: _old_actor(actor))


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)

    async def _allow_all(request, user_id):
        return frozenset({"full_chain"})

    monkeypatch.setattr(ws_workstations, "_cached_codes", _allow_all)


# ── RPC 请求构造 ────────────────────────────────────────────────────────────
def _engine_token(*, secret: str = JWT_SECRET, actor: dict | None = None, **claims) -> str:
    actor = actor or ACTOR
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(actor["id"]),
        "tenant_id": "default",
        "team_id": actor["team_id"],
        "role": actor["role"],
        "account_type": actor["account_type"],
        "is_tenant_admin": actor["is_tenant_admin"],
        "kaas_internal": "engine",
        "iat": now,
        "exp": now + timedelta(seconds=60),
    }
    payload.update(claims)
    return jwt.encode(payload, secret, algorithm="HS256")


def _list_body(*, query: dict | None = None, actor: dict | None = None,
               datasets: dict | None = None) -> dict:
    return {
        "request": {"query": dict(LIST_FIXTURE["request"]["query"])
                    if query is None else dict(query)},
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(LIST_FIXTURE["datasets"]))
        if datasets is None else datasets,
    }


def _detail_body(*, doc_id: int | None = None, actor: dict | None = None,
                 datasets: dict | None = None) -> dict:
    return {
        "request": {"doc_id": DETAIL_FIXTURE["request"]["doc_id"]
                    if doc_id is None else doc_id},
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(DETAIL_FIXTURE["datasets"]))
        if datasets is None else datasets,
    }


def _post_list(body: dict | None = None, token: str | None = None):
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token())
    return client.post(LIST_FIXTURE["rpc"], json=body or _list_body(), headers=headers)


def _post_detail(body: dict | None = None, token: str | None = None):
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token())
    return client.post(DETAIL_FIXTURE["rpc"], json=body or _detail_body(), headers=headers)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（提取后）：响应 + SQL 文本/参数/顺序必须与 fixture（= 提取前）一致
# ════════════════════════════════════════════════════════════════════════════

def test_old_list_response_and_sql_match_fixture(old_path_db):
    old_path_db.mode = "list"
    _as_user()
    resp = client.get("/api/v1/trade-docs?" + LIST_FIXTURE["endpoint"]["query_string"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == LIST_FIXTURE["response"]
    assert len(old_path_db.calls) == len(LIST_FIXTURE["old_sql"])
    for actual, expected in zip(old_path_db.calls, LIST_FIXTURE["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了（提取不得改谓词/列/排序）"
        assert actual[1] == expected["params"], "绑定参数变了"


def test_old_detail_response_and_sql_match_fixture(old_path_db):
    old_path_db.mode = "detail"
    _as_user()
    resp = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == DETAIL_FIXTURE["response"]
    assert len(old_path_db.calls) == len(DETAIL_FIXTURE["old_sql"])
    for actual, expected in zip(old_path_db.calls, DETAIL_FIXTURE["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了"
        assert actual[1] == expected["params"]


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（门面供数）：同一输入 → 与旧路径逐字段一致，且零 DB 调用
# ════════════════════════════════════════════════════════════════════════════

def _bomb_db(monkeypatch):
    async def _boom(*a, **kw):
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _boom, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _boom)


def test_new_list_identical_to_old_and_fixture(old_path_db, monkeypatch):
    old_path_db.mode = "list"
    _as_user()
    old = client.get("/api/v1/trade-docs?" + LIST_FIXTURE["endpoint"]["query_string"]).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    envelope = _post_list().json()
    assert envelope["status"] == 200
    assert _dumps(envelope["body"]) == _dumps(old)
    assert _dumps(envelope["body"]) == _dumps(LIST_FIXTURE["response"])
    assert GOLDEN_DIFF.diff_bodies(old, envelope["body"]) == []


def test_new_detail_identical_to_old_and_fixture(old_path_db, monkeypatch):
    old_path_db.mode = "detail"
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"]).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    envelope = _post_detail().json()
    assert envelope["status"] == 200
    assert _dumps(envelope["body"]) == _dumps(old)
    assert _dumps(envelope["body"]) == _dumps(DETAIL_FIXTURE["response"])
    assert GOLDEN_DIFF.diff_bodies(old, envelope["body"]) == []


def test_new_path_zero_db_calls(monkeypatch):
    calls: list = []

    async def _spy(*a, **kw):
        calls.append("db")
        raise AssertionError("新路径不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _spy, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _spy)
    assert _post_list().json()["status"] == 200
    assert _post_detail().json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 时间戳 / NUMERIC / render_check 口径
# ════════════════════════════════════════════════════════════════════════════

_TS_NONZERO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")
_TS_ZERO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")


def test_fixture_timestamps_zero_and_nonzero_precision():
    first = LIST_FIXTURE["response"]["items"][0]
    second = LIST_FIXTURE["response"]["items"][1]
    assert _TS_ZERO.match(first["issued_at"]), first["issued_at"]
    assert _TS_NONZERO.match(first["created_at"]), first["created_at"]
    assert _TS_ZERO.match(first["updated_at"]), first["updated_at"]
    assert _TS_NONZERO.match(second["issued_at"]), second["issued_at"]
    assert _TS_ZERO.match(second["created_at"]), second["created_at"]


def test_new_path_timestamps_zero_and_nonzero_precision():
    body = _post_list().json()["body"]
    assert _TS_ZERO.match(body["items"][0]["issued_at"])
    assert _TS_NONZERO.match(body["items"][0]["created_at"])
    detail = _post_detail().json()["body"]
    assert _TS_ZERO.match(detail["issued_at"])
    assert _TS_NONZERO.match(detail["created_at"])


def test_numeric_and_render_check_shape():
    items = LIST_FIXTURE["response"]["items"]
    assert items[0]["total_amount"] == 100.0 and isinstance(items[0]["total_amount"], float)
    assert items[0]["render_check"] == {
        "matches": False,
        "reason": "data_changed",
        "render_version_drift": True,
        "checked_at": "2026-10-20T10:00:00.123456+00:00",
    }
    assert items[1]["render_check"] is None      # 从未巡到 ⇒ null（不是 false）
    body = _post_list().json()["body"]
    assert body["items"][0]["render_check"] == items[0]["render_check"]


# ════════════════════════════════════════════════════════════════════════════
# 4. 负例：401 / 403 / 404 / 422 逐字一致
# ════════════════════════════════════════════════════════════════════════════

def test_rpc_requires_bearer():
    for resp in (_post_list(token=False), _post_detail(token=False)):
        assert resp.status_code == 401
        assert resp.json()["detail"]["error"] == "unauthorized"


def test_rpc_rejects_plain_user_jwt():
    now = datetime.now(timezone.utc)
    user_jwt = jwt.encode(
        {"sub": str(ACTOR["id"]), "iat": now, "exp": now + timedelta(minutes=60)},
        JWT_SECRET, algorithm="HS256")
    assert _post_list(token=user_jwt).status_code == 401
    assert _post_detail(token=user_jwt).status_code == 401


def test_rpc_rejects_actor_mismatch():
    body = _list_body()
    body["actor"]["team_id"] = 999
    resp = _post_list(body)
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_rpc_payload_invalid"


def test_list_teamless_403_same(old_path_db):
    """无团队客户：旧路径在拼谓词前 403 NO_TEAM ⇒ 内核同一份判定给同样 body。"""
    teamless = dict(ACTOR, team_id=None)
    old_path_db.mode = "list"
    _as_user(teamless)
    old = client.get("/api/v1/trade-docs?" + LIST_FIXTURE["endpoint"]["query_string"])
    assert old.status_code == 403
    assert old.json()["detail"]["code"] == "NO_TEAM"
    resp = _post_list(_list_body(actor=teamless), token=_engine_token(actor=teamless))
    envelope = resp.json()
    assert envelope["status"] == 403
    assert envelope["body"] == old.json()


def test_detail_missing_404_same(old_path_db):
    old_path_db.mode = "detail"
    old_path_db.detail_ds = dict(DETAIL_FIXTURE["datasets"], trade_docs=[])
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert old.status_code == 404
    assert old.json()["detail"]["code"] == "DOC_NOT_FOUND"
    envelope = _post_detail(
        _detail_body(datasets=dict(DETAIL_FIXTURE["datasets"], trade_docs=[]))).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_detail_invisible_404_same(old_path_db):
    row = dict(DETAIL_FIXTURE["datasets"]["trade_docs"][0],
               owner_id="999", owner_scope="private", team_id=777)
    old_path_db.mode = "detail"
    old_path_db.detail_ds = dict(DETAIL_FIXTURE["datasets"], trade_docs=[])
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert old.status_code == 404
    envelope = _post_detail(
        _detail_body(datasets=dict(DETAIL_FIXTURE["datasets"], trade_docs=[row]))).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_detail_teamless_404(old_path_db):
    """无团队客户：详情 _require_doc_visible 直接 404（不是 403）。"""
    teamless = dict(ACTOR, team_id=None)
    old_path_db.mode = "detail"
    _as_user(teamless)
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert old.status_code == 404
    resp = _post_detail(_detail_body(actor=teamless), token=_engine_token(actor=teamless))
    envelope = resp.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_detail_id_mismatch_400():
    envelope = _post_detail(_detail_body(doc_id=12)).json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


def test_list_kernel_visibility_defense_in_depth():
    """门面漏滤（多给了不可见行）⇒ 内核 _doc_visible 再判一次把它剔掉。"""
    invisible = dict(LIST_FIXTURE["datasets"]["trade_docs"][0],
                     owner_id="999", owner_scope="private", team_id=777)
    datasets = json.loads(json.dumps(LIST_FIXTURE["datasets"]))
    datasets["trade_docs"].append(invisible)
    datasets["trade_docs_total"] = [{"count": 3}]
    envelope = _post_list(_list_body(datasets=datasets)).json()
    assert [i["id"] for i in envelope["body"]["items"]] == [11, 12]


def test_list_invalid_query_422_same(old_path_db):
    for qs, query in (
        ("order_id=abc", {"order_id": "abc"}),
        ("page=abc", {"page": "abc"}),
        ("page_size=abc", {"page_size": "abc"}),
    ):
        old_path_db.mode = "list"
        _as_user()
        old = client.get("/api/v1/trade-docs?" + qs)
        assert old.status_code == 422, (qs, old.text)
        raw = {"doc_type": None, "status": None, "order_id": None,
               "page": None, "page_size": None}
        raw.update(query)
        envelope = _post_list(_list_body(query=raw)).json()
        assert envelope["status"] == 422
        assert envelope["body"] == old.json(), qs


def test_list_multi_bad_query_errors_order_same(old_path_db):
    old_path_db.mode = "list"
    _as_user()
    old = client.get("/api/v1/trade-docs?page=abc&order_id=x&page_size=y")
    assert old.status_code == 422
    envelope = _post_list(_list_body(
        query={"doc_type": None, "status": None, "order_id": "x",
               "page": "abc", "page_size": "y"})).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 5. 工位订阅闸门
# ════════════════════════════════════════════════════════════════════════════

def test_new_rpc_paths_mapped_to_trade_docs_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(LIST_FIXTURE["rpc"]) == "trade-docs"
    assert workstation_of(DETAIL_FIXTURE["rpc"]) == "trade-docs"


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    for resp in (_post_list(), _post_detail()):
        assert resp.status_code == 404
        assert resp.json() == {
            "error": "not_found",
            "code": "WORKSTATION_NOT_SUBSCRIBED",
            "workstation": "trade-docs",
            "detail": "该工位未开通，请在“工位开通”里启用",
        }


# ════════════════════════════════════════════════════════════════════════════
# 6. 「一处实现」守卫
# ════════════════════════════════════════════════════════════════════════════

def _strip_docstrings(src: str) -> str:
    return re.sub(r'""".*?"""', "", src, flags=re.S)


@pytest.mark.parametrize("fn_name", ("trade_doc_list_from_datasets",
                                     "trade_doc_detail_from_datasets"))
def test_rpc_entry_has_no_db_access(fn_name):
    import inspect

    src = _strip_docstrings(inspect.getsource(getattr(worker_main, fn_name)))
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch", "conn.fetch"):
        assert forbidden not in src, fn_name + " 不得包含取数代码: " + forbidden


def test_old_and_new_paths_share_one_projection():
    import inspect

    old_list = inspect.getsource(worker_main.list_trade_docs)
    old_detail = inspect.getsource(worker_main.get_trade_doc)
    new_list = inspect.getsource(worker_main.trade_doc_list_from_datasets)
    new_detail = inspect.getsource(worker_main.trade_doc_detail_from_datasets)
    assert "_trade_doc_list_payload" in old_list
    assert "_trade_doc_list_payload" in new_list
    assert "_trade_doc_detail_payload" in old_detail
    assert "_trade_doc_detail_payload" in new_detail
    # refs 也必须是同一份纯函数
    assert "_doc_link_refs" in inspect.getsource(worker_main._doc_upstream_links)
    assert "_doc_link_refs" in new_detail
