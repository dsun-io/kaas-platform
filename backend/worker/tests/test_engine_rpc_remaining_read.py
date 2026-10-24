"""P3 第七批金标：GET /api/v1/pricing-data（定价数据矩阵）旧 vs 新。

范式同前几批：旧路径（自取数）响应/SQL == fixture；新路径（供数 RPC）零 DB 且
body == 旧 == fixture；负例（401/403/404/422/工位 404）逐字一致；判定复用同一份
（_extensions_from_items / extend_product / describe_pricing_key / _matrix_rows）。

注意：现有注册表产品的 pricing_key 都至少有一个维度只声明字段不声明选项 ⇒
_matrix_rows 恒为空，response.rows 为空（产品定义现状，非切片引入）；本 fixture
锁的是「dims + 空 rows + scope 口径」不变。

fixture 由旧路径生成（backend/ts-migration/golden/gen_engine_pricing_data_fixture.py）；
TS 侧 tests/engine-remaining-read.test.ts 读同一份。**禁止**在测试里自更新 fixture。
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
PRICING = json.loads(
    (GOLDEN / "engine-pricing-data.fixture.json").read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
ACTOR = PRICING["actor"]
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
    def __init__(self):
        self.calls: list = []

    async def fetch(self, request, sql, *args, **kwargs):
        self.calls.append((_norm(sql), list(args)))
        if "FROM customer_cost_items" in sql:
            return [_py_item(r) for r in PRICING["datasets"]["customer_cost_items"]]
        raise AssertionError("unexpected db.fetch: " + sql)


def _py_item(row: dict) -> dict:
    out = dict(row)
    for field in ("effective_from", "created_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
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
    stub = _OldPathDB()
    monkeypatch.setattr(worker_main.db, "fetch", stub.fetch)
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


def _post(*, query: dict | None = None, actor: dict | None = None,
          datasets: dict | None = None, token: str | None = None):
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(actor=actor))
    body = {
        "request": {"query": dict(PRICING["request"]["query"]) if query is None else query},
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": json.loads(json.dumps(PRICING["datasets"])) if datasets is None else datasets,
    }
    return client.post(PRICING["rpc"], json=body, headers=headers)


def _bomb_db(monkeypatch):
    async def _boom(*a, **kw):
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _boom, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _boom)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（提取后）：响应 + SQL/参数/顺序 == fixture
# ════════════════════════════════════════════════════════════════════════════

def test_old_path_response_and_sql_match_fixture(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    resp = client.get("/api/v1/pricing-data?" + PRICING["endpoint"]["query_string"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == PRICING["response"]
    assert len(old_path_db.calls) == len(PRICING["old_sql"])
    for actual, expected in zip(old_path_db.calls, PRICING["old_sql"]):
        assert actual[0] == expected["sql"]
        assert actual[1] == expected["params"]


def test_old_path_two_identical_queries(old_path_db):
    """旧 handler 对同一份定价数据查两次（客户自建档位 + 成本表），这是 fixture 的形态。"""
    old_path_db.calls.clear()
    _as_user()
    client.get("/api/v1/pricing-data?" + PRICING["endpoint"]["query_string"])
    assert old_path_db.calls[0] == old_path_db.calls[1]


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（供数 RPC）：body == 旧 == fixture，零 DB
# ════════════════════════════════════════════════════════════════════════════

def test_new_path_identical_to_old_and_fixture(old_path_db, monkeypatch):
    _as_user()
    old = client.get("/api/v1/pricing-data?" + PRICING["endpoint"]["query_string"]).json()
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    envelope = _post().json()
    assert envelope["status"] == 200
    assert _dumps(envelope["body"]) == _dumps(old)
    assert _dumps(envelope["body"]) == _dumps(PRICING["response"])
    assert GOLDEN_DIFF.diff_bodies(old, envelope["body"]) == []


def test_new_path_zero_db_calls(monkeypatch):
    calls: list = []

    async def _spy(*a, **kw):
        calls.append("db")
        raise AssertionError("新路径不得访问数据库")

    for name in ("fetch", "fetchval", "fetchrow", "execute", "acquire"):
        monkeypatch.setattr(worker_main.db, name, _spy, raising=False)
    monkeypatch.setattr(worker_main, "_acquire", _spy)
    assert _post().json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. scope=all（内部管理员）：同一份纯计算，客户分组来自 dataset
# ════════════════════════════════════════════════════════════════════════════

def test_all_scope_admin_old_equals_new(old_path_db, monkeypatch):
    admin = dict(ACTOR, account_type="internal", role="system_admin", team_id=None)
    _as_user(admin)
    old = client.get("/api/v1/pricing-data?product_key=field_fence&scope=all").json()
    assert old["scope"] == "all" and "customers" in old
    assert old["rows"] == PRICING["response"]["rows"]
    worker_main.app.dependency_overrides.clear()
    _bomb_db(monkeypatch)
    envelope = _post(query={"product_key": "field_fence", "scope": "all"},
                     actor=admin).json()
    assert envelope["status"] == 200
    assert _dumps(envelope["body"]) == _dumps(old)


# ════════════════════════════════════════════════════════════════════════════
# 4. 负例：401 / 403 / 404 / 422 逐字一致
# ════════════════════════════════════════════════════════════════════════════

def test_rpc_requires_bearer():
    assert _post(token=False).status_code == 401


def test_old_and_new_missing_product_key_422(tmp_path, old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/pricing-data")
    assert old.status_code == 422
    envelope = _post(query={"product_key": None, "scope": None}).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


def test_old_and_new_unknown_product_404(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/pricing-data?product_key=nope")
    assert old.status_code == 404
    envelope = _post(query={"product_key": "nope", "scope": None}).json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_old_and_new_bad_scope_422(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/pricing-data?product_key=field_fence&scope=bogus")
    assert old.status_code == 422
    envelope = _post(query={"product_key": "field_fence", "scope": "bogus"}).json()
    assert envelope["status"] == 422
    assert envelope["body"] == old.json()


def test_old_and_new_scope_all_non_admin_403(old_path_db):
    old_path_db.calls.clear()
    _as_user()
    old = client.get("/api/v1/pricing-data?product_key=field_fence&scope=all")
    assert old.status_code == 403
    envelope = _post(query={"product_key": "field_fence", "scope": "all"}).json()
    assert envelope["status"] == 403
    assert envelope["body"] == old.json()


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    resp = _post()
    assert resp.status_code == 404
    assert resp.json()["code"] == "WORKSTATION_NOT_SUBSCRIBED"
    assert resp.json()["workstation"] == "quotes"


def test_new_rpc_path_mapped_to_quotes_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(PRICING["rpc"]) == "quotes"


def test_rpc_entry_has_no_db_access():
    import inspect

    src = re.sub(r'""".*?"""', "",
                 inspect.getsource(worker_main.pricing_data_from_datasets), flags=re.S)
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch", "conn.fetch"):
        assert forbidden not in src
