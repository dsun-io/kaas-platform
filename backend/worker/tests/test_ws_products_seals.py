"""产品定义 / 工位权限矩阵 / 公章 三族 Worker 路由的行为测试（无数据库、无网络）。

`test_worker_routes.py` 只证明「路由注册了、鉴权在数据库之前」；本文件补上
**逻辑层**：订阅闸门、租户隔离、系统级只读、spec 校验、PNG 校验、首章默认。

做法：把 `_acquire` 换成假连接（记录 SQL 与参数），把 `_get_current_user`
换成依赖覆盖，这样不碰 Hyperdrive 也能把 handler 跑到返回。
"""
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_products  # noqa: E402
import ws_seals  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

INTERNAL = {"id": 1, "email": "ops@kaas.io", "account_type": "internal", "role": "system_admin"}
CUSTOMER = {"id": 9, "email": "buyer@example.com", "account_type": "customer", "role": "user"}

# 最小合法 PNG：魔数 + IHDR(13) + 宽 120 / 高 80
PNG_120x80 = (
    b"\x89PNG\r\n\x1a\n"
    + (13).to_bytes(4, "big") + b"IHDR"
    + (120).to_bytes(4, "big") + (80).to_bytes(4, "big")
    + b"\x08\x06\x00\x00\x00"
)


# ── 假连接 ──────────────────────────────────────────────────────────────────

class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """按调用顺序吐预设结果，并记录每条 SQL 与参数。"""

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

    def transaction(self):
        return _FakeTxn()

    def sql_calls(self) -> str:
        return "\n".join(sql for _, sql, _ in self.calls)


@contextmanager
def _patched(conn: _FakeConn, user: dict = INTERNAL):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old_products, old_seals = ws_products._acquire, ws_seals._acquire
    ws_products._acquire = fake_acquire
    ws_seals._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield conn
    finally:
        ws_products._acquire = old_products
        ws_seals._acquire = old_seals
        worker_main.app.dependency_overrides.clear()


def _seal_row(**over) -> dict:
    row = {
        "id": 7, "tenant_id": "default", "name": "公章", "mime": "image/png",
        "width": 120, "height": 80, "is_default": True, "created_by": "1",
        "created_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
    }
    row.update(over)
    return row


# ── 订阅闸门（Phase C：未订阅报价工位 → 404，且不写任何数据）──────────────────

def test_workstation_products_requires_subscription():
    conn = _FakeConn(fetchval=[None])  # tenant_subscriptions 无有效 full_chain
    with _patched(conn):
        resp = client.post("/api/v1/workstation-products",
                           json={"product_key": "field_fence", "is_enabled": True})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "SUBSCRIPTION_REQUIRED"
    # 闸门在查产品之前：不能有任何写入
    assert not any(kind in ("fetchrow", "execute") for kind, _, _ in conn.calls)
    assert "tenant_subscriptions" in conn.sql_calls()


def test_workstation_products_list_requires_subscription():
    conn = _FakeConn(fetchval=[None])
    with _patched(conn):
        resp = client.get("/api/v1/workstation-products")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "SUBSCRIPTION_REQUIRED"


def test_workstation_products_upsert_after_subscription():
    conn = _FakeConn(
        fetchval=[1],  # 有订阅
        fetchrow=[
            {"product_key": "field_fence", "product_name": "牛栏网", "is_system": False},
            {"product_key": "field_fence", "is_enabled": True},
        ],
    )
    with _patched(conn):
        resp = client.post("/api/v1/workstation-products",
                           json={"product_key": "field_fence", "is_enabled": True})
    assert resp.status_code == 201
    assert resp.json() == {
        "product_key": "field_fence", "product_name": "牛栏网",
        "is_system": False, "is_enabled": True,
    }
    # P9：唯一键已按团队收敛（迁移 019）⇒ 冲突目标必须与索引表达式一致。
    # 表达式**加括号**是 PG16 文法的要求（conflict_target := ( col | ( expr ) [, …] )）。
    assert ("ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), workstation, product_key)"
            in conn.sql_calls())


def test_workstation_products_unknown_product_404():
    conn = _FakeConn(fetchval=[1], fetchrow=[None])
    with _patched(conn):
        resp = client.post("/api/v1/workstation-products",
                           json={"product_key": "nope", "is_enabled": True})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"


# ── 产品定义：租户隔离 + 系统级只读 ─────────────────────────────────────────

def test_tenant_products_list_is_tenant_scoped():
    conn = _FakeConn(fetch=[[]])
    with _patched(conn):
        resp = client.get("/api/v1/tenant-products")
    assert resp.status_code == 200
    assert resp.json() == []
    kind, sql, params = conn.calls[0]
    assert kind == "fetch"
    assert "(tenant_id = $1 OR is_system = true)" in sql
    assert params == ("default", 50)   # 未传 tenant_id → 只回本租户 + 系统级


def test_tenant_products_list_honours_explicit_tenant():
    conn = _FakeConn(fetch=[[]])
    with _patched(conn):
        client.get("/api/v1/tenant-products", params={"tenant_id": "lianjia", "is_active": True})
    _, sql, params = conn.calls[0]
    assert params == ("lianjia", True, 50)
    assert "is_active = $2" in sql


