"""P2 首个端到端切片金标：/export-quote/calculate 旧路径 vs 新路径（门面供数）。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6.6 / §8；契约 = §6。

本文件锁三件事（**同一输入下改造前后响应 JSON 必须逐字段一致**）：
1. 旧路径（内核自取数）响应 == fixture.response，且它实际执行的 SQL / 绑定参数 == fixture.sql/params；
2. 新路径（POST /internal/engine/quote/calculate，门面供 datasets）响应 == fixture.response；
   并且**零 DB 调用**（把 db.fetch 换成炸弹，仍然返回同一结果）；
3. 旧/新两条路径在错误分支上同样一致（422 pydantic / 400 engine_error / 409 spec_upstream_changed）。

fixture 由旧路径在同一台机器上生成（backend/ts-migration/golden/engine-quote-calculate.fixture.json），
TS 侧 tests/engine-quote-calculate.test.ts 读**同一份**文件断言「门面发出的 SQL == fixture.sql、
发给内核的 datasets == fixture.datasets、回放 == fixture.response」。
⇒ 任一侧的供数语义漂移都会在 CI 变红；**禁止**在测试里自更新 fixture。
重新生成（仅在**故意**改响应形状时）：backend/ts-migration/golden/gen_engine_quote_calculate_fixture.py
（幂等；提交 PR 时须人工 review fixture 的 response diff）。
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import jwt  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2]
FIXTURE_PATH = BACKEND / "ts-migration" / "golden" / "engine-quote-calculate.fixture.json"
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
RPC = FIXTURE["rpc"]
ACTOR = FIXTURE["actor"]
DATASETS = FIXTURE["datasets"]

client = TestClient(worker_main.app, raise_server_exceptions=False)


# ── 既有金标 harness（复用其 JSON 语义 diff，不新写比较器）─────────────────────
def _load_harness():
    path = BACKEND / "ts-migration" / "golden" / "diff_responses.py"
    spec = importlib.util.spec_from_file_location("golden_diff_responses", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GOLDEN = _load_harness()


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


# ── 桩连接（只用于**旧路径**：按 SQL 路由返回 fixture 里的行）─────────────────
class _OldPathDB:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []
        self.rows = json.loads(json.dumps(DATASETS))

    async def fake_fetch(self, request, sql, *args, table=None):
        self.calls.append((_norm(sql), list(args)))
        if "FROM tenant_products" in sql:
            return [dict(r) for r in self.rows["tenant_products"]]
        if "FROM customer_cost_items" in sql:
            return [dict(r) for r in self.rows["customer_cost_items"]]
        raise AssertionError("unexpected SQL in old path: " + sql)


@pytest.fixture()
def old_path_db(monkeypatch):
    """旧路径：走内核自取数（db.fetch 桩），并注入当前用户。"""
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    stub = _OldPathDB()
    monkeypatch.setattr(worker_main.db, "fetch", stub.fake_fetch)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(
        ACTOR,
        email="buyer@qa.test",
        display_name="买家",
        status="active",
        console_access=False,
        plan="free",
    )
    try:
        yield stub
    finally:
        worker_main.app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)


def _engine_token(secret: str = JWT_SECRET, **claims) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(ACTOR["id"]),
        "tenant_id": "default",
        "team_id": ACTOR["team_id"],
        "role": ACTOR["role"],
        "account_type": ACTOR["account_type"],
        "is_tenant_admin": ACTOR["is_tenant_admin"],
        "kaas_internal": "engine",
        "iat": now,
        "exp": now + timedelta(seconds=60),
    }
    payload.update(claims)
    return jwt.encode(payload, secret, algorithm="HS256")


def _rpc_body(**over) -> dict:
    body = {
        "request": dict(FIXTURE["request"]),
        "actor": dict(ACTOR),
        "datasets": json.loads(json.dumps(DATASETS)),
    }
    body.update(over)
    return body


def _post_rpc(body: dict | None = None, token: str | None = None):
    data = body if body is not None else _rpc_body()
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token())
    return client.post(RPC, json=data, headers=headers)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（改造前）：响应 / SQL / 绑定参数必须等于 fixture
# ════════════════════════════════════════════════════════════════════════════

def test_old_path_response_and_sql_match_fixture(old_path_db):
    resp = client.post(FIXTURE["endpoint"]["path"], json=FIXTURE["request"])
    assert resp.status_code == 200, resp.text
    assert resp.json() == FIXTURE["response"], "旧路径响应与 fixture 不一致（引擎/契约变了？）"

    sqls = {_norm(sql): args for sql, args in old_path_db.calls}
    assert sqls[FIXTURE["sql"]["tenant_products"]] == FIXTURE["sql_params"]["tenant_products"]
    assert sqls[FIXTURE["sql"]["customer_cost_items"]] == FIXTURE["sql_params"]["customer_cost_items"]
    # 旧路径确实查了两次定价数据（客户自建档位 + 成本表）—— 新路径合并为一次供数
    assert len(old_path_db.calls) == 3
    assert len(sqls) == 2


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（改造后）：同一输入 → 与旧路径逐字段一致，且零 DB 调用
# ════════════════════════════════════════════════════════════════════════════

def test_new_path_response_identical_to_old_and_fixture(old_path_db, monkeypatch):
    old = client.post(FIXTURE["endpoint"]["path"], json=FIXTURE["request"]).json()

    async def _boom(*a, **kw):  # 新路径禁止碰库
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    monkeypatch.setattr(worker_main.db, "fetch", _boom)
    # 连 _acquire 也不允许（异步函数抛错即可）；用 monkeypatch 保证用例后自动归位
    monkeypatch.setattr(worker_main, "_acquire", _boom)

    resp = _post_rpc()
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == 200
    new = envelope["body"]

    # ① 严格 JSON 相等（sort_keys 口径能抓到 7 vs 7.0 这类序列化差异）
    assert json.dumps(new, sort_keys=True, ensure_ascii=False) == json.dumps(
        old, sort_keys=True, ensure_ascii=False
    )
    # ② 逐字段 == fixture（改造前后同一个基线）
    assert json.dumps(new, sort_keys=True) == json.dumps(FIXTURE["response"], sort_keys=True)
    # ③ 既有金标 harness 的语义 diff：空 = 零差异
    assert GOLDEN.diff_bodies(old, new) == []


def test_new_path_registry_fallback_when_no_tenant_row():
    """datasets.tenant_products 为空 ⇒ 回退 Python 注册表（与旧路径同分支）。"""
    body = _rpc_body()
    body["datasets"]["tenant_products"] = []
    resp = _post_rpc(body)
    assert resp.status_code == 200
    assert resp.json()["status"] == 200
    assert resp.json()["body"]["meta"]["product_key"] == "field_fence"


# ════════════════════════════════════════════════════════════════════════════
# 3. 错误分支一致性（旧 vs 新：status + body 逐字相同）
# ════════════════════════════════════════════════════════════════════════════

def _pair_negative(old_path_db, request_body: dict, datasets: dict | None = None):
    """同一份行数据分别喂给旧路径（db 桩）与新路径（payload）⇒ 错误必须逐字相同。"""
    if datasets is not None:
        old_path_db.rows = json.loads(json.dumps(datasets))
    old_resp = client.post(FIXTURE["endpoint"]["path"], json=request_body)
    body = _rpc_body(request=request_body)
    if datasets is not None:
        body["datasets"] = datasets
    new_resp = _post_rpc(body)
    return old_resp, new_resp


def test_negative_missing_fx_rate_422_same(old_path_db):
    req = {k: v for k, v in FIXTURE["request"].items() if k != "fx_rate"}
    old_resp, new_resp = _pair_negative(old_path_db, req)
    assert old_resp.status_code == 422
    envelope = new_resp.json()
    assert envelope["status"] == 422
    assert envelope["body"] == old_resp.json()


def test_negative_unknown_product_400_same(old_path_db):
    req = dict(FIXTURE["request"], product_key="no_such_product")
    old_resp, new_resp = _pair_negative(old_path_db, req, {"tenant_products": [], "customer_cost_items": []})
    assert old_resp.status_code == 400
    envelope = new_resp.json()
    assert envelope["status"] == 400
    assert envelope["body"] == old_resp.json()


def test_negative_spec_override_hash_mismatch_same(old_path_db):
    """override 的 base_spec_hash 对不上：与旧路径**同样**失败（当前都是 500）。

    2026-10-24 审计发现：quote_api 注释声称这里会 409 SPEC_UPSTREAM_CHANGED，
    但 resolve_effective_product 并不调用 assert_base_hash_match，实际是
    spec_delta.apply_delta 抛 SpecDeltaError（未捕获 ⇒ 500）。这是共享内核的既有
    分支缺口（算法冻结，本切片不改），已登记 docs/P2_COUPLING_ENGINE_2026-10-24.md §9。
    本用例只锁「新旧路径同行为」，避免切片把既有错误语义改掉。
    """
    datasets = json.loads(json.dumps(DATASETS))
    datasets["tenant_products"][0]["override"] = {"base_spec_hash": "deadbeef"}
    old_resp, new_resp = _pair_negative(old_path_db, FIXTURE["request"], datasets)
    assert old_resp.status_code == 500
    assert new_resp.status_code == 500
    assert new_resp.text == old_resp.text


# ════════════════════════════════════════════════════════════════════════════
# 4. 内部鉴权（沿用 mintInternalJwt 口径 + kaas_internal claim）
# ════════════════════════════════════════════════════════════════════════════

def test_rpc_requires_bearer():
    resp = _post_rpc(token=False)
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "unauthorized"


def test_rpc_rejects_plain_user_jwt():
    """普通用户会话 JWT 与内部 JWT 同一把 secret ⇒ 必须靠 claim 区分。"""
    now = datetime.now(timezone.utc)
    user_jwt = jwt.encode(
        {"sub": str(ACTOR["id"]), "iat": now, "exp": now + timedelta(minutes=60)},
        JWT_SECRET, algorithm="HS256",
    )
    resp = _post_rpc(token=user_jwt)
    assert resp.status_code == 401


def test_rpc_rejects_expired_and_wrong_secret():
    expired = _engine_token(exp=datetime.now(timezone.utc) - timedelta(seconds=5))
    assert _post_rpc(token=expired).status_code == 401
    wrong = _engine_token(secret="another-secret-value-1234567890!!")
    assert _post_rpc(token=wrong).status_code == 401


def test_rpc_rejects_actor_mismatch():
    body = _rpc_body()
    body["actor"]["team_id"] = 999
    resp = _post_rpc(body)
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_rpc_payload_invalid"


def test_rpc_rejects_bad_datasets_shape():
    body = _rpc_body()
    body["datasets"]["tenant_products"] = "not-a-list"
    resp = _post_rpc(body)
    assert resp.status_code == 200
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


# ════════════════════════════════════════════════════════════════════════════
# 5. 「一处实现」守卫：RPC 接线里不许出现取数代码 / 算法复制
# ════════════════════════════════════════════════════════════════════════════

def test_rpc_module_does_not_touch_db():
    import engine_api

    # 只看代码（去掉 docstring）：模块文档里会提到纪律关键词
    src = re.sub(r'"""..*?"""', "", Path(engine_api.__file__).read_text(encoding="utf-8"), flags=re.S)
    for forbidden in ("asyncpg", "_acquire", "platform.db", "db.fetch"):
        assert forbidden not in src, "engine_api.py 不得包含取数代码: " + forbidden


def test_calculate_from_datasets_has_no_db_access():
    import inspect

    import quote_api

    src = re.sub(r'"""..*?"""', "", inspect.getsource(quote_api.calculate_from_datasets), flags=re.S)
    for forbidden in ("_db.", "_acquire", "asyncpg"):
        assert forbidden not in src, "calculate_from_datasets 不得包含取数代码: " + forbidden