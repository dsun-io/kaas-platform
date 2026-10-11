"""worker（生产侧）admin 契约回归：/admin/tenants 系列。

与 `test_worker_routes.py`（只验路由面）互补：这里验**响应形状**。
做法与 `test_four_domains.py` / `test_ws_products_seals.py` 一致：
把 `db` 换成假实现、把 `_get_current_user` 换成依赖覆盖，不碰 Hyperdrive 也能跑到返回。

为什么值得钉住（real 模式实测症状，见 docs/ADMIN_TENANTS_CONTRACT_REPORT.md）：
- 旧版 GET 返回 `{items:[{tenant_id,name}]}`，而前端读 `data.tenants` / `t.display_name`
  ⇒ 租户名空白 + 状态恒"停用" + 点重载 `undefined.map` 崩；
- 旧版 feature_flag **要求 `flag_name` 必填**且只回单值 `{flag_name,flag_value}`，
  而灰度页按 `flags?.[t.tenant_id]?.["use_v2"]` 消费 ⇒ 所有开关恒 OFF。
"""
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}

TENANT_ITEM_KEYS = {"tenant_id", "display_name", "is_active"}
RELOAD_ENVELOPE_KEYS = {"reloaded_count", "active_tenants"}
RELOAD_ITEM_KEYS = {"tenant_id", "display_name", "locale", "region", "is_active"}


