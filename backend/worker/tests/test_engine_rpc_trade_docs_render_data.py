"""P2 第三个切片金标：GET /trade-docs/{doc_id}/render-data 旧路径 vs 新路径（门面供数）。

设计 = docs/P2_COUPLING_ENGINE_2026-10-24.md §6.3（dataset 契约）/ §9 第 2 项；与 export-quote
同族切片同一个金标范式（backend/worker/tests/test_engine_rpc_quote_readonly.py）。

本文件锁五件事：
1. **提取不变**（main.py/ws_files.py 的纯装配提取是行为不变的）：旧路径响应 == fixture.response，
   且旧路径实际执行的 SQL 文本/绑定参数/顺序 == fixture.old_sql；
2. 新路径（POST /api/v1/internal/engine/trade-docs/render-data，门面供 7 个 dataset）
   响应 == fixture.response，并且**零 DB 调用**（把 db.fetchrow/fetch/_acquire 换成炸弹）；
3. 门禁随行：工位订阅（新前缀 /api/v1/internal/engine/trade-docs → trade-docs）与
   单证可见性（_require_doc_visible）都调用**同一份**既有判定；404/401 逐字一致；
4. 签名直链的 host 白名单：request_context 里白名单外的 host 必须回落默认 host
   （不能让任意 Host 影响签名 URL），并保留 /localhost/testserver 等 dev/测试宿主；
5. 一处实现：装配只有 _render_bundle_pure 一份（旧 handler 与 RPC 都调它），
   照片装配只有 ws_files._photo_entries_from_rows 一份；RPC 接线里没有取数代码。

fixture 由旧路径生成（backend/ts-migration/golden/gen_engine_trade_doc_render_data_fixture.py）；
TS 侧 tests/engine-trade-docs-render-data.test.ts 读**同一份**文件。
⇒ 任一侧的供数语义漂移都会在 CI 变红；**禁止**在测试里自更新 fixture。

⚠️ 签名直链含时间戳（token 的 exp = time.time() + 900）：本文件与生成器都把
kaas_common.files.token.time 冻结到 fixture.asset_time，否则 fixture 无法复现。
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

import main as worker_main_alias  # noqa: E402  (同名模块，取函数源码用)
import ws_files  # noqa: E402
import ws_workstations  # noqa: E402

BACKEND = Path(__file__).resolve().parents[2]
FIXTURE_PATH = (
    BACKEND / "ts-migration" / "golden" / "engine-trade-doc-render-data.fixture.json"
)
FIXTURE = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

JWT_SECRET = "p2-engine-test-secret-at-least-32-chars!!"
RPC = FIXTURE["rpc"]
ACTOR = FIXTURE["actor"]
DATASETS = FIXTURE["datasets"]
DOC_ID = FIXTURE["request"]["doc_id"]

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


def _dumps(value) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


# ── 冻结签名令牌的时钟（fixture 可复现；只作用于测试进程）────────────────────
@pytest.fixture(autouse=True)
def _frozen_asset_time(monkeypatch):
    token_mod = sys.modules["kaas_common.files.token"]

    class _FrozenTime:
        @staticmethod
        def time() -> float:
            return FIXTURE["asset_time"]

    monkeypatch.setattr(token_mod, "time", _FrozenTime)


# ── 桩连接（只用于**旧路径**：按 SQL 路由返回 fixture 里的行）─────────────────
def _py_trade_doc_row(row: dict) -> dict:
    """dataset 行 → 旧路径行形状（时间戳还原成 datetime；doc_dict 需要 datetime）。"""
    out = dict(row)
    for field in ("created_at", "issued_at", "updated_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    return out


class _OldPathDB:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []
        self.rows = json.loads(json.dumps(DATASETS))
        self.doc_missing = False
        self.invisible_team = None   # 非 None ⇒ file_objects 行只在该团队可见

    async def fake_fetchrow(self, request, sql, *args, table=None):
        self.calls.append((_norm(sql), list(args)))
        text = sql
        rows = self.rows
        if "FROM trade_docs" in text:
            if self.doc_missing:
                return None
            return _py_trade_doc_row(rows["trade_docs"][0])
        if "FROM tenant_company_profile" in text:
            return dict(rows["tenant_company_profile"][0]) if rows["tenant_company_profile"] else None
        if "FROM customers" in text:
            return dict(rows["customers"][0]) if rows["customers"] else None
        if "FROM cust_contacts" in text:
            return dict(rows["cust_contacts"][0]) if rows["cust_contacts"] else None
        if "FROM file_objects" in text:
            file_id = int(args[1])
            for row in rows["file_objects"]:
                if row["id"] != file_id:
                    continue
                if self.invisible_team is not None and row.get("team_id") != self.invisible_team:
                    continue
                return dict(row)
            return None
        if "FROM tenant_company_seals" in text:
            return dict(rows["tenant_company_seals"][0]) if rows["tenant_company_seals"] else None
        if "FROM product_profiles" in text:
            if not rows["product_profiles"]:
                return None
            return {k: rows["product_profiles"][0][k] for k in ("info", "team_id")}
        raise AssertionError("unexpected SQL in old path: " + sql)

    async def fake_fetch(self, *_a, **_kw):
        raise AssertionError("render-data 旧路径不应走 db.fetch（多行版）")


def _old_actor() -> dict:
    actor = dict(ACTOR)
    actor.setdefault("email", "buyer@qa.test")
    actor.setdefault("display_name", "买家")
    actor.setdefault("status", "active")
    actor.setdefault("console_access", False)
    actor.setdefault("plan", "free")
    return actor


@pytest.fixture()
def old_path_db(monkeypatch):
    """旧路径：走内核自取数（db.fetchrow 桩）+ 注入当前用户。"""
    stub = _OldPathDB()
    monkeypatch.setattr(worker_main.db, "fetchrow", stub.fake_fetchrow)
    monkeypatch.setattr(worker_main.db, "fetch", stub.fake_fetch)
    try:
        yield stub
    finally:
        worker_main.app.dependency_overrides.clear()


def _as_user(actor: dict | None = None) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = (
        lambda: dict(actor or _old_actor()))


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", JWT_SECRET)
    # 工位闸门默认放行（真正的拦截由 test_workstation_gate_* 用 _cached_codes 显式验证），
    # 否则每个用例都会去申请一个不存在的 DB 连接（中间件内部兜底，但噪音大）。
    async def _allow_all(request, user_id):
        return frozenset({"full_chain"})

    monkeypatch.setattr(ws_workstations, "_cached_codes", _allow_all)


# ── 旧端点 / RPC 请求构造 ───────────────────────────────────────────────────
def _old_url() -> str:
    return FIXTURE["endpoint"]["path"]


def _old_request():
    return client.get(_old_url())


def _engine_token(*, secret: str = JWT_SECRET, actor: dict | None = None,
                  **claims) -> str:
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


def _rpc_body(*, request: dict | None = None, actor: dict | None = None,
              datasets: dict | None = None) -> dict:
    return {
        "request": dict(FIXTURE["request"]) if request is None else dict(request),
        "actor": dict(ACTOR) if actor is None else dict(actor),
        "datasets": (json.loads(json.dumps(DATASETS))
                     if datasets is None else datasets),
    }


def _post_rpc(body: dict | None = None, token: str | None = None,
              actor: dict | None = None):
    data = _rpc_body() if body is None else body
    headers = {}
    if token is not False:
        headers["Authorization"] = "Bearer " + (token or _engine_token(actor=actor))
    return client.post(RPC, json=data, headers=headers)


# ════════════════════════════════════════════════════════════════════════════
# 1. 旧路径（提取后）：响应 + SQL 文本/参数/顺序必须与 fixture（= 提取前）一致
# ════════════════════════════════════════════════════════════════════════════

def test_old_path_response_and_sql_match_fixture(old_path_db):
    _as_user()
    resp = _old_request()
    assert resp.status_code == 200, resp.text
    assert resp.json() == FIXTURE["response"], (
        "旧路径响应与 fixture 不一致（提取改了装配顺序/判定）")

    # 提取前（fixture.old_sql 是 HEAD 版本真实产物）与提取后的 SQL 文本/参数/顺序逐条比对
    assert len(old_path_db.calls) == len(FIXTURE["old_sql"]), old_path_db.calls
    for actual, expected in zip(old_path_db.calls, FIXTURE["old_sql"]):
        assert actual[0] == expected["sql"], "SQL 文本变了（提取不得改谓词/列）"
        assert actual[1] == expected["params"], "绑定参数变了（提取不得改谓词）"


# ════════════════════════════════════════════════════════════════════════════
# 1b. 时间戳口径（docs §8.9 真库核对抓到的 parity 缺口）：零微秒 ⇒ **无小数**
# ════════════════════════════════════════════════════════════════════════════

_TS_NONZERO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$")
_TS_ZERO_US = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$")


def _assert_python_isoformat_precision(doc: dict) -> None:
    """fixture 必须同时覆盖两种口径；两种口径都必须与 Python isoformat 逐字一致。"""
    # 非零微秒 ⇒ 6 位小数
    assert _TS_NONZERO.match(doc["created_at"]), doc["created_at"]
    assert doc["created_at"] == "2026-10-20T02:30:00.123456+00:00"
    # 零微秒 ⇒ 无小数（这是 §8.9 的缺口：to_char 'US' 恒输出 .000000）
    assert _TS_ZERO_US.match(doc["issued_at"]), doc["issued_at"]
    assert doc["issued_at"] == "2026-10-21T08:00:00+00:00"
    assert _TS_ZERO_US.match(doc["updated_at"]), doc["updated_at"]
    assert doc["updated_at"] == "2026-10-24T03:04:05+00:00"


def test_fixture_response_timestamps_zero_and_nonzero_precision():
    """旧路径响应（= fixture.response）的时间戳口径。"""
    _assert_python_isoformat_precision(FIXTURE["response"]["doc"])


def test_dataset_timestamps_roundtrip_to_python_isoformat():
    """供数 dataset（门面 to_char 产物）→ 内核行形状还原 → 与 Python isoformat 逐字一致。

    注意 doc_dict 只对 created_at/issued_at 调 isoformat，updated_at 仍是 datetime ——
    与旧端点响应一致的口径是「FastAPI 序列化之后」的文本（jsonable_encoder），
    所以这里按响应口径断言，而不是按 dict 内部类型断言。
    """
    from fastapi.encoders import jsonable_encoder

    row = worker_main._trade_doc_row_from_dataset(
        json.loads(json.dumps(FIXTURE["datasets"]["trade_docs"][0])))
    doc = jsonable_encoder(worker_main._dp.doc_dict(row))
    _assert_python_isoformat_precision(doc)


def test_new_path_timestamps_zero_and_nonzero_precision():
    """端到端（供数 RPC）：零微秒无小数 / 非零 6 位，且与旧路径响应逐字相同。"""
    envelope = _post_rpc().json()
    assert envelope["status"] == 200
    _assert_python_isoformat_precision(envelope["body"]["doc"])
    assert envelope["body"]["doc"] == FIXTURE["response"]["doc"]


# ════════════════════════════════════════════════════════════════════════════
# 2. 新路径（门面供数）：同一输入 → 与旧路径逐字段一致，且零 DB 调用
# ════════════════════════════════════════════════════════════════════════════

def test_new_path_identical_to_old_and_fixture(old_path_db):
    _as_user()
    old = _old_request().json()

    async def _boom(*a, **kw):
        raise AssertionError("新路径（供数 RPC）不得访问数据库")

    old_fetchrow = worker_main.db.fetchrow
    old_fetch = worker_main.db.fetch
    worker_main.app.dependency_overrides.clear()
    worker_main.db.fetchrow = _boom
    worker_main.db.fetch = _boom
    try:
        resp = _post_rpc()
    finally:
        worker_main.db.fetchrow = old_fetchrow
        worker_main.db.fetch = old_fetch
    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope["status"] == 200
    new = envelope["body"]

    assert _dumps(new) == _dumps(old)
    assert _dumps(new) == _dumps(FIXTURE["response"])
    assert GOLDEN.diff_bodies(old, new) == []


def test_new_path_zero_db_calls():
    calls: list[str] = []

    async def _spy(*a, **kw):
        calls.append("db")
        raise AssertionError("新路径不得访问数据库")

    async def _acquire_boom(*a, **kw):
        raise AssertionError("新路径不得 acquire 连接")

    old_fetchrow = worker_main.db.fetchrow
    old_fetch = worker_main.db.fetch
    old_acquire = worker_main._acquire
    worker_main.db.fetchrow = _spy
    worker_main.db.fetch = _spy
    worker_main._acquire = _acquire_boom
    try:
        resp = _post_rpc()
    finally:
        worker_main.db.fetchrow = old_fetchrow
        worker_main.db.fetch = old_fetch
        worker_main._acquire = old_acquire
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == 200
    assert calls == []


# ════════════════════════════════════════════════════════════════════════════
# 3. 门禁一：工位订阅（render-data 属 trade-docs 工位）
# ════════════════════════════════════════════════════════════════════════════

def test_new_rpc_path_mapped_to_trade_docs_workstation():
    from kaas_common.workstation.subscriptions import workstation_of

    assert workstation_of(RPC) == "trade-docs", (
        "新内部 RPC 路径未登记 WORKSTATION_PATHS['trade-docs'] ⇒ 未开通工位可绕过商业限制"
        "（docs §8.5.2 的教训）")


def test_workstation_gate_blocks_unsubscribed(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    resp = _post_rpc()
    assert resp.status_code == 404
    assert resp.json() == {
        "error": "not_found",
        "code": "WORKSTATION_NOT_SUBSCRIBED",
        "workstation": "trade-docs",
        "detail": "该工位未开通，请在“工位开通”里启用",
    }


def test_workstation_gate_same_body_as_old_path(monkeypatch):
    async def _no_codes(request, user_id):
        return frozenset()

    monkeypatch.setattr(ws_workstations, "_cached_codes", _no_codes)
    user_token = worker_main._create_token(ACTOR["id"])
    old = client.get(_old_url(), headers={"Authorization": "Bearer " + user_token})
    new = _post_rpc()
    assert old.status_code == 404
    assert new.status_code == 404
    assert new.json() == old.json()


# ════════════════════════════════════════════════════════════════════════════
# 4. 门禁二：单证可见性（404 DOC_NOT_FOUND，新旧逐字一致；**不是** 403 NO_TEAM）
# ════════════════════════════════════════════════════════════════════════════

def test_negative_doc_not_found_404_same(old_path_db):
    old_path_db.doc_missing = True
    _as_user()
    old = _old_request()
    assert old.status_code == 404
    assert old.json()["detail"]["code"] == "DOC_NOT_FOUND"
    new = _post_rpc(_rpc_body(datasets=dict(DATASETS, trade_docs=[])))
    envelope = new.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_negative_invisible_doc_404_same(old_path_db):
    """别团队 + 非本人 + 非 tenant 共享 ⇒ 404（D3：不泄露存在性）。"""
    actor = dict(ACTOR, team_id=777)
    _as_user(actor)
    old = _old_request()
    assert old.status_code == 404
    new = _post_rpc(_rpc_body(actor=actor), actor=actor)
    envelope = new.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_negative_teamless_customer_404_same(old_path_db):
    """无团队客户：render-data 返回 **404 DOC_NOT_FOUND**（D3 口径），不是 403 NO_TEAM。"""
    actor = dict(ACTOR, team_id=None)
    _as_user(actor)
    old = _old_request()
    assert old.status_code == 404, old.text
    assert old.json()["detail"]["code"] == "DOC_NOT_FOUND"
    new = _post_rpc(_rpc_body(actor=actor), actor=actor)
    envelope = new.json()
    assert envelope["status"] == 404
    assert envelope["body"] == old.json()


def test_negative_team_mismatched_file_is_skipped(old_path_db):
    """别团队的图片行不得进响应（团队谓词在 SQL；新旧两条路径同一口径）。"""
    old_path_db.invisible_team = 999
    _as_user()
    old = _old_request()
    assert old.status_code == 200
    old_photos = old.json()["data"]["product_photos"]
    assert all("render-content" not in (p.get("image") or "") for p in old_photos)

    datasets = json.loads(json.dumps(DATASETS))
    datasets["file_objects"] = []      # 供数方同款过滤（SQL 里 team_id=$3 命中不到）
    new = _post_rpc(_rpc_body(datasets=datasets))
    assert new.json()["status"] == 200
    new_photos = new.json()["body"]["data"]["product_photos"]
    assert [p.get("image") for p in new_photos] == [p.get("image") for p in old_photos]


# ════════════════════════════════════════════════════════════════════════════
# 5. 内部鉴权 / payload 形状
# ════════════════════════════════════════════════════════════════════════════

def test_rpc_requires_bearer():
    resp = _post_rpc(token=False)
    assert resp.status_code == 401
    assert resp.json()["detail"]["error"] == "unauthorized"


def test_rpc_rejects_plain_user_jwt():
    now = datetime.now(timezone.utc)
    user_jwt = jwt.encode(
        {"sub": str(ACTOR["id"]), "iat": now, "exp": now + timedelta(minutes=60)},
        JWT_SECRET, algorithm="HS256",
    )
    assert _post_rpc(token=user_jwt).status_code == 401


def test_rpc_rejects_actor_mismatch():
    body = _rpc_body()
    body["actor"]["team_id"] = 999
    resp = _post_rpc(body)
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "engine_rpc_payload_invalid"


def test_rpc_rejects_bad_datasets_shape():
    body = _rpc_body()
    body["datasets"]["trade_docs"] = "not-a-list"
    resp = _post_rpc(body)
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


def test_rpc_rejects_bad_timestamp():
    datasets = json.loads(json.dumps(DATASETS))
    datasets["trade_docs"][0]["updated_at"] = "not-a-timestamp"
    resp = _post_rpc(_rpc_body(datasets=datasets))
    envelope = resp.json()
    assert envelope["status"] == 400
    assert envelope["body"]["detail"]["error"] == "engine_rpc_payload_invalid"


# ════════════════════════════════════════════════════════════════════════════
# 6. 签名直链的 host 白名单（host 参与签名 ⇒ 不能任意）
# ════════════════════════════════════════════════════════════════════════════

def _asset_hosts(envelope_body: dict) -> set[str]:
    """响应里**签名直链**（render-content）的 host 集合（离线 data: / 外链不算）。"""
    from urllib.parse import urlparse

    data = envelope_body["data"]
    hosts: set[str] = set()
    for photo in data.get("product_photos") or []:
        image = photo.get("image") or ""
        if image.startswith("http") and "render-content" in image:
            hosts.add(urlparse(image).netloc)
    stamp = data.get("company_stamp") or ""
    if stamp.startswith("http") and "render-content" in stamp:
        hosts.add(urlparse(stamp).netloc)
    return hosts


@pytest.mark.parametrize("host", ("testserver", "localhost:8787", "kaas.powervoy.com",
                                  "api.kaas.powervoy.com", "foo.kaas.powervoy.com"))
def test_request_context_trusted_host_used(host):
    req = dict(FIXTURE["request"], request_context={
        "host": host, "x_forwarded_proto": "http"})
    resp = _post_rpc(_rpc_body(request=req))
    envelope = resp.json()
    assert envelope["status"] == 200
    assert _asset_hosts(envelope["body"]) == {host}


def test_request_context_untrusted_host_falls_back():
    req = dict(FIXTURE["request"], request_context={
        "host": "evil.example.com", "x_forwarded_proto": "http"})
    envelope = _post_rpc(_rpc_body(request=req)).json()
    assert envelope["status"] == 200
    hosts = _asset_hosts(envelope["body"])
    assert hosts == {"kaas.powervoy.com"}, hosts


# ════════════════════════════════════════════════════════════════════════════
# 7. 「一处实现」守卫
# ════════════════════════════════════════════════════════════════════════════

def _strip_docstrings(src: str) -> str:
    return re.sub(r'""".*?"""', "", src, flags=re.S)


def test_rpc_entry_has_no_db_access():
    import inspect

    src = _strip_docstrings(inspect.getsource(worker_main.render_data_from_datasets))
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch"):
        assert forbidden not in src, "render_data_from_datasets 不得包含取数代码: " + forbidden


def test_bundle_pure_has_no_db_access():
    import inspect

    src = _strip_docstrings(inspect.getsource(worker_main._render_bundle_pure))
    for forbidden in ("_db.", "_acquire", "asyncpg", "db.fetch"):
        assert forbidden not in src, "_render_bundle_pure 不得包含取数代码: " + forbidden


def test_old_and_new_paths_share_one_assembly():
    import inspect

    old = inspect.getsource(worker_main._render_bundle_of_doc)
    new = inspect.getsource(worker_main.render_data_from_datasets)
    assert "_render_bundle_pure" in old, "旧路径必须调用同一份纯装配"
    assert "_render_bundle_pure" in new, "供数 RPC 必须调用同一份纯装配"
    assert "_require_doc_visible" in new, "可见性闸门必须复用既有判定"


def test_photo_assembly_is_shared():
    import inspect

    src = inspect.getsource(ws_files.resolve_photo_refs)
    assert "_photo_entries_from_rows" in src, (
        "旧路径必须调用同一份照片装配（禁止第二份）")