def test_tenant_products_update_system_row_forbidden():
    conn = _FakeConn(fetchrow=[{"id": 1, "tenant_id": "default", "is_system": True}])
    with _patched(conn):
        resp = client.put("/api/v1/tenant-products/1", json={
            "product_key": "field_fence", "product_name": "牛栏网", "spec": {"key": "field_fence"},
        })
    assert resp.status_code == 403
    assert "系统级产品" in resp.json()["detail"]["message"]


def test_tenant_products_delete_other_tenant_is_404():
    conn = _FakeConn(fetchrow=[{"id": 2, "tenant_id": "lianjia", "is_system": False}])
    with _patched(conn):
        resp = client.delete("/api/v1/tenant-products/2")
    assert resp.status_code == 404       # 不泄露存在性
    assert resp.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"


def test_tenant_products_create_rejects_invalid_spec():
    """spec 不能转 ProductSpec 时 422，且绝不写库。"""
    conn = _FakeConn()
    with _patched(conn):
        resp = client.post("/api/v1/tenant-products", json={
            "product_key": "broken", "product_name": "坏产品",
            "spec": {"not_a_product_spec": True},
        })
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "invalid_spec"
    assert conn.calls == []


# ── 公章：权限 / 校验 / 首章默认 ────────────────────────────────────────────

def test_seal_management_is_internal_only():
    for method, path, kwargs in (
        ("get", "/api/v1/tenant/company-seals", {}),
        ("post", "/api/v1/tenant/company-seals", {"files": {"file": ("s.png", PNG_120x80, "image/png")}, "data": {"name": "公章"}}),
        ("put", "/api/v1/tenant/company-seals/1/default", {}),
        ("delete", "/api/v1/tenant/company-seals/1", {}),
    ):
        conn = _FakeConn()
        with _patched(conn, user=CUSTOMER):
            resp = getattr(client, method)(path, **kwargs)
        assert resp.status_code == 403, f"{method.upper()} {path}"
        assert resp.json()["detail"]["code"] == "INTERNAL_ONLY"
        assert conn.calls == []          # 拒绝在建连与查库之前


def test_seal_upload_first_seal_becomes_default():
    conn = _FakeConn(fetchval=[None, None, 7], fetchrow=[_seal_row()])
    with _patched(conn):
        resp = client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", PNG_120x80, "image/png")},
            data={"name": "公章"},
        )
    assert resp.status_code == 201
    body = resp.json()
    assert body["is_default"] is True
    assert (body["width"], body["height"]) == (120, 80)
    assert body["preview_url"] == "/api/v1/tenant/company-seals/7/image"
    assert body["mime"] == "image/png"


def test_seal_upload_rejects_non_png_bytes():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", b"not-a-png-at-all", "image/png")},
            data={"name": "公章"},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "BAD_IMAGE"
    assert conn.calls == []


def test_seal_upload_requires_name():
    conn = _FakeConn()
    with _patched(conn):
        resp = client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", PNG_120x80, "image/png")},
            data={"name": "   "},
        )
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "NAME_REQUIRED"


def test_seal_upload_duplicate_name_409():
    conn = _FakeConn(fetchval=[42])      # 同名已存在
    with _patched(conn):
        resp = client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", PNG_120x80, "image/png")},
            data={"name": "公章"},
        )
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "SEAL_NAME_TAKEN"


def test_seal_delete_default_with_siblings_409():
    conn = _FakeConn(
        fetchrow=[_seal_row(is_default=True)],
        fetchval=[1],                    # 还有别的章
    )
    with _patched(conn):
        resp = client.delete("/api/v1/tenant/company-seals/7")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "DEFAULT_SEAL"


def test_seal_image_reads_bytes_after_tenant_check():
    conn = _FakeConn(fetchrow=[_seal_row(png_bytes=PNG_120x80)])
    with _patched(conn):
        resp = client.get("/api/v1/tenant/company-seals/7/image")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"
    assert resp.content == PNG_120x80
    assert "tenant_id=$1 AND id=$2" in conn.sql_calls()


# ── 纯函数：默认值口径与 orchestrator 对齐 ─────────────────────────────────

def test_product_out_defaults_match_orchestrator():
    out = ws_products._product_out({
        "id": 1, "product_key": "k", "product_name": "n", "product_name_en": None,
        "category_code": None, "cost_field": None, "cost_basis": None, "cost_unit": None,
        "profit_mode": None, "profit_value": None, "misc_fee_rate": None,
        "is_system": False, "is_active": True, "created_at": None,
    })
    assert out["cost_field"] == "raw_price"
    assert out["cost_basis"] == "pretax"
    assert out["profit_mode"] == "margin_on_price"
    assert out["profit_value"] == 0.06
    assert out["misc_fee_rate"] == 0.03


def test_tenant_of_falls_back_to_default():
    assert ws_products._tenant_of({}) == "default"
    assert ws_products._tenant_of({"tenant_id": "lianjia"}) == "lianjia"


def test_require_internal_matrix():
    ws_seals._require_internal(INTERNAL)                      # internal 账号
    ws_seals._require_internal({"account_type": "customer", "role": "admin"})
    with pytest.raises(HTTPException) as exc:
        ws_seals._require_internal(CUSTOMER)
    assert exc.value.status_code == 403