class _FakeDb:
    """冒充 platform/db.py：按调用顺序吐预设结果（这些端点只用到 fetch/fetchrow/execute）。"""

    def __init__(self, *, fetch=None, fetchrow=None):
        self._fetch = list(fetch or [])
        self._fetchrow = list(fetchrow or [])
        self.executed: list[tuple[str, tuple]] = []
        self.calls: list[tuple[str, str, tuple]] = []

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append(("fetch", sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append(("fetchval", sql, args))
        return 0

    async def execute(self, request, sql, *args):
        self.calls.append(("execute", sql, args))
        self.executed.append((sql, args))
        return "INSERT 0 1"


@contextmanager
def _patched(db, user=ADMIN):
    old_db = worker_main.db
    worker_main.db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        worker_main.db = old_db
        worker_main.app.dependency_overrides.clear()


# ── GET /api/v1/admin/tenants ────────────────────────────────────────────────

def test_admin_tenants_shape_matches_frontend_contract():
    with _patched(_FakeDb()):
        resp = client.get("/api/v1/admin/tenants")
    assert resp.status_code == 200
    body = resp.json()

    assert set(body) == {"tenants"}, f"包封键应为 tenants，实际 {sorted(body)}"
    # 单租户部署：**永远 1 条**，不为"看起来一致"伪造多条（报告 §4.3）
    assert len(body["tenants"]) == 1

    item = body["tenants"][0]
    assert set(item) == TENANT_ITEM_KEYS, (
        f"条目键必须精确为 {sorted(TENANT_ITEM_KEYS)}，实际 {sorted(item)}"
    )
    assert item["tenant_id"] == worker_main.DEFAULT_TENANT
    assert isinstance(item["display_name"], str) and item["display_name"]
    assert item["is_active"] is True


# ── POST /api/v1/admin/tenants/reload ────────────────────────────────────────

def test_admin_tenants_reload_returns_active_tenant_list():
    db = _FakeDb()
    with _patched(db):
        resp = client.post("/api/v1/admin/tenants/reload")
    assert resp.status_code == 200
    body = resp.json()

    assert set(body) == RELOAD_ENVELOPE_KEYS, (
        f"包封键必须精确为 {sorted(RELOAD_ENVELOPE_KEYS)}，实际 {sorted(body)}"
    )
    assert body["reloaded_count"] == 1
    assert len(body["active_tenants"]) == 1, "单租户部署：清单只有 DEFAULT_TENANT 一条"

    item = body["active_tenants"][0]
    assert set(item) == RELOAD_ITEM_KEYS, (
        f"清单条目键必须精确为 {sorted(RELOAD_ITEM_KEYS)}，实际 {sorted(item)}"
    )
    assert item["tenant_id"] == worker_main.DEFAULT_TENANT
    assert item["is_active"] is True
    assert isinstance(item["locale"], str) and item["locale"]
    assert isinstance(item["region"], str) and item["region"]

    # 形状改了，但"记账 no-op"的语义没变
    assert any("tenants_reload" in sql for sql, _ in db.executed)


# ── GET /api/v1/admin/feature_flag ───────────────────────────────────────────

def test_admin_feature_flag_returns_tenant_to_flags_map():
    db = _FakeDb(fetch=[[
        {"flag_name": "use_v2", "flag_value": True},
        {"flag_name": "sampling", "flag_value": 0},
    ]])
    with _patched(db):
        resp = client.get("/api/v1/admin/feature_flag")
    assert resp.status_code == 200, (
        "不带 flag_name 也必须 200：旧版这里是必填参数 ⇒ 灰度页直接 422"
    )
    flags = resp.json()

    assert isinstance(flags, dict)
    assert set(flags) == {worker_main.DEFAULT_TENANT}
    assert flags[worker_main.DEFAULT_TENANT] == {"use_v2": True, "sampling": False}
    assert all(isinstance(v, bool) for v in flags[worker_main.DEFAULT_TENANT].values()), (
        "值必须是 bool（前端类型是 Record<tenant_id, Record<flag, bool>>）"
    )


def test_admin_feature_flag_unknown_tenant_is_404():
    """单租户部署里要别的租户 = 不存在 ⇒ 404（不泄露存在性，与 orchestrator 同口径）。"""
    with _patched(_FakeDb()):
        resp = client.get("/api/v1/admin/feature_flag", params={"tenant_id": "lianjia"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "TENANT_NOT_FOUND"


# ── POST /api/v1/admin/feature_flag ──────────────────────────────────────────

def test_admin_feature_flag_post_accepts_frontend_body():
    """前端发的是 {tenant_id, flag_key, enabled, reason, actor_id}（use-feature-flags.ts:22-34）。

    旧版只认 `flag_name` ⇒ real 模式点灰度开关 **422**。这里钉住别名兼容。
    """
    db = _FakeDb(fetchrow=[None, {"id": 7}])   # 旧值不存在 → INSERT ... RETURNING id
    with _patched(db):
        resp = client.post("/api/v1/admin/feature_flag", json={
            "tenant_id": "default",
            "flag_key": "use_v2",
            "enabled": True,
            "reason": "灰度打开",
            "actor_id": "admin-1",
        })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tenant_id"] == "default"
    assert body["flag_name"] == "use_v2"
    assert body["old_value"] is False
    assert body["new_value"] is True


def test_admin_feature_flag_post_keeps_backend_body_format():
    """后端格式 {flag_name, flag_value} 不能被新别名挤掉（旧调用方仍要能用）。"""
    db = _FakeDb(fetchrow=[{"flag_value": True}, {"id": 8}])
    with _patched(db):
        resp = client.post("/api/v1/admin/feature_flag", json={
            "tenant_id": "default", "flag_name": "use_v2", "flag_value": False,
        })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["flag_name"] == "use_v2"
    assert body["old_value"] is True
    assert body["new_value"] is False


def test_admin_feature_flag_post_without_flag_name_is_422():
    with _patched(_FakeDb()):
        resp = client.post("/api/v1/admin/feature_flag", json={"tenant_id": "default"})
    assert resp.status_code == 422


# ── 鉴权：无凭据先 401（鉴权依赖在数据库之前）──────────────────────────────

def test_admin_endpoints_require_auth():
    assert client.get("/api/v1/admin/tenants").status_code == 401
    assert client.post("/api/v1/admin/tenants/reload").status_code == 401
    assert client.get("/api/v1/admin/feature_flag").status_code == 401
