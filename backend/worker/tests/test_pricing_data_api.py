"""定价数据（/api/v1/pricing-data）的 Worker 行为测试（无数据库、无网络）。

回归（2026-10-19 生产白屏）：旧 worker 实现返回遗留分页形状
{items,total,page,page_size,pages}，前端定价页读 matrix.rows 直接 TypeError。
本文件锁死：GET 必须返回产品定价键**完整矩阵**形状（与 orchestrator 同语义），
且身份口径与算价接口一致（quote_api._customer_of）。

做法：引擎用真身（kaas_common.export_quote，sync-shared 镜像），
DB 访问点（quote_api._pricing_key_items / main.db.fetchrow）打桩。
"""
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import quote_api  # noqa: E402,F401
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

USER = {"id": 5, "email": "qa@kaas.local", "display_name": "QA",
        "account_type": "customer", "role": "owner", "team_id": 2}


@contextmanager
def _as_user(user):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield
    finally:
        worker_main.app.dependency_overrides.clear()


@pytest.fixture()
def field_fence():
    quote_api._require_engine()
    return quote_api.get_product("field_fence")


def test_get_pricing_data_returns_matrix_shape(field_fence, monkeypatch):
    """锁死回归：响应必须含 dims/rows（矩阵），不得是遗留 {items,total,page}。"""
    async def fake_items(request, tenant, customer_id, product_key):
        return []

    monkeypatch.setattr(quote_api, "_pricing_key_items", fake_items)
    with _as_user(USER):
        resp = client.get("/api/v1/pricing-data?product_key=field_fence")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["product_key"] == "field_fence"
    assert body["scope"] == "own"
    assert isinstance(body["dims"], list)
    assert isinstance(body["rows"], list)
    assert "items" not in body and "total" not in body and "pages" not in body
    if body["rows"]:
        cell = body["rows"][0]
        # 与前端契约 PricingCell 对齐的键
        for k in ("key", "values", "labels", "amount", "unit",
                  "item_id", "effective_from", "source", "configured"):
            assert k in cell, f"矩阵格缺键 {k}"


def test_get_pricing_data_requires_product_key():
    with _as_user(USER):
        resp = client.get("/api/v1/pricing-data")
    assert resp.status_code == 422


def test_get_pricing_data_unknown_product_404():
    with _as_user(USER):
        resp = client.get("/api/v1/pricing-data?product_key=nope")
    assert resp.status_code == 404


def test_get_pricing_data_scopes_to_own_customer(field_fence, monkeypatch):
    """身份口径 = 算价接口（quote_api._customer_of）：配置成本按同身份读回。"""
    captured = {}

    async def fake_items(request, tenant, customer_id, product_key):
        captured.update(tenant=tenant, customer_id=customer_id, product_key=product_key)
        return []

    monkeypatch.setattr(quote_api, "_pricing_key_items", fake_items)
    with _as_user(USER):
        resp = client.get("/api/v1/pricing-data?product_key=field_fence&scope=own")
    assert resp.status_code == 200, resp.text
    assert captured["product_key"] == "field_fence"
    # 生产单租户：customer 回退到租户身份（与 _load_cost_table 同一口径）
    assert captured["customer_id"] == quote_api._customer_of(USER)


def test_post_pricing_data_deactivates_old_and_inserts(field_fence, monkeypatch):
    """POST = 单语句 CTE（停用同键旧版本 + INSERT 新版本，原子）。"""
    # 档位初始为空（客户自建），直接给一组定价键取值即可
    values = {"de": 2.0, "coating_code": "zinc_40"}
    captured = {}

    async def fake_fetchrow(request, sql, *args, **kw):
        captured["sql"] = sql
        captured["args"] = args
        return {"id": 99, "amount": 4.4, "unit": "kg",
                "effective_from": None, "status": "active"}

    monkeypatch.setattr(worker_main.db, "fetchrow", fake_fetchrow)
    with _as_user(USER):
        resp = client.post("/api/v1/pricing-data", json={
            "product_key": "field_fence",
            "values": values,
            "amount": 4.4,
            "unit": "kg",
        })
    assert resp.status_code == 201, resp.text
    out = resp.json()
    assert out["id"] == 99 and out["product_key"] == "field_fence"
    assert out["key"] and out["key"] in captured["args"][2]   # spec_hash = key:key
    # 原子性：同一条语句里先停用旧版本再插入
    assert "WITH deactivated AS" in captured["sql"]
    assert "UPDATE customer_cost_items SET status='inactive'" in captured["sql"]
    assert "INSERT INTO customer_cost_items" in captured["sql"]
    # 档位来源标记（报价页下拉靠它扩展选项）
    payload = captured["args"][4]
    assert '"kind": "pricing_key"' in payload or '"kind":"pricing_key"' in payload


def test_post_pricing_data_rejects_bad_amount(field_fence):
    values = {"de": 2.0, "coating_code": "zinc_40"}
    with _as_user(USER):
        resp = client.post("/api/v1/pricing-data", json={
            "product_key": "field_fence",
            "values": values,
            "amount": -1,
            "unit": "kg",
        })
    assert resp.status_code == 422
