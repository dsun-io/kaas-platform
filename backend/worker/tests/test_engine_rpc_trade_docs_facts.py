"""P3 第八批金标：GET /trade-docs/{id}/facts + /consistency 旧 vs 新。

范式同前几批：旧路径响应/SQL == fixture；新路径（供数 RPC）零 DB 且 body == 旧 == fixture；
负例（401/404/工位 404）逐字一致；提取不变性用 HEAD 版对照（old_sql/response/datasets 相同）。
facts 的包装解析走「本单行命中」（产品定义里的 packaging_id）分支；consistency 走
order 列分支（域内 2 张单）。fixture 由 gen_engine_trade_docs_facts_fixtures.py 生成。
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
FACTS = json.loads(
    (GOLDEN / "engine-trade-docs-facts.fixture.json").read_text(encoding="utf-8"))
CONSISTENCY = json.loads(
    (GOLDEN / "engine-trade-docs-consistency.fixture.json").read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
ACTOR = FACTS["actor"]
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


# ── 旧路径桩 ────────────────────────────────────────────────────────────────
class _OldPathDB:
    def __init__(self, fixture: dict):
        self.fixture = fixture
        self.calls: list = []

    def _ds(self) -> dict:
        return self.fixture["datasets"]

    async def fetchrow(self, request, sql, *args, **kwargs):
        self.calls.append((_norm(sql), list(args)))
        wanted = int(args[1])
        for row in self._ds().get("trade_docs") or []:
            if int(row["id"]) == wanted:
                return _py_doc(row)
        return None

    async def fetch(self, request, sql, *args, **kwargs):
        self.calls.append((_norm(sql), list(args)))
        ds = self._ds()
        if "FROM trade_doc_facts" in sql:
            return [dict(r) for r in ds.get("trade_doc_facts") or []]
        if "FROM tenant_products" in sql:
            return [dict(r) for r in ds.get("tenant_products") or []]
        if "order_id=$2" in sql:
            order_id = int(args[1])
            return [_py_doc(r) for r in ds.get("trade_docs_by_order") or []
                    if int(r["order_id"]) == order_id]
        if "quote_id=$2" in sql:
            quote_id = int(args[1])
            return [_py_doc(r) for r in ds.get("trade_docs_by_quote") or []
                    if r.get("quote_id") is not None and int(r["quote_id"]) == quote_id]
        if "FROM entity_links" in sql:
            return []
        raise AssertionError("unexpected db.fetch: " + sql)


class _NoAcquire:
    async def __aenter__(self):
        raise AssertionError("这些读端点不应 acquire 事务连接")

    async def __aexit__(self, *exc):
        return False


def _py_doc(row: dict) -> dict:
    out = dict(row)
    for field in ("issued_at", "created_at", "updated_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    if out.get("total_amount") is not None:
        out["total_amount"] = float(out["total_amount"])
    return out


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
    stub = _OldPathDB(FACTS)
    monkeypatch.setattr(worker_main.db, "fetchrow", stub.fetchrow)
    monkeypatch.setattr(worker_main.db, "fetch", stub.fetch)
    monkeypatch.setattr(worker_main, "_acquire", lambda request: _NoAcquire())
    try:
        yield stub
    finally:
        worker_main.app.dependency_overrides.clear()


def _as_user(actor: dict | None = None) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = (
        lambda: _old_actor(actor))


@pytest.fixture(autouse=True)
def _align_quote_module():
    """全量跑时 sys.modules["quote_api"] 可能已是更晚代际；本文件的产品解析按名字取当前
    模块 ⇒ 先对齐到本文件的代际（与 test_trade_doc_packing_api 的补丁口径相反的另一半）。"""
    import sys

    mine = worker_main.quote_api
    old = sys.modules.get("quote_api")
    sys.modules["quote_api"] = mine
    try:
        yield
    finally:
        if old is not None:
            sys.modules["quote_api"] = old


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)

    async def _allow_all(request, user_id):
        return frozenset({"full_chain"})

    monkeypatch.setattr(ws_workstations, "_cached_codes", _allow_all)


def _engine_token(*, actor: dict | None = None) -> str:
    actor = actor or ACTOR
    now = datetime.now(timezone.utc)
    return jwt.encode({
        "sub": str(actor["id"]), "tenant_id": "default", "team_id": actor["team_id"],
        "role": actor["role"], "account_type": actor["account_type"],
        "is_tenant_admin": actor["is_tenant_admin"], "kaas_internal": "engine",
        "iat": now, "exp": now + timedelta(seconds=60),
    }, JWT_SECRET, algorithm="HS256")


def _post(fixture: dict, *, datasets: dict | None = None, request_body: dict | None = None,
          token: str | None = None):
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token())
    body = {
        "request": dict(fixture["request"]) if request_body is None else request_body,
        "actor": dict(ACTOR),
        "datasets": json.loads(json.dumps(fixture["datasets"])) if datasets is None else datasets,
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
    (FACTS, "/api/v1/trade-docs/11/facts"),
    (CONSISTENCY, "/api/v1/trade-docs/12/consistency"),
])
def test_old_path_response_and_sql_match_fixture(old_path_db, fixture, path):
    old_path_db.fixture = fixture
    old_path_db.calls.clear()
    _as_user()
    resp = client.get(path)
    assert resp.status_code == 200, resp.text
    assert resp.json() == fixture["response"]
    assert len(old_path_db.calls) == len(fixture["old_sql"])
    for actual, expected in zip(old_path_db.calls, fixture["old_sql"]):
        assert actual[0] == expected["sql"]
        assert actual[1] == expected["params"]


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（供数 RPC）：body == 旧 == fixture，零 DB
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fixture, path", [
    (FACTS, "/api/v1/trade-docs/11/facts"),
    (CONSISTENCY, "/api/v1/trade-docs/12/consistency"),
])
def test_new_path_identical_to_old_and_fixture(old_path_db, monkeypatch, fixture, path):
    old_path_db.fixture = fixture
    _as_user()
    old = client.get(path).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    envelope = _post(fixture).json()
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
    assert _post(FACTS).json()["status"] == 200
    assert _post(CONSISTENCY).json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 金标语义锚点
# ════════════════════════════════════════════════════════════════════════════

def test_facts_packing_and_overlay():
    body = FACTS["response"]
    packings = {i["key"]: i for i in body["items"] if i["key"].startswith("packing")}
    # 本单行 spec_snapshot.packaging_id=pk_1 命中产品定义 => origin=row（method=roll）
    assert packings["packing_method"]["value"] == "roll"
    assert packings["packing_method"]["evidence_ref"] == "spec_snapshot.packaging_id=pk_1"
    incoterm = next(i for i in body["items"] if i["key"] == "incoterm")
    assert incoterm["trust"] == "confirmed" and incoterm["immutable"] is True
    assert incoterm["text_en"] == "DAP Yangzhou (Incoterms 2020)"
    assert body["summary"]["total"] == len(body["items"])


def test_consistency_order_chain_and_color():
    body = CONSISTENCY["response"]
    assert body["domain"]["root"] == "order:1"
    assert body["domain"]["doc_ids"] == ["11", "12"]
    assert isinstance(body["items"], list)
    assert body["ok"] == (not any(i["severity"] == "error" for i in body["items"]))
    for item in body["items"]:
        assert item["severity"] in ("error", "warning")


# ════════════════════════════════════════════════════════════════════════════
# 4. 负例：401 / 404 / 工位 404 / 不一致 400
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fixture", [FACTS, CONSISTENCY])
def test_rpc_requires_bearer(fixture):
    assert _post(fixture, token=False).status_code == 401


@pytest.mark.parametrize("fixture, path", [
    (FACTS, "/api/v1/trade-docs/99/facts"),
    (CONSISTENCY, "/api/v1/trade-docs/99/consistency"),
])
def test_doc_missing_404_same(old_path_db, fixture, path):
    old_path_db.fixture = fixture
    _as_user()
    old = client.get(path)
    assert old.status_code == 404
    assert old.json()["detail"]["code"] == "DOC_NOT_FOUND"
    envelope = _post(fixture, datasets=dict(fixture["datasets"], trade_docs=[])).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_doc_id_mismatch_400():
    envelope = _post(FACTS, request_body={"doc_id": 12}).json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    for fixture in (FACTS, CONSISTENCY):
        resp = _post(fixture)
        assert resp.status_code == 404
        assert resp.json()["code"] == "WORKSTATION_NOT_SUBSCRIBED"
        assert resp.json()["workstation"] == "trade-docs"


def test_new_rpc_paths_mapped_to_trade_docs_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(FACTS["rpc"]) == "trade-docs"
    assert workstation_of(CONSISTENCY["rpc"]) == "trade-docs"


@pytest.mark.parametrize("fn_name", ("facts_from_datasets", "consistency_from_datasets"))
def test_rpc_entry_has_no_db_access(fn_name):
    import inspect

    import ws_docs_hardening

    src = re.sub(r'""".*?"""', "",
                 inspect.getsource(getattr(ws_docs_hardening, fn_name)), flags=re.S)
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch", "conn.fetch"):
        assert forbidden not in src
