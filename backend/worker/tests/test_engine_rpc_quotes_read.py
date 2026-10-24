"""P3 第四批切片金标：GET /api/v1/quotes（列表）+ /quotes/{quote_id}（详情）旧 vs 新。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §8（切片范式）；与
export-quote / render-data 同一个金标范式。

本文件锁六件事：
1. **提取不变**（quote_api.py 的 handler 抽成纯投影是行为不变的）：旧路径响应 == fixture.response，
   且旧路径实际执行的 SQL 文本/绑定参数/顺序 == fixture.old_sql；
2. 新路径（POST /api/v1/internal/engine/quotes/{list,detail}，门面供数）响应 == fixture.response，
   并且**零 DB 调用**（db.fetch/fetchval/acquire 换成炸弹）；
3. 门禁随行：工位订阅（新前缀 /api/v1/internal/engine/quotes → quotes）与单证可见性
   （内核 can_view 防御纵深 + 门面 SQL 谓词）都调用**同一份**既有判定；401/404/422 逐字一致；
4. 时间戳口径（docs §8.9）：零微秒 ⇒ 无小数；非零 ⇒ 6 位小数；
5. scope 谓词：非管理员列表 SQL 必须下推 owner/tenant/team 三条（与 _scope_sql 同义）；
6. 一处实现：两个 RPC 函数只做投影接线（无取数代码），旧 handler 与 RPC 调用同一份纯投影。

fixture 由旧路径生成（backend/ts-migration/golden/gen_engine_quotes_read_fixtures.py）；
TS 侧 tests/engine-quotes-read.test.ts 读**同一份**文件。
⇒ 任一侧的供数/投影语义漂移都会在 CI 变红；**禁止**在测试里自更新 fixture。
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import quote_api  # noqa: E402
import ws_workstations  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2]
GOLDEN = BACKEND / "ts-migration" / "golden"
LIST_FIXTURE = json.loads((GOLDEN / "engine-quotes-list.fixture.json").read_text(encoding="utf-8"))
DETAIL_FIXTURE = json.loads(
    (GOLDEN / "engine-quotes-detail.fixture.json").read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
ACTOR = LIST_FIXTURE["actor"]

client = TestClient(worker_main.app, raise_server_exceptions=False)


# ── 既有金标 harness（复用其 JSON 语义 diff，不新写比较器）─────────────────────
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


# ── 旧路径桩：按 SQL 路由返回 fixture 里的行 ────────────────────────────────
def _py_quote_row(row: dict) -> dict:
    out = dict(row)
    for field in ("created_at", "updated_at", "valid_until"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    for field in ("fx_rate_date", "freight_valid_from", "freight_valid_to"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = __import__("datetime").date.fromisoformat(value)
    return out


def _py_item_row(row: dict) -> dict:
    out = dict(row)
    value = out.get("created_at")
    if isinstance(value, str) and value:
        out["created_at"] = datetime.fromisoformat(value)
    return out


class _OldPathDB:
    """按 SQL 路由的桩；记录调用顺序用于「提取前后 SQL 不变」断言。"""

    def __init__(self, list_ds: dict, detail_ds: dict, mode: str = "list"):
        self.list_ds = list_ds
        self.detail_ds = detail_ds
        self.mode = mode
        self.calls: list = []

    def _ds(self) -> dict:
        return self.list_ds if self.mode == "list" else self.detail_ds

    def _record(self, sql: str, params) -> None:
        self.calls.append((_norm(sql), list(params)))

    async def fake_fetchval(self, request, sql, *args):
        self._record(sql, args)
        ds = self._ds()
        if "COUNT(*)" in sql:
            rows = ds.get("quote_orders_total") or []
            return rows[0]["count"] if rows else 0
        # detail 的锁定查询是 SELECT 1（dataset 行是 {locked:1}）：非空即 locked；
        # list 的锁定查询是 DISTINCT quote_id（dataset 行是 {quote_id}）：按 id 匹配。
        if "FROM trade_docs" in sql or "FROM orders" in sql:
            rows = ds.get("trade_docs_locked") if "FROM trade_docs" in sql                 else ds.get("orders_locked")
            rows = rows or []
            if self.mode == "detail":
                return 1 if rows else None
            return 1 if any(r.get("quote_id") == int(args[1]) for r in rows) else None
        raise AssertionError("unexpected fetchval: " + sql)

    async def fake_fetch(self, request, sql, *args):
        self._record(sql, args)
        ds = self._ds()
        if "FROM quote_orders" in sql:
            return [_py_quote_row(r) for r in ds.get("quote_orders") or []]
        if "FROM quote_order_items" in sql:
            return [dict(r) for r in ds.get("quote_order_item_counts") or []]
        if "FROM trade_docs" in sql:
            ids = set(int(x) for x in args[1])
            return [dict(r) for r in ds.get("trade_docs_locked") or []
                    if r.get("quote_id") in ids]
        if "FROM orders" in sql:
            ids = set(int(x) for x in args[1])
            return [dict(r) for r in ds.get("orders_locked") or []
                    if r.get("quote_id") in ids]
        raise AssertionError("unexpected fetch: " + sql)


class _FakeConn:
    def __init__(self, stub: _OldPathDB):
        self.stub = stub

    async def fetchrow(self, sql, *args):
        self.stub._record(sql, args)
        ds = self.stub._ds()
        rows = ds.get("quote_orders") or []
        wanted = int(args[1])
        for row in rows:
            if int(row["id"]) == wanted:
                return _py_quote_row(row)
        return None

    async def fetch(self, sql, *args):
        self.stub._record(sql, args)
        ds = self.stub._ds()
        wanted = int(args[1])
        return [_py_item_row(r) for r in ds.get("quote_order_items") or []
                if int(r["quote_order_id"]) == wanted]


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
    """旧路径：走内核自取数（db 桩）+ 注入当前用户。"""
    stub = _OldPathDB(LIST_FIXTURE["datasets"], DETAIL_FIXTURE["datasets"])
    monkeypatch.setattr(worker_main.db, "fetchval", stub.fake_fetchval)
    monkeypatch.setattr(worker_main.db, "fetch", stub.fake_fetch)
    monkeypatch.setattr(worker_main.db, "acquire", lambda request: _FakeAcquire(stub))
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
    fixture = LIST_FIXTURE
    return {
        "request": {"query": dict(fixture["request"]["query"]) if query is None else dict(query)},
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(fixture["datasets"])) if datasets is None else datasets,
    }


def _detail_body(*, quote_id: int | None = None, actor: dict | None = None,
                 datasets: dict | None = None) -> dict:
    fixture = DETAIL_FIXTURE
    return {
        "request": {"quote_id": fixture["request"]["quote_id"] if quote_id is None else quote_id},
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(fixture["datasets"])) if datasets is None else datasets,
    }


def _post_list(body: dict | None = None, token: str | None = None, actor: dict | None = None):
    data = _list_body() if body is None else body
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(actor=actor))
    return client.post(LIST_FIXTURE["rpc"], json=data, headers=headers)


def _post_detail(body: dict | None = None, token: str | None = None, actor: dict | None = None):
    data = _detail_body() if body is None else body
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(actor=actor))
    return client.post(DETAIL_FIXTURE["rpc"], json=data, headers=headers)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（提取后）：响应 + SQL 文本/参数/顺序必须与 fixture（= 提取前）一致
# ════════════════════════════════════════════════════════════════════════════

def test_old_list_response_and_sql_match_fixture(old_path_db):
    old_path_db.mode = "list"
    _as_user()
    resp = client.get("/api/v1/quotes?" + LIST_FIXTURE["endpoint"]["query_string"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == LIST_FIXTURE["response"], (
        "旧列表响应与 fixture 不一致（提取改了投影/顺序）")
    assert len(old_path_db.calls) == len(LIST_FIXTURE["old_sql"])
    for actual, expected in zip(old_path_db.calls, LIST_FIXTURE["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了（提取不得改谓词/列/排序）"
        assert actual[1] == expected["params"], "绑定参数变了（提取不得改谓词）"


def test_old_detail_response_and_sql_match_fixture(old_path_db):
    old_path_db.mode = "detail"
    _as_user()
    resp = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == DETAIL_FIXTURE["response"], (
        "旧详情响应与 fixture 不一致（提取改了投影/顺序）")
    assert len(old_path_db.calls) == len(DETAIL_FIXTURE["old_sql"])
    for actual, expected in zip(old_path_db.calls, DETAIL_FIXTURE["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了"
        # 详情行项查询参数是 [tenant, id]；SQL 里无 scope 片段
        assert actual[1] == expected["params"], "绑定参数变了"


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（门面供数）：同一输入 → 与旧路径逐字段一致，且零 DB 调用
# ════════════════════════════════════════════════════════════════════════════

def _bomb_db(monkeypatch):
    async def _boom(*a, **kw):
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    monkeypatch.setattr(worker_main.db, "fetchval", _boom)
    monkeypatch.setattr(worker_main.db, "fetch", _boom)
    monkeypatch.setattr(worker_main.db, "acquire", _boom)
    monkeypatch.setattr(worker_main, "_acquire", _boom)


def test_new_list_identical_to_old_and_fixture(old_path_db, monkeypatch):
    old_path_db.mode = "list"
    _as_user()
    old = client.get("/api/v1/quotes?" + LIST_FIXTURE["endpoint"]["query_string"]).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    resp = _post_list()
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == 200
    new = envelope["body"]
    assert _dumps(new) == _dumps(old)
    assert _dumps(new) == _dumps(LIST_FIXTURE["response"])
    assert GOLDEN_DIFF.diff_bodies(old, new) == []


def test_new_detail_identical_to_old_and_fixture(old_path_db, monkeypatch):
    old_path_db.mode = "detail"
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"]).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    resp = _post_detail()
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == 200
    new = envelope["body"]
    assert _dumps(new) == _dumps(old)
    assert _dumps(new) == _dumps(DETAIL_FIXTURE["response"])
    assert GOLDEN_DIFF.diff_bodies(old, new) == []


def test_new_path_zero_db_calls(monkeypatch):
    calls: list = []

    async def _spy(*a, **kw):
        calls.append("db")
        raise AssertionError("新路径不得访问数据库")

    monkeypatch.setattr(worker_main.db, "fetchval", _spy)
    monkeypatch.setattr(worker_main.db, "fetch", _spy)
    monkeypatch.setattr(worker_main.db, "acquire", _spy)
    monkeypatch.setattr(worker_main, "_acquire", _spy)
    assert _post_list().json()["status"] == 200
    assert _post_detail().json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 时间戳口径（docs §8.9）：零微秒 ⇒ 无小数；非零 ⇒ 6 位
# ════════════════════════════════════════════════════════════════════════════

_TS_NONZERO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")
_TS_ZERO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")


def test_fixture_timestamps_zero_and_nonzero_precision():
    item = LIST_FIXTURE["response"]["items"][0]
    assert _TS_NONZERO.match(item["created_at"]), item["created_at"]
    assert _TS_ZERO.match(item["valid_until"]), item["valid_until"]
    assert LIST_FIXTURE["response"]["items"][1]["created_at"] == "2026-10-19T09:00:00.987654+00:00"
    assert LIST_FIXTURE["response"]["items"][2]["created_at"] == "2026-10-17T08:00:00+00:00"
    # 详情行项：id=1 非零、id=2 零微秒
    assert _TS_NONZERO.match(DETAIL_FIXTURE["response"]["items"][0]["created_at"])
    assert _TS_ZERO.match(DETAIL_FIXTURE["response"]["items"][1]["created_at"])
    # DATE 列是 Python date.isoformat 口径（无时间）
    assert item["fx_rate_date"] == "2026-10-19"


def test_new_path_timestamps_zero_and_nonzero_precision():
    list_body = _post_list().json()["body"]
    detail_body = _post_detail().json()["body"]
    assert _TS_NONZERO.match(list_body["items"][0]["created_at"])
    assert _TS_ZERO.match(list_body["items"][0]["valid_until"])
    assert _TS_ZERO.match(detail_body["items"][1]["created_at"])


# ════════════════════════════════════════════════════════════════════════════
# 4. 负例：401 / 404 / 422 逐字一致
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


def test_rpc_rejects_bad_datasets_shape():
    body = _detail_body()
    body["datasets"]["quote_orders"] = "not-a-list"
    resp = _post_detail(body)
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


def test_detail_missing_quote_404_same(old_path_db):
    old_path_db.mode = "detail"
    old_path_db.detail_ds = dict(DETAIL_FIXTURE["datasets"], quote_orders=[])
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert old.status_code == 404
    assert old.json()["detail"]["code"] == "QUOTE_NOT_FOUND"
    new = _post_detail(_detail_body(
        datasets=dict(DETAIL_FIXTURE["datasets"], quote_orders=[])))
    envelope = new.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_detail_invisible_quote_404_same(old_path_db):
    """不可见 = 与不存在同码同体（不泄露存在性）。"""
    row = dict(DETAIL_FIXTURE["datasets"]["quote_orders"][0],
               owner_id="999", owner_scope="private", team_id=777)
    old_path_db.mode = "detail"
    old_path_db.detail_ds = dict(DETAIL_FIXTURE["datasets"], quote_orders=[])
    _as_user()
    old = client.get(DETAIL_FIXTURE["endpoint"]["path"])
    assert old.status_code == 404
    new = _post_detail(_detail_body(
        datasets=dict(DETAIL_FIXTURE["datasets"], quote_orders=[row])))
    envelope = new.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_detail_id_mismatch_400():
    body = _detail_body(quote_id=12)   # datasets 里是 11
    resp = _post_detail(body)
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


def test_list_kernel_visibility_defense_in_depth():
    """门面漏滤（多给了不可见行）⇒ 内核 can_view 再判一次把它剔掉（防御纵深）。"""
    invisible = dict(LIST_FIXTURE["datasets"]["quote_orders"][0],
                     owner_id="999", owner_scope="private", team_id=777)
    datasets = json.loads(json.dumps(LIST_FIXTURE["datasets"]))
    datasets["quote_orders"].append(invisible)
    body = _list_body(datasets=datasets)
    body["datasets"]["quote_orders_total"] = [{"count": 4}]
    envelope = _post_list(body).json()
    ids = [i["id"] for i in envelope["body"]["items"]]
    assert 999 not in ids
    assert ids == [11, 12, 13]


@pytest.mark.parametrize("query, expected_status", [
    ({"status": "bogus"}, 422),
    ({"page": "abc"}, 422),
    ({"page": "0"}, 422),
    ({"page_size": "201"}, 422),
    ({"page_size": "0"}, 422),
    ({"customer_id": "abc"}, 422),
    ({"customer_id": ""}, 422),
    ({"inquiry_id": "abc"}, 422),
])
def test_list_invalid_query_422_same(old_path_db, query, expected_status):
    old_path_db.mode = "list"
    _as_user()
    qs = "&".join("%s=%s" % (k, v) for k, v in query.items())
    old = client.get("/api/v1/quotes?" + qs)
    assert old.status_code == expected_status, old.text
    raw = {k: v for k, v in query.items()}
    body = _list_body(query={**{"status": None, "customer_id": None, "inquiry_id": None,
                                "page": None, "page_size": None}, **raw})
    envelope = _post_list(body).json()
    assert envelope["status"] == expected_status
    assert envelope["body"] == old.json()


def test_list_multi_bad_query_errors_order_same(old_path_db):
    """多个非法 query 参数：错误按 handler 声明顺序累计（与 FastAPI 同一顺序）。"""
    old_path_db.mode = "list"
    _as_user()
    qs = "page=0&page_size=201&customer_id=x"
    old = client.get("/api/v1/quotes?" + qs)
    assert old.status_code == 422
    body = _list_body(query={"status": None, "customer_id": "x", "inquiry_id": None,
                             "page": "0", "page_size": "201"})
    envelope = _post_list(body).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 5. 工位订阅闸门
# ════════════════════════════════════════════════════════════════════════════

def test_new_rpc_paths_mapped_to_quotes_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(LIST_FIXTURE["rpc"]) == "quotes"
    assert workstation_of(DETAIL_FIXTURE["rpc"]) == "quotes"


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    for resp in (_post_list(), _post_detail()):
        assert resp.status_code == 404
        assert resp.json() == {
            "error": "not_found",
            "code": "WORKSTATION_NOT_SUBSCRIBED",
            "workstation": "quotes",
            "detail": "该工位未开通，请在“工位开通”里启用",
        }


def test_workstation_gate_same_body_as_old(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    user_token = worker_main._create_token(ACTOR["id"])
    old = client.get("/api/v1/quotes", headers={"Authorization": "Bearer " + user_token})
    new = _post_list()
    assert old.status_code == 404 and new.status_code == 404
    assert new.json() == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 6. 「一处实现」守卫
# ════════════════════════════════════════════════════════════════════════════

def _strip_docstrings(src: str) -> str:
    return re.sub(r'""".*?"""', "", src, flags=re.S)


@pytest.mark.parametrize("fn_name", ("quote_list_from_datasets", "quote_detail_from_datasets"))
def test_rpc_entry_has_no_db_access(fn_name):
    import inspect

    src = _strip_docstrings(inspect.getsource(getattr(quote_api, fn_name)))
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch"):
        assert forbidden not in src, fn_name + " 不得包含取数代码: " + forbidden


def test_old_and_new_paths_share_one_projection():
    import inspect

    old_list = inspect.getsource(quote_api.list_quote_orders)
    old_detail = inspect.getsource(quote_api.get_quote_order)
    new_list = inspect.getsource(quote_api.quote_list_from_datasets)
    new_detail = inspect.getsource(quote_api.quote_detail_from_datasets)
    assert "_quote_list_payload" in old_list and "_quote_list_payload" in new_list
    assert "_quote_detail_payload" in old_detail and "_quote_detail_payload" in new_detail
