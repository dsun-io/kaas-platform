"""B 组验收修复的回归测试（源于 `.tmp/b-acceptance.md` 的真机验收）。

钉死三件事：

1. **P0 · 租户产品的写/删团队边界**：team2 的账号直接拿 id 操作 team1 的产品
   必须 **404 且不产生任何写入**（修复前实测 200 真改 / 204 真删，还会连带清
   `product_profiles` / `tenant_workstation_products` / 图片当前标记）。
   判据与列表**同一把尺**：共享内核 `kaas_common.workstation.product_scope.is_same_team`。

2. **P1-1 · `/workstation-products` 订阅门与 B3 同源**：门读团队级
   `team_subscriptions`（B3 的 `PUT /teams/{id}/subscriptions/{code}` 写它），
   并 union 历史租户级 `tenant_subscriptions` 兼容旧部署。修复前只读租户表、
   而全仓没有写该表的 HTTP 路由 ⇒ 团队开通了 full_chain 也恒 404（假路由）。

3. **P1-2 · `/formulas` 与 `/explain` 回落租户运行时产品**：修复前两者只查 Python
   注册表 ⇒ 编辑器里新建的租户产品"下拉能选、一算 404"。

做法与 `test_ws_products_seals.py` 一致：`_acquire` 换假连接（记录 SQL）、
`quote_api._db` 换假库、`_get_current_user` 换依赖覆盖，不碰 Hyperdrive。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import quote_api  # noqa: E402
import ws_products  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

# ── 身份：两个团队 + 管理员 + 无团队者 ──────────────────────────────────────


def _user(uid: int, *, role: str = "owner", team_id=None) -> dict:
    return {"id": uid, "email": f"u{uid}@kaas.local", "display_name": f"用户{uid}",
            "account_type": "customer", "role": role, "status": "active",
            "team_id": team_id}


TEAM1_OWNER = _user(11, team_id=1)
TEAM2_OWNER = _user(22, team_id=2)
TEAMLESS_OWNER = _user(33, team_id=None)
ADMIN = {"id": 1, "email": "ops@kaas.io", "account_type": "internal",
         "role": "system_admin", "status": "active", "team_id": None}


# ── 假连接（按调用顺序吐预设结果，记录 SQL）────────────────────────────────


class _FakeConn:
    def __init__(self, *, fetchval=None, fetchrow=None, fetch=None):
        self._fetchval = list(fetchval or [])
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, str, tuple]] = []

    async def fetchval(self, sql, *params):
        self.calls.append(("fetchval", sql, params))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetchrow(self, sql, *params):
        self.calls.append(("fetchrow", sql, params))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetch(self, sql, *params):
        self.calls.append(("fetch", sql, params))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *params):
        self.calls.append(("execute", sql, params))
        return "OK"

    def transaction(self):  # 订阅 PUT 用；本文件的路由不调用
        @asynccontextmanager
        async def _txn():
            yield None
        return _txn()

    def sql_calls(self) -> str:
        return "\n".join(sql for _, sql, _ in self.calls)

    def written(self) -> bool:
        """是否发生过**写**（fetchrow 也可能是 SELECT，故只看 execute + UPDATE SQL）。"""
        for kind, sql, _ in self.calls:
            if kind == "execute":
                return True
            if "UPDATE tenant_products" in sql or "DELETE FROM tenant_products" in sql:
                return True
        return False


@contextmanager
def _patched_products(conn: _FakeConn, user: dict):
    """替换 ws_products 的连接与鉴权（路由模块各自持有 `_acquire` 副本）。"""

    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = ws_products._acquire
    ws_products._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        ws_products._acquire = old
        worker_main.app.dependency_overrides.clear()


class _FakeDb:
    """`quote_api._db` 的最小替身：只实现 `_effective_product_raw` 用到的 `fetch`。"""

    def __init__(self, rows):
        self.rows = list(rows or [])
        self.queries: list[tuple[str, tuple, object]] = []

    async def fetch(self, request, sql, *args, table=None):
        self.queries.append((sql, args, table))
        return self.rows


@contextmanager
def _patched_quote(rows, user: dict):
    """替换 `quote_api._db` 与鉴权。

    注意（踩过的坑）：`ws_quote_ext` 在**函数体内** `import quote_api`，取的是
    `sys.modules` 里的**当前**模块对象；而各测试文件都调 `_bootstrap.load_main()`
    重载，本文件 `import quote_api` 拿到的别名可能已不是最新那一份 ⇒ 只 patch 别名会
    出现「单文件跑绿、全量跑红」。
    所以两份都 patch（同一对象时不会重复）。
    """
    db = _FakeDb(rows)
    targets = {id(quote_api): quote_api}
    live = sys.modules.get("quote_api")
    if live is not None:
        targets.setdefault(id(live), live)
    previous = [(m, m._db) for m in targets.values()]
    for module in targets.values():
        module._db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        for module, old in previous:
            module._db = old
        worker_main.app.dependency_overrides.clear()


def _product_row(**over) -> dict:
    """`_product_out` 需要的完整行（team_id 是本文件的主角）。"""
    row = {
        "id": 3, "tenant_id": "default", "team_id": 1,
        "product_key": "accept_fence_01", "product_name": "验收牛栏网",
        "product_name_en": None, "category_code": "niulanwang",
        "cost_field": "raw_price", "cost_basis": "pretax", "cost_unit": "CNY/kg",
        "profit_mode": "margin_on_price", "profit_value": 0.1, "misc_fee_rate": 0.03,
        "spec": {"key": "accept_fence_01", "name": "验收牛栏网"},
        "override": None, "is_system": False, "is_active": True,
        "created_at": datetime(2026, 10, 21, tzinfo=timezone.utc),
    }
    row.update(over)
    return row


_UPDATE_BODY = {
    "product_key": "accept_fence_01",
    "product_name": "HACKED-BY-TEAM2",
    "spec": {"key": "accept_fence_01", "name": "HACKED-BY-TEAM2"},
}


# ═════════════════════════════════════════════════════════════════════════════
# P0 · 跨团队越权改 / 删：404 且不写
# ═════════════════════════════════════════════════════════════════════════════

def test_cross_team_update_is_404_and_writes_nothing():
    """修复前：team2 PUT team1 的产品 → 200（真改）。修复后必须 404 且零写入。"""
    conn = _FakeConn(fetchrow=[_product_row(team_id=1)])
    with _patched_products(conn, TEAM2_OWNER):
        resp = client.put("/api/v1/tenant-products/3", json=_UPDATE_BODY)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"
    assert conn.written() is False, conn.sql_calls()
    assert "UPDATE tenant_products" not in conn.sql_calls()


def test_cross_team_delete_is_404_and_writes_nothing():
    """修复前：team2 DELETE team1 的产品 → 204（真删 + 连带清关联表）。"""
    conn = _FakeConn(fetchrow=[_product_row(team_id=1)])
    with _patched_products(conn, TEAM2_OWNER):
        resp = client.delete("/api/v1/tenant-products/3")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"
    assert conn.written() is False, conn.sql_calls()
    # 连带清理（product_profiles / tenant_workstation_products / file_objects）也不许发生
    assert "product_profiles" not in conn.sql_calls()
    assert "tenant_workstation_products" not in conn.sql_calls()


def test_same_team_update_succeeds():
    """本团队（team1 改 team1）必须照常 200 —— 修复不能把正常路径一起关掉。"""
    row = _product_row(team_id=1)
    updated = _product_row(team_id=1, product_name="HACKED-BY-TEAM2")
    conn = _FakeConn(fetchrow=[row, updated])
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.put("/api/v1/tenant-products/3", json=_UPDATE_BODY)
    assert resp.status_code == 200
    assert resp.json()["product_name"] == "HACKED-BY-TEAM2"
    assert "UPDATE tenant_products" in conn.sql_calls()


def test_same_team_delete_succeeds():
    conn = _FakeConn(fetchrow=[_product_row(team_id=1)])
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.delete("/api/v1/tenant-products/3")
    assert resp.status_code == 204
    assert "DELETE FROM tenant_products" in conn.sql_calls()


def test_platform_admin_can_edit_any_team():
    """平台管理员（运维兜底）不受团队限制 —— 与 is_same_team 的管理员分支同口径。"""
    conn = _FakeConn(fetchrow=[_product_row(team_id=2),
                               _product_row(team_id=2, product_name="HACKED-BY-TEAM2")])
    with _patched_products(conn, ADMIN):
        resp = client.put("/api/v1/tenant-products/3", json=_UPDATE_BODY)
    assert resp.status_code == 200


def test_teamless_owner_can_still_edit_own_null_team_row():
    """历史 `team_id IS NULL` 行：无团队者**自己创建**的产品就落成 NULL ——
    写读必须对称，否则修复会把这批人的自家产品锁死。"""
    conn = _FakeConn(fetchrow=[_product_row(team_id=None),
                               _product_row(team_id=None, product_name="HACKED-BY-TEAM2")])
    with _patched_products(conn, TEAMLESS_OWNER):
        resp = client.put("/api/v1/tenant-products/3", json=_UPDATE_BODY)
    assert resp.status_code == 200


def test_teamed_member_cannot_edit_legacy_null_row():
    """有团队的非管理员对 NULL 行：列表里看不到（列表 SQL 口径），写也必须 404。"""
    conn = _FakeConn(fetchrow=[_product_row(team_id=None)])
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.delete("/api/v1/tenant-products/3")
    assert resp.status_code == 404
    assert conn.written() is False


def test_cross_tenant_still_404_before_team_check():
    """租户不符仍然 404（既有口径不能被团队判据改写）。"""
    conn = _FakeConn(fetchrow=[_product_row(tenant_id="lianjia", team_id=1)])
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.delete("/api/v1/tenant-products/3")
    assert resp.status_code == 404
    assert conn.written() is False


# ═════════════════════════════════════════════════════════════════════════════
# P1-1 · /workstation-products 订阅门：团队级（与 B3 同源）+ 租户级兼容
# ═════════════════════════════════════════════════════════════════════════════

def _workstation_get_rows():
    return [
        [{"product_key": "field_fence", "product_name": "牛栏网", "is_system": True}],
        [{"product_key": "field_fence", "is_enabled": False}],
    ]


def test_workstation_products_unlocked_by_team_subscription():
    """团队开了 full_chain（B3 的 PUT 写的表）→ 矩阵接口 200（修复前恒 404）。"""
    conn = _FakeConn(fetchval=[1], fetch=_workstation_get_rows())
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.get("/api/v1/workstation-products", params={"workstation": "quote"})
    assert resp.status_code == 200
    assert resp.json() == [{"product_key": "field_fence", "product_name": "牛栏网",
                            "is_system": True, "is_enabled": False}]
    # 门必须**同时**看团队级与（兼容用的）租户级表
    gate_sql = conn.calls[0][1]
    assert "team_subscriptions" in gate_sql
    assert "tenant_subscriptions" in gate_sql
    # 参数：调用者团队、工位编码、默认租户
    assert conn.calls[0][2] == (1, ["full_chain", "quotes"], "default")


def test_workstation_products_upsert_unlocked_by_team_subscription():
    conn = _FakeConn(
        fetchval=[1],
        fetchrow=[
            {"product_key": "field_fence", "product_name": "牛栏网", "is_system": False},
            {"product_key": "field_fence", "is_enabled": True},
        ],
    )
    with _patched_products(conn, TEAM1_OWNER):
        resp = client.post("/api/v1/workstation-products",
                           json={"product_key": "field_fence", "is_enabled": True})
    assert resp.status_code == 201
    assert resp.json()["is_enabled"] is True


def test_workstation_products_still_404_without_any_subscription():
    """两张表都没有 → 仍然 404 且**不写**（修复不能把门整个拆掉）。"""
    conn = _FakeConn(fetchval=[None])
    with _patched_products(conn, TEAM2_OWNER):
        resp = client.get("/api/v1/workstation-products", params={"workstation": "quote"})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "SUBSCRIPTION_REQUIRED"
    assert conn.written() is False
    # 闸门在查产品之前：不允许出现任何 fetchrow / execute
    assert not any(kind in ("fetchrow", "execute") for kind, _, _ in conn.calls)


# ═════════════════════════════════════════════════════════════════════════════
# P1-2 · /formulas 与 /explain 回落租户运行时产品
# ═════════════════════════════════════════════════════════════════════════════

_TENANT_SPEC_ROW = {"spec": {"key": "accept_fence_01", "name": "验收牛栏网"},
                    "override": None, "team_id": 1}


def test_formulas_resolves_tenant_runtime_product():
    """修复前：404 unknown_product（只查 Python 注册表）。"""
    with _patched_quote([_TENANT_SPEC_ROW], TEAM1_OWNER):
        resp = client.get("/api/v1/export-quote/products/accept_fence_01/formulas")
    assert resp.status_code == 200
    body = resp.json()
    assert body["product_key"] == "accept_fence_01"
    assert body["name"] == "验收牛栏网"
    assert "space" in body                       # 规格矩阵形状完整（v2 选择器的数据源）


def test_formulas_system_product_unchanged():
    """系统产品（注册表）行为不变：租户表没行也照样 200。"""
    with _patched_quote([], TEAM1_OWNER):
        resp = client.get("/api/v1/export-quote/products/field_fence/formulas")
    assert resp.status_code == 200
    assert resp.json()["product_key"] == "field_fence"


def test_formulas_unknown_product_still_404():
    with _patched_quote([], TEAM1_OWNER):
        resp = client.get("/api/v1/export-quote/products/nope_not_here/formulas")
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "unknown_product"


def test_formulas_cross_team_product_is_404():
    """团队边界在解析层同样生效：team1 看不到 team2 定义的同名产品。"""
    with _patched_quote([{**_TENANT_SPEC_ROW, "team_id": 2}], TEAM1_OWNER):
        resp = client.get("/api/v1/export-quote/products/accept_fence_01/formulas")
    assert resp.status_code == 404


def test_formulas_admin_sees_legacy_null_team_row():
    """历史 NULL 行仅管理员可见（与发现层同口径）。"""
    with _patched_quote([{**_TENANT_SPEC_ROW, "team_id": None}], ADMIN):
        resp = client.get("/api/v1/export-quote/products/accept_fence_01/formulas")
    assert resp.status_code == 200


def test_explain_resolves_tenant_runtime_product():
    """不带 spec_override 的试算：修复前 404 unknown_product。"""
    with _patched_quote([_TENANT_SPEC_ROW], TEAM1_OWNER):
        resp = client.post("/api/v1/export-quote/products/accept_fence_01/explain",
                           json={"spec": {}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["product_name"] == "验收牛栏网"


def test_explain_system_product_unchanged():
    """系统产品（注册表）行为不变：解析成功后才轮到规格校验报 400。

    空 spec 对 `field_fence` 必然 `missing_variant`（要选表面处理/工艺）——**不是**
    `unknown_product`，这条正说明"产品定义已被解析到"（修复前这里也会 404 吗？
    不会：系统产品本来就查得到。此条是回归护栏，防止我把注册表分支改坏）。
    """
    with _patched_quote([], TEAM1_OWNER):
        resp = client.post("/api/v1/export-quote/products/field_fence/explain",
                           json={"spec": {}})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "missing_variant"


def test_explain_unknown_product_still_404():
    with _patched_quote([], TEAM1_OWNER):
        resp = client.post("/api/v1/export-quote/products/nope_not_here/explain",
                           json={"spec": {}})
    assert resp.status_code == 404
    assert resp.json()["detail"]["error"] == "unknown_product"


def test_explain_draft_override_does_not_touch_db():
    """草稿试算（带 spec_override）仍走"不查库"路径 —— 编辑器试算不受本次改动影响。"""
    with _patched_quote([_TENANT_SPEC_ROW], TEAM1_OWNER) as db:
        resp = client.post("/api/v1/export-quote/products/accept_fence_01/explain",
                           json={"spec": {}, "spec_override": {"key": "accept_fence_01",
                                                               "name": "Draft"}})
    assert resp.status_code == 200
    assert db.queries == []
