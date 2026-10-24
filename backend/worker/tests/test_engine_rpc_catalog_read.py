"""P3 第六批金标：4 条「需要内核计算」的只读端点（旧 vs 新）。

覆盖：
1. GET /api/v1/export-quote/products（产品目录）
2. GET /api/v1/quotes/product-name-preference（产品名偏好）
3. GET /api/v1/export-quote/products/{key}/import-template（**JSON 分支**；产文件分支留旧路径）
4. GET /api/v1/export-quote/import/order/template-info（整单模板列定义）

范式与前面几批一致：旧路径（自取数）响应/SQL == fixture；新路径（供数 RPC）零 DB 且
body == 旧 == fixture；负例（401/404/422/工位 404）逐字一致；判定复用同一份
（_quotable_specs_from_rows / _resolve_effective_raw / 客户闸门 / 模板列定义）。

fixture 由旧路径生成（backend/ts-migration/golden/gen_engine_catalog_read_fixtures.py）；
TS 侧 tests/engine-catalog-read.test.ts 读同一份。**禁止**在测试里自更新 fixture。
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

import ws_workstations  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2]
GOLDEN = BACKEND / "ts-migration" / "golden"
PRODUCTS = json.loads((GOLDEN / "engine-products.fixture.json").read_text(encoding="utf-8"))
NAME_PREF = json.loads(
    (GOLDEN / "engine-product-name-preference.fixture.json").read_text(encoding="utf-8"))
IMPORT_TPL = json.loads(
    (GOLDEN / "engine-import-template.fixture.json").read_text(encoding="utf-8"))
ORDER_TPL = json.loads(
    (GOLDEN / "engine-order-template-info.fixture.json").read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
ACTOR = PRODUCTS["actor"]
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


# ── 旧路径桩（按 fixture dataset 返回行）────────────────────────────────────
class _OldPathDB:
    def __init__(self):
        self.calls: list = []

    def _record(self, sql: str, params) -> None:
        self.calls.append((_norm(sql), list(params)))

    async def fetch(self, request, sql, *args, **kwargs):
        self._record(sql, args)
        if "FROM tenant_products" in sql:
            if "AND product_key=$2" in sql:
                # 只对 fixture 里的产品返回行（未知 key ⇒ 空，走 404 分支）
                wanted = args[1] if len(args) > 1 else None
                if wanted != "field_fence":
                    return []
                return [dict(r) for r in IMPORT_TPL["datasets"]["tenant_products"]]
            return [dict(r) for r in PRODUCTS["datasets"]["tenant_products"]]
        if "FROM tenant_workstation_products" in sql:
            return [dict(r) for r in PRODUCTS["datasets"]["tenant_workstation_products"]]
        if "FROM product_profiles" in sql:
            return [dict(r) for r in PRODUCTS["datasets"]["product_profiles"]]
        raise AssertionError("unexpected db.fetch: " + sql)


class _FakeConn:
    def __init__(self, stub: _OldPathDB):
        self.stub = stub

    async def fetchrow(self, sql, *args):
        self.stub._record(sql, args)
        if "FROM customers" in sql:
            wanted = int(args[0])
            for row in NAME_PREF["datasets"]["customers"]:
                if int(row["id"]) == wanted:
                    return dict(row)
            return None
        if "FROM quote_order_items" in sql:
            key = args[2]
            folded = args[3] if len(args) > 3 else []
            for row in NAME_PREF["datasets"]["preference_candidates"]:
                name = row["product_name"]
                if row["product_key"] == key:
                    return dict(row)
                if row["product_key"] is None and name.casefold() in folded:
                    return dict(row)
            return None
        raise AssertionError("unexpected conn.fetchrow: " + sql)


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
    stub = _OldPathDB()
    monkeypatch.setattr(worker_main.db, "fetch", stub.fetch)
    monkeypatch.setattr(worker_main.db, "acquire", lambda request: _FakeAcquire(stub))
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
def _engine_token(*, actor: dict | None = None, **claims) -> str:
    actor = actor or ACTOR
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(actor["id"]), "tenant_id": "default", "team_id": actor["team_id"],
        "role": actor["role"], "account_type": actor["account_type"],
        "is_tenant_admin": actor["is_tenant_admin"],
        "kaas_internal": "engine", "iat": now, "exp": now + timedelta(seconds=60),
    }
    payload.update(claims)
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def _post(fixture: dict, *, request_body: dict | None = None, actor: dict | None = None,
          datasets: dict | None = None, token: str | None = None):
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(actor=actor))
    body = {
        "request": json.loads(json.dumps(fixture["request"]))
        if request_body is None else request_body,
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(fixture["datasets"]))
        if datasets is None else datasets,
    }
    return client.post(fixture["rpc"], json=body, headers=headers)


def _bomb_db(monkeypatch):
    async def _boom(*a, **kw):
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _boom, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _boom)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（提取后）：响应 + SQL/参数/顺序 == fixture
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fixture, path", [
    (PRODUCTS, "/api/v1/export-quote/products"),
    (NAME_PREF, "/api/v1/quotes/product-name-preference?customer_id=3&product_key=field_fence"),
    (IMPORT_TPL, "/api/v1/export-quote/products/field_fence/import-template"),
    (ORDER_TPL, "/api/v1/export-quote/import/order/template-info?product_keys=field_fence"),
])
def test_old_path_response_and_sql_match_fixture(old_path_db, fixture, path):
    old_path_db.calls.clear()
    _as_user()
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    assert resp.json() == fixture["response"]
    assert len(old_path_db.calls) == len(fixture["old_sql"])
    for actual, expected in zip(old_path_db.calls, fixture["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了（提取不得改谓词/列/顺序）"
        assert actual[1] == expected["params"], "绑定参数变了"


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（供数 RPC）：body == 旧 == fixture，且零 DB
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fixture, path", [
    (PRODUCTS, "/api/v1/export-quote/products"),
    (NAME_PREF, "/api/v1/quotes/product-name-preference?customer_id=3&product_key=field_fence"),
    (IMPORT_TPL, "/api/v1/export-quote/products/field_fence/import-template"),
    (ORDER_TPL, "/api/v1/export-quote/import/order/template-info?product_keys=field_fence"),
])
def test_new_path_identical_to_old_and_fixture(old_path_db, monkeypatch, fixture, path):
    _as_user()
    old = client.get(path).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    resp = _post(fixture)
    if resp.status_code != 200:
        print("DEBUG rpc:", fixture["rpc"], resp.status_code, resp.text[:1200])
    envelope = resp.json()
    assert envelope["status"] == 200
    assert _dumps(envelope["body"]) == _dumps(old)
    assert _dumps(envelope["body"]) == _dumps(fixture["response"])
    assert GOLDEN_DIFF.diff_bodies(old, envelope["body"]) == []


def test_new_path_zero_db_calls(monkeypatch):
    calls: list = []

    async def _spy(*a, **kw):
        calls.append("db")
        raise AssertionError("新路径不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _spy, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _spy)
    for fixture in (PRODUCTS, NAME_PREF, IMPORT_TPL, ORDER_TPL):
        assert _post(fixture).json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 金标语义锚点（防止 fixture 自身退化）
# ════════════════════════════════════════════════════════════════════════════

def test_products_catalog_composition():
    body = PRODUCTS["response"]
    keys = [p["key"] for p in body["products"]]
    assert body["total"] == len(keys) == 2
    assert keys == ["deer_net", "field_fence"]          # chain_link 被停用 ⇒ 不在目录
    fence = next(p for p in body["products"] if p["key"] == "field_fence")
    # 团队资料的英文名覆盖：主名 + 别名
    assert fence["name_en"] == "Field Fence"
    assert fence["name_en_aliases"] == ["Fence Panel"]
    assert fence["spec_summary"]
    assert fence["combo_count"] > 0 and fence["metric_count"] > 0


def test_name_preference_applies_predicate_not_first_row():
    """fixture 第一条候选是「名字不在名单里的历史行」⇒ 必须被谓词跳过。"""
    assert NAME_PREF["datasets"]["preference_candidates"][0]["product_name"] == "Fence Panel (old)"
    assert NAME_PREF["response"] == {"product_name": "Field Fence"}


def test_import_template_and_order_union_shapes():
    body = IMPORT_TPL["response"]
    assert body["product_key"] == "field_fence"
    assert body["headers"] and len(body["headers"]) == len(body["columns"])
    assert body["download"]["csv"].endswith("/import-template?format=csv")
    order = ORDER_TPL["response"]
    assert order["product_keys"] == ["field_fence"]
    assert len(order["headers"]) >= len(body["headers"])   # 公共列 + 规格列
    assert order["data_sheet"] == "整单表"


# ════════════════════════════════════════════════════════════════════════════
# 4. 负例：401 / 404 / 422 逐字一致
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fixture", [PRODUCTS, NAME_PREF, IMPORT_TPL, ORDER_TPL])
def test_rpc_requires_bearer(fixture):
    assert _post(fixture, token=False).status_code == 401


def test_rpc_rejects_plain_user_jwt():
    now = datetime.now(timezone.utc)
    user_jwt = jwt.encode({"sub": "5", "iat": now, "exp": now + timedelta(minutes=60)},
                          JWT_SECRET, algorithm="HS256")
    assert _post(PRODUCTS, token=user_jwt).status_code == 401


def test_name_preference_missing_customer_id_422_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/quotes/product-name-preference?product_key=field_fence")
    assert old.status_code == 422
    envelope = _post(NAME_PREF, request_body={
        "query": {"customer_id": None, "product_key": "field_fence"}}).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


def test_name_preference_invalid_customer_id_422_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get(
        "/api/v1/quotes/product-name-preference?customer_id=abc&product_key=field_fence")
    assert old.status_code == 422
    envelope = _post(NAME_PREF, request_body={
        "query": {"customer_id": "abc", "product_key": "field_fence"}}).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


def test_name_preference_empty_product_key_422_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/quotes/product-name-preference?customer_id=3")
    assert old.status_code == 422
    assert old.json()["detail"]["code"] == "PRODUCT_KEY_REQUIRED"
    envelope = _post(NAME_PREF, request_body={
        "query": {"customer_id": "3", "product_key": ""}}).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


def test_name_preference_unknown_product_404_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/quotes/product-name-preference?customer_id=3&product_key=nope")
    assert old.status_code == 404
    assert old.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"
    envelope = _post(NAME_PREF, request_body={
        "query": {"customer_id": "3", "product_key": "nope"}}).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_name_preference_customer_gate_404_same(old_path_db):
    """客户不存在 / 别团队 ⇒ 404 CUSTOMER_NOT_FOUND（不泄露存在性），逐字一致。"""
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/quotes/product-name-preference?customer_id=99&product_key=field_fence")
    assert old.status_code == 404
    envelope = _post(NAME_PREF, request_body={
        "query": {"customer_id": "99", "product_key": "field_fence"}},
        datasets=dict(NAME_PREF["datasets"], customers=[],
                      preference_candidates=[])).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_import_template_bad_query_422_same(old_path_db):
    for qs, query in (
        ("examples=abc", {"examples": "abc"}),
        ("examples=51", {"examples": "51"}),
        ("include_spec=maybe", {"include_spec": "maybe"}),
    ):
        old_path_db.calls.clear()
        _as_user()
        old = client.get(
            "/api/v1/export-quote/products/field_fence/import-template?" + qs)
        assert old.status_code == 422, (qs, old.text)
        envelope = _post(IMPORT_TPL, request_body={
            "product_key": "field_fence",
            "query": {"format": "", "examples": None, "include_spec": None, **query},
        }).json()
        assert envelope["status"] == 422
        assert envelope["body"] == old.json(), qs


def test_import_template_unknown_product_404_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/export-quote/products/unknown_key/import-template")
    assert old.status_code == 404
    envelope = _post(IMPORT_TPL, request_body={
        "product_key": "unknown_key", "query": {"format": ""}},
        datasets={"tenant_products": []}).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_import_template_file_branch_stays_old_path(old_path_db):
    """带 format 的产文件分支：旧路径行为（csv 200 / xlsx 501 / 非法 422），不切 RPC。"""
    old_path_db.calls.clear()
    _as_user()
    csv_resp = client.get("/api/v1/export-quote/products/field_fence/import-template?format=csv")
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-type"].startswith("text/csv")
    assert "attachment" in csv_resp.headers.get("content-disposition", "")
    xlsx_resp = client.get("/api/v1/export-quote/products/field_fence/import-template?format=xlsx")
    assert xlsx_resp.status_code == 501
    bad_resp = client.get("/api/v1/export-quote/products/field_fence/import-template?format=bogus")
    assert bad_resp.status_code == 422
    assert bad_resp.json()["detail"]["error"] == "bad_format"


def test_order_template_unknown_key_404_same(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/export-quote/import/order/template-info?product_keys=nope")
    assert old.status_code == 404
    envelope = _post(ORDER_TPL, request_body={
        "query": {"product_keys": "nope"}}).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 5. 工位订阅闸门 + 一处实现守卫
# ════════════════════════════════════════════════════════════════════════════

def test_new_rpc_paths_mapped_to_quotes_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    for fixture in (PRODUCTS, NAME_PREF, IMPORT_TPL, ORDER_TPL):
        assert workstation_of(fixture["rpc"]) == "quotes"


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    for fixture in (PRODUCTS, NAME_PREF, IMPORT_TPL, ORDER_TPL):
        resp = _post(fixture)
        assert resp.status_code == 404
        assert resp.json()["code"] == "WORKSTATION_NOT_SUBSCRIBED"


@pytest.mark.parametrize("fn_name", ("products_from_datasets",
                                     "quote_name_preference_from_datasets",
                                     "import_template_from_datasets",
                                     "order_template_info_from_datasets"))
def test_rpc_entry_has_no_db_access(fn_name):
    import inspect

    import quote_api

    src = re.sub(r'""".*?"""', "", inspect.getsource(getattr(quote_api, fn_name)), flags=re.S)
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch", "conn.fetch"):
        assert forbidden not in src, fn_name + " 不得包含取数代码: " + forbidden
