"""P2 同族只读切片金标：verify / formulas / spec ── 旧路径 vs 新路径（门面供数）。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6（契约）/ §6.6（金标双向锁）/ §8（首个
切片）/ §8.5.2（闸门踩坑）；契约与纪律同 calculate 切片
（tests/test_engine_rpc_quote_calculate.py）。

本文件锁四件事（**同一输入下改造前后响应 JSON 必须逐字段一致**）：
1. 旧路径（内核自取数）响应 == fixture.response，且实际执行的 SQL / 绑定参数 ==
   fixture.sql / sql_params（三条切片各一份 fixture）；
2. 新路径（POST /api/v1/internal/engine/quote/{verify,formulas,spec}，门面供 datasets）
   响应 == fixture.response，并且**零 DB 调用**（把 db.fetch / _acquire 换成炸弹）；
3. 同族两条闸门**随行**：
   · 工位订阅：新 RPC 路径必须被 WORKSTATION_PATHS["quotes"] 覆盖，未开通 → 404 同码同体；
   · 角色：旧 /verify 的 _require_internal_admin_dep（内部管理员）在新 RPC 上**同一份函数、
     同一优先级**（403 先于 422），403/401 逐字一致；
4. 错误分支一致（422 pydantic / 400 / 403 / 404）：旧 == 新，逐字。

fixture 由旧路径在同一台机器上生成
（backend/ts-migration/golden/gen_engine_quote_readonly_fixtures.py）；
TS 侧 tests/engine-quote-readonly.test.ts 读**同一份**文件。
⇒ 任一侧的供数语义漂移都会在 CI 变红；**禁止**在测试里自更新 fixture。
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
import ws_quote_ext  # noqa: E402
import ws_workstations  # noqa: E402

#: 本文件 load_main() 创建的那一代路由模块（跨测试文件 reload 后 sys.modules 会换人）
_MY_MODULES = {
    "main": worker_main,
    "quote_api": quote_api,
    "ws_quote_ext": ws_quote_ext,
    "ws_workstations": ws_workstations,
}

BACKEND = Path(__file__).resolve().parents[2]
GOLDEN_DIR = BACKEND / "ts-migration" / "golden"

SLICES = ("verify", "formulas", "spec", "explain")
FIXTURE = {
    name: json.loads(
        (GOLDEN_DIR / ("engine-quote-%s.fixture.json" % name)).read_text(encoding="utf-8"))
    for name in SLICES
}

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"

client = TestClient(worker_main.app, raise_server_exceptions=False)


# ── 既有金标 harness（复用其 JSON 语义 diff，不新写比较器）─────────────────────
def _load_harness():
    path = GOLDEN_DIR / "diff_responses.py"
    spec = importlib.util.spec_from_file_location("golden_diff_responses", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GOLDEN = _load_harness()


def _norm(sql: str) -> str:
    return re.sub(r"\s+", " ", sql).strip()


def _dumps(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# ── 桩连接（只用于**旧路径**：按 SQL 路由返回 fixture 里的行）─────────────────
class _OldPathDB:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []
        self.rows = json.loads(json.dumps(FIXTURE["verify"]["datasets"]))

    async def fake_fetch(self, request, sql, *args, table=None):
        self.calls.append((_norm(sql), list(args)))
        if "FROM tenant_products" in sql:
            return [dict(r) for r in self.rows["tenant_products"]]
        if "FROM customer_cost_items" in sql:
            return [dict(r) for r in self.rows["customer_cost_items"]]
        raise AssertionError("unexpected SQL in old path: " + sql)


def _old_actor(name: str) -> dict:
    """旧路径的 users 行 = fixture.actor + _get_current_user 里其余列。"""
    actor = dict(FIXTURE[name]["actor"])
    actor.setdefault("email", "buyer@qa.test")
    actor.setdefault("display_name", "买家")
    actor.setdefault("status", "active")
    actor.setdefault("console_access", False)
    actor.setdefault("plan", "free")
    return actor


@pytest.fixture()
def old_path_db(monkeypatch):
    """旧路径：走内核自取数（db.fetch 桩）+ 注入当前用户（verify 用管理员 fixture）。"""
    stub = _OldPathDB()
    monkeypatch.setattr(worker_main.db, "fetch", stub.fake_fetch)
    try:
        yield stub
    finally:
        worker_main.app.dependency_overrides.clear()


def _as_user(name: str):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = (
        lambda: _old_actor(name))


@pytest.fixture(autouse=True)
def _align_module_generation():
    """把 sys.modules 里的 worker 路由模块对齐到**本文件**那一代。

    为什么需要：pytest 先 import 全部测试文件，每个文件都会 _bootstrap.load_main()
    重载路由模块 ⇒ 跑本文件用例时 sys.modules 指向的是**最后**被 import 的文件那一代。
    /explain 的 handler（ws_quote_ext，既有代码）内部用 `import quote_api` 取模块；
    若不对齐，它拿到别代模块（其 _db 未被本文件的桩替换，_resolve 还会静默降级成
    注册表回退）⇒ 假失败。只在本文件用例期间生效，退出时原样还原。
    """
    saved = {name: sys.modules.get(name) for name in _MY_MODULES}
    sys.modules.update(_MY_MODULES)
    try:
        yield
    finally:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    # 工位闸门默认放行（真正的拦截由 test_workstation_gate_* 用 _cached_codes 显式验证）：
    # 否则每个用例都会去打不存在的 DB 连接（中间件内部兜底，但产物噪音大）。
    async def _allow_all(request, user_id):
        return frozenset({"full_chain"})

    monkeypatch.setattr(ws_workstations, "_cached_codes", _allow_all)


def _engine_token(name: str, secret: str = JWT_SECRET, **claims) -> str:
    actor = FIXTURE[name]["actor"]
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


def _rpc_body(name: str, request: dict | None = None, datasets: dict | None = None) -> dict:
    fixture = FIXTURE[name]
    return {
        "request": dict(fixture["request"]) if request is None else dict(request),
        "actor": dict(fixture["actor"]),
        "datasets": json.loads(json.dumps(fixture["datasets"])) if datasets is None else datasets,
    }


def _post_rpc(name: str, body: dict | None = None, token: str | None = None):
    data = _rpc_body(name) if body is None else body
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(name))
    return client.post(FIXTURE[name]["rpc"], json=data, headers=headers)


def _old_request(name: str):
    """按 fixture 的 method/path/query_string 打旧路径。"""
    endpoint = FIXTURE[name]["endpoint"]
    path = endpoint["path"]
    if endpoint.get("query_string"):
        path = path + "?" + endpoint["query_string"]
    if endpoint["method"] == "POST":
        request = FIXTURE[name]["request"]
        # explain 的 product_key 在路径上，正文是 request.body（其余 POST 切片正文 = request）
        payload = request["body"] if name == "explain" else request
        return client.post(path, json=payload)
    return client.get(path)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（改造前）：响应 / SQL / 绑定参数必须等于 fixture（三条各一份）
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("name", SLICES)
def test_old_path_response_and_sql_match_fixture(name, old_path_db):
    _as_user(name)
    resp = _old_request(name)
    assert resp.status_code == 200, resp.text
    assert resp.json() == FIXTURE[name]["response"], (
        "旧路径响应与 fixture 不一致（引擎/契约变了？）")

    sqls = {_norm(sql): args for sql, args in old_path_db.calls}
    # 该端点的 dataset 集合以 fixture 为准（explain 旧路径**只**读 tenant_products）
    for dataset, sql in FIXTURE[name]["sql"].items():
        assert sqls[sql] == FIXTURE[name]["sql_params"][dataset], dataset

    # verify 与 calculate 同款：同一份定价数据查两次（自建档位 + 成本表）；
    # formulas / spec 各查一次（客户自定义档位合并）；explain 只查产品定义一次。
    expected_calls = {"verify": 3, "formulas": 2, "spec": 2, "explain": 1}[name]
    assert len(old_path_db.calls) == expected_calls
    assert len(sqls) == len(FIXTURE[name]["sql"])


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（改造后）：同一输入 → 与旧路径逐字段一致，且零 DB 调用
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("name", SLICES)
def test_new_path_identical_to_old_and_fixture(name, old_path_db):
    _as_user(name)
    old = _old_request(name).json()

    async def _boom(*a, **kw):  # 新路径禁止碰库
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    old_fetch = worker_main.db.fetch
    worker_main.app.dependency_overrides.clear()
    worker_main.db.fetch = _boom
    try:
        resp = _post_rpc(name)
    finally:
        worker_main.db.fetch = old_fetch
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == 200
    new = envelope["body"]

    # ① 严格 JSON 相等（sort_keys 口径能抓到 7 vs 7.0 这类序列化差异）
    assert _dumps(new) == _dumps(old)
    # ② 逐字段 == fixture（改造前后同一个基线）
    assert _dumps(new) == _dumps(FIXTURE[name]["response"])
    # ③ 既有金标 harness 的语义 diff：空 = 零差异
    assert GOLDEN.diff_bodies(old, new) == []


@pytest.mark.parametrize("name", SLICES)
def test_new_path_zero_db_calls(name):
    """新路径不得调用 db.fetch；也不得 acquire 连接（handler 内 acquire ⇒ 500）。"""
    calls: list[str] = []

    async def _spy(*a, **kw):
        calls.append("fetch")
        raise AssertionError("新路径不得访问数据库")

    async def _acquire_boom(*a, **kw):
        raise AssertionError("新路径不得 acquire 连接")

    old_fetch = worker_main.db.fetch
    old_acquire = worker_main._acquire
    worker_main.db.fetch = _spy
    worker_main._acquire = _acquire_boom
    try:
        resp = _post_rpc(name)
    finally:
        worker_main.db.fetch = old_fetch
        worker_main._acquire = old_acquire
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 闸门一：工位订阅（新 RPC 路径必须被 WORKSTATION_PATHS["quotes"] 覆盖）
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("name", SLICES)
def test_new_rpc_path_mapped_to_quotes_workstation(name):
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(FIXTURE[name]["rpc"]) == "quotes", (
        "新内部 RPC 路径未登记 WORKSTATION_PATHS['quotes'] ⇒ 未开通工位可绕过商业限制"
        "（2026-10-24 灰度踩坑，见 docs/P2_COUPLING_ENGINE_2026-10-24.md §8.5.2）")


def test_workstation_gate_blocks_unsubscribed_on_new_rpc(monkeypatch):
    """未开通 quotes ⇒ 中间件在 handler 之前 404（同码同体，形状不是 RPC 信封）。"""
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    for name in SLICES:
        resp = _post_rpc(name)
        assert resp.status_code == 404, name
        assert resp.json() == {
            "error": "not_found",
            "code": "WORKSTATION_NOT_SUBSCRIBED",
            "workstation": "quotes",
            "detail": "该工位未开通，请在“工位开通”里启用",
        }, name


def test_workstation_gate_returns_same_body_as_old_path(monkeypatch):
    """旧端点与新 RPC 的工位闸门 404 **逐字相同**（同一张映射表 + 同一份中间件）。"""
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    # 旧路径必须带**用户**令牌：中间件只处理带 token 的请求（无 token 一律放行，
    # 认证交给路由依赖），否则这里根本走不到闸门。
    user_token = worker_main._create_token(FIXTURE["formulas"]["actor"]["id"])
    old = client.get(
        FIXTURE["formulas"]["endpoint"]["path"],
        headers={"Authorization": "Bearer " + user_token},
    )
    new = _post_rpc("formulas")
    assert old.status_code == 404
    assert new.status_code == 404
    assert new.json() == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 4. 闸门二：角色（verify 的管理员判定必须随行且逐字一致）
# ════════════════════════════════════════════════════════════════════════════

def _non_admin_actor() -> dict:
    return {
        "id": 5, "account_type": "customer", "role": "owner", "team_id": 2,
        "is_tenant_admin": False,
    }


def _owner_token(**claims) -> str:
    return _engine_token(
        "verify",
        sub=str(5),
        team_id=2,
        role="owner",
        account_type="customer",
        is_tenant_admin=False,
        **claims,
    )


def test_verify_non_admin_403_same_body(old_path_db):
    _as_user("formulas")  # 普通账号
    old_resp = _old_request("verify")
    assert old_resp.status_code == 403

    body = _rpc_body("verify")
    body["actor"] = _non_admin_actor()
    new_resp = _post_rpc("verify", body, token=_owner_token())
    assert new_resp.status_code == 200
    envelope = new_resp.json()
    assert envelope["status"] == 403
    assert envelope["body"] == old_resp.json()
    assert envelope["body"]["detail"]["error"] == "forbidden"


def test_verify_admin_gate_precedes_body_validation(old_path_db):
    """旧依赖在 body 解析**之前**跑（PARITY-QUOTE-22）⇒ 非管理员发坏 body 得 403 不是 422。

    新 RPC 必须同序：_require_internal_admin 先于 _CalculateIn 校验。
    """
    bad = {k: v for k, v in FIXTURE["verify"]["request"].items() if k != "fx_rate"}
    _as_user("formulas")
    old_resp = client.post("/api/v1/export-quote/verify", json=bad)
    assert old_resp.status_code == 403

    body = _rpc_body("verify", request=bad)
    body["actor"] = _non_admin_actor()
    new_resp = _post_rpc("verify", body, token=_owner_token())
    envelope = new_resp.json()
    assert envelope["status"] == 403, envelope
    assert envelope["body"] == old_resp.json()


# ════════════════════════════════════════════════════════════════════════════
# 5. 错误分支一致性（旧 vs 新：status + body 逐字相同）
# ════════════════════════════════════════════════════════════════════════════

def test_negative_verify_missing_fx_rate_422_same(old_path_db):
    _as_user("verify")
    bad = {k: v for k, v in FIXTURE["verify"]["request"].items() if k != "fx_rate"}
    old_resp = client.post("/api/v1/export-quote/verify", json=bad)
    new_resp = _post_rpc("verify", _rpc_body("verify", request=bad))
    assert old_resp.status_code == 422
    envelope = new_resp.json()
    assert envelope["status"] == 422
    assert envelope["body"] == old_resp.json()


def test_negative_verify_unknown_product_400_same(old_path_db):
    _as_user("verify")
    req = dict(FIXTURE["verify"]["request"], product_key="no_such_product")
    old_path_db.rows = {"tenant_products": [], "customer_cost_items": []}
    old_resp = client.post("/api/v1/export-quote/verify", json=req)
    body = _rpc_body("verify", request=req,
                     datasets={"tenant_products": [], "customer_cost_items": []})
    new_resp = _post_rpc("verify", body)
    assert old_resp.status_code == 400
    envelope = new_resp.json()
    assert envelope["status"] == 400
    assert envelope["body"] == old_resp.json()


def test_negative_formulas_unknown_product_404_same(old_path_db):
    _as_user("formulas")
    old_path_db.rows = {"tenant_products": [], "customer_cost_items": []}
    old_resp = client.get("/api/v1/export-quote/products/no_such_product/formulas")
    body = _rpc_body(
        "formulas",
        request={"product_key": "no_such_product", "query": {}},
        datasets={"tenant_products": [], "customer_cost_items": []},
    )
    new_resp = _post_rpc("formulas", body)
    assert old_resp.status_code == 404
    envelope = new_resp.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old_resp.json()


def test_negative_formulas_bad_bool_query_422_same(old_path_db):
    """query 布尔非法值：旧路径 FastAPI 422，新路径同一份 pydantic 口径 422 逐字相同。"""
    _as_user("formulas")
    old_resp = client.get(
        "/api/v1/export-quote/products/field_fence/formulas?with_columns=xyz")
    body = _rpc_body("formulas", request={
        "product_key": "field_fence", "query": {"with_columns": "xyz"}})
    new_resp = _post_rpc("formulas", body)
    assert old_resp.status_code == 422
    envelope = new_resp.json()
    assert envelope["status"] == 422
    assert envelope["body"] == old_resp.json()


def test_negative_spec_unknown_product_404_same(old_path_db):
    _as_user("spec")
    old_path_db.rows = {"tenant_products": [], "customer_cost_items": []}
    old_resp = client.get("/api/v1/export-quote/products/no_such_product/spec")
    body = _rpc_body(
        "spec",
        request={"product_key": "no_such_product"},
        datasets={"tenant_products": [], "customer_cost_items": []},
    )
    new_resp = _post_rpc("spec", body)
    assert old_resp.status_code == 404
    envelope = new_resp.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old_resp.json()


def test_negative_explain_unknown_product_404_same(old_path_db):
    _as_user("explain")
    empty = {"tenant_products": [], "customer_cost_items": []}
    old_path_db.rows = empty
    req = {"product_key": "no_such_product", "body": {"spec": {}}}
    old_resp = client.post(
        "/api/v1/export-quote/products/no_such_product/explain", json={"spec": {}})
    new_resp = _post_rpc("explain", _rpc_body("explain", request=req, datasets=empty))
    assert old_resp.status_code == 404
    envelope = new_resp.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old_resp.json()


def test_negative_explain_missing_variant_400_same(old_path_db):
    _as_user("explain")
    req = {"product_key": "field_fence", "body": {"spec": {}}}
    old_resp = client.post(
        "/api/v1/export-quote/products/field_fence/explain", json={"spec": {}})
    new_resp = _post_rpc("explain", _rpc_body("explain", request=req))
    assert old_resp.status_code == 400
    envelope = new_resp.json()
    assert envelope["status"] == 400
    assert envelope["body"] == old_resp.json()


#: 草稿定义（形状同 test_four_domains._EXPLAIN_DRAFT，但只用于「不读库」这条断言）
_EXPLAIN_DRAFT = {
    "name": "草稿产品",
    "numeric_inputs": [{"key": "height_m", "label": "网高(m)", "default": 1.2}],
    "derived": [{"name": "height_mm", "expr": "height_m * 1000", "unit": "mm"}],
}


def test_explain_spec_override_needs_no_datasets(old_path_db):
    """spec_override 分支旧路径**完全不读库**；新路径同样（也不注入产品定义）。"""
    _as_user("explain")
    body = {"spec": {"height_m": 1.5}, "spec_override": _EXPLAIN_DRAFT}
    old_resp = client.post(
        "/api/v1/export-quote/products/field_fence/explain", json=body)
    assert old_resp.status_code == 200, old_resp.text
    req = {"product_key": "field_fence", "body": body}
    new_resp = _post_rpc(
        "explain",
        _rpc_body("explain", request=req,
                  datasets={"tenant_products": [], "customer_cost_items": []}),
    )
    envelope = new_resp.json()
    assert envelope["status"] == 200
    assert envelope["body"] == old_resp.json()
    assert old_path_db.calls == [], "spec_override 分支旧路径也不得读库"


def test_explain_product_override_does_not_leak_to_old_path(old_path_db):
    """注入槽挂在**本次请求对象**上（per-request）—— 旧路径的新请求仍必须真读库。"""
    _post_rpc("explain")                      # 新路径：注入产品定义
    assert old_path_db.calls == []            # 新路径零 DB
    _as_user("explain")
    resp = _old_request("explain")            # 旧路径：必须真的读库（注入已 reset）
    assert resp.status_code == 200
    assert len(old_path_db.calls) == 1


# ════════════════════════════════════════════════════════════════════════════
# 6. 内部鉴权（沿用 mintInternalJwt 口径 + kaas_internal claim）
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("name", SLICES)
def test_rpc_requires_bearer(name):
    resp = _post_rpc(name, token=False)
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "unauthorized"


@pytest.mark.parametrize("name", SLICES)
def test_rpc_rejects_plain_user_jwt(name):
    """普通用户会话 JWT 与内部 JWT 同一把 secret ⇒ 必须靠 claim 区分。"""
    now = datetime.now(timezone.utc)
    user_jwt = jwt.encode(
        {"sub": str(FIXTURE[name]["actor"]["id"]), "iat": now,
         "exp": now + timedelta(minutes=60)},
        JWT_SECRET, algorithm="HS256",
    )
    assert _post_rpc(name, token=user_jwt).status_code == 401


@pytest.mark.parametrize("name", SLICES)
def test_rpc_rejects_actor_mismatch(name):
    body = _rpc_body(name)
    body["actor"]["team_id"] = 999
    resp = _post_rpc(name, body)
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_rpc_payload_invalid"


def test_rpc_rejects_bad_datasets_shape():
    body = _rpc_body("spec")
    body["datasets"]["tenant_products"] = "not-a-list"
    resp = _post_rpc("spec", body)
    assert resp.status_code == 200
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


# ════════════════════════════════════════════════════════════════════════════
# 7. 「一处实现」守卫：RPC 接线里不许出现取数代码 / 算法复制
# ════════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("fn_name", (
    "verify_from_datasets", "formulas_from_datasets", "spec_from_datasets"))
def test_from_datasets_has_no_db_access(fn_name):
    import inspect

    src = re.sub(r'""".*?"""', "", inspect.getsource(getattr(quote_api, fn_name)), flags=re.S)
    for forbidden in ("_db.", "_acquire", "asyncpg"):
        assert forbidden not in src, fn_name + " 不得包含取数代码: " + forbidden


def test_verify_from_datasets_reuses_the_same_admin_gate():
    """角色闸门必须是**同一份**函数（禁止新入口另写判定）。"""
    import inspect

    src = inspect.getsource(quote_api.verify_from_datasets)
    assert "_require_internal_admin(user)" in src
