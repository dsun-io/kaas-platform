"""A 项（按客户选择产品英文名）——偏好查询 / 参考价产品身份 / 继承链回归。

用户诉求（2026-10-24 第三轮）
==============================
同一产品配置了多个英文名（团队级 `product_profiles.info.name_en_list`，主名在前）。
报价时按**当前客户**选择本单使用的那一个；该名随「报价行 → 订单 → 单证」快照走；
下次给同一客户报同一产品默认沿用上次选择；历史快照不回改。

本文件钉死内核侧三层口径
========================
1. `GET /api/v1/quotes/product-name-preference`：某客户 + 某产品（**product_key 身份**）
   最近一次报价行使用的英文名；无历史 null；客户越权/别团队 404；product_key 空 422、
   未知 404；旧行（无 spec_snapshot.product_key）按产品当前全部英文名回落。
2. `GET /api/v1/quotes/reference-price`：产品身份按 `spec_snapshot.product_key` 匹配，
   旧行回落到该产品用过的任何英文名 —— 换英文名后历史价仍命中；只传 product_name 的
   旧调用方行为不变。
3. 继承链：行项 product_name（用户选中的英文名）原样进 quote_order_items →
   quotation 的 trade_doc_items；报价转订单时复制进 order_items；单证快照
   （doc_payload.order_snapshot）原样带出。

风格照 `test_product_names_en.py` / `test_parity_quote.py`：假库 + TestClient，不连 PG。
"""
from __future__ import annotations

import asyncio
import sys
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import doc_payload  # noqa: E402
import quote_api  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

TEAM = 2
OTHER_TEAM = 9

CUSTOMER_USER = {
    "id": 5, "email": "u5@kaas.local", "display_name": "用户5",
    "account_type": "customer", "role": "user", "status": "active",
    "team_id": TEAM,
}

#: field_fence（牛栏网）在本团队的英文名：主名 Cattle Fence，别名 Field Fence。
PROFILE_ROW = {
    "product_key": "field_fence",
    "info": {"name_en_list": ["Cattle Fence", "Field Fence"]},
    "team_id": TEAM,
}


def _customer_row(**over):
    row = {
        "id": 3, "name": "ACME 贸易", "abbr": "ACME", "country": "US",
        "team_id": TEAM, "tenant_id": "default", "is_deleted": False,
        "owner_id": "5", "owner_scope": "private",
    }
    row.update(over)
    return row


class _FakeDb:
    """供 `_quotable_specs`（产品名/可见性）与偏好查询用：按 SQL 形状分派。"""

    def __init__(self, *, profile_rows=None, preference_name=None,
                 customer_row=None):
        self.profile_rows = list(profile_rows if profile_rows is not None else [PROFILE_ROW])
        self.preference_name = preference_name
        self.customer_row = customer_row if customer_row is not None else _customer_row()
        self.calls: list[tuple[str, tuple]] = []

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        if "FROM tenant_products" in sql:
            return []
        if "FROM tenant_workstation_products" in sql:
            return []
        if "FROM product_profiles" in sql:
            return self.profile_rows
        return []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        return None

    async def fetchval(self, request, sql, *args, table=None):
        return None

    @asynccontextmanager
    async def acquire(self, request):
        self.conn = _FakeConn(self)
        yield self.conn

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)


class _FakeConn:
    def __init__(self, db: _FakeDb):
        self.db = db
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        if "FROM customers c" in sql:
            return self.db.customer_row
        if "FROM quote_order_items i" in sql:
            name = self.db.preference_name
            return {"product_name": name} if name else None
        return None

    def sql(self) -> str:
        return "\n".join(sql for sql, _ in self.calls)


def _install(monkeypatch, db):
    for name in ("fetch", "fetchrow", "fetchval"):
        monkeypatch.setattr(worker_main.db, name, getattr(db, name))
    monkeypatch.setattr(worker_main.db, "acquire", db.acquire)
    return db


def _as(user=CUSTOMER_USER):
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _clear():
    worker_main.app.dependency_overrides.clear()


def _get(path, user=CUSTOMER_USER):
    _as(user)
    try:
        return client.get(path)
    finally:
        _clear()


# ════════════════════════════════════════════════════════════════════════════
# 1. GET /api/v1/quotes/product-name-preference
# ════════════════════════════════════════════════════════════════════════════


def test_preference_returns_last_name_for_customer_and_product(monkeypatch):
    """有历史 ⇒ 返回上次用的英文名；SQL 按 product_key 身份 + 旧行英文名回落。"""
    db = _install(monkeypatch, _FakeDb(preference_name="Field Fence"))
    resp = _get(
        "/api/v1/quotes/product-name-preference"
        "?customer_id=3&product_key=field_fence")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"product_name": "Field Fence"}

    sql = db.conn.sql()
    assert "i.spec_snapshot->>'product_key' = $3" in sql
    assert "i.spec_snapshot->>'product_key' IS NULL" in sql
    assert "lower(i.product_name) = ANY($4::text[])" in sql
    # 回落的"全部英文名"来自团队资料（主名 + 别名）+ 中文名，大小写折叠
    _, args = db.conn.calls[-1]
    names = args[3]
    assert names == ["cattle fence", "field fence", "牛栏网"]


def test_preference_null_when_no_history(monkeypatch):
    """无历史 ⇒ null（前端回落产品默认名，不报错）。"""
    _install(monkeypatch, _FakeDb(preference_name=None))
    resp = _get(
        "/api/v1/quotes/product-name-preference"
        "?customer_id=3&product_key=field_fence")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"product_name": None}


def test_preference_empty_product_key_is_422(monkeypatch):
    """product_key 空 ⇒ 422 明确错误码（不是 404）。"""
    db = _install(monkeypatch, _FakeDb())
    resp = _get("/api/v1/quotes/product-name-preference?customer_id=3&product_key=")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "PRODUCT_KEY_REQUIRED"
    assert db.calls == []          # 参数校验先于任何查询


def test_preference_unknown_product_is_404(monkeypatch):
    _install(monkeypatch, _FakeDb())
    resp = _get(
        "/api/v1/quotes/product-name-preference"
        "?customer_id=3&product_key=no_such_product")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "PRODUCT_NOT_FOUND"


def test_preference_other_team_customer_is_404(monkeypatch):
    """别团队客户 ⇒ 404（不泄露存在性），且不返回名字。"""
    db = _install(monkeypatch, _FakeDb(customer_row=_customer_row(team_id=OTHER_TEAM)))
    resp = _get(
        "/api/v1/quotes/product-name-preference"
        "?customer_id=3&product_key=field_fence")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"


def test_preference_requires_auth(monkeypatch):
    """无凭据 ⇒ 401（读权限与报价列表同源）。"""
    _install(monkeypatch, _FakeDb())
    resp = client.get(
        "/api/v1/quotes/product-name-preference"
        "?customer_id=3&product_key=field_fence")
    assert resp.status_code == 401


# ════════════════════════════════════════════════════════════════════════════
# 2. GET /api/v1/quotes/reference-price —— 产品身份（换名后仍命中）
# ════════════════════════════════════════════════════════════════════════════

_AGG_ROW = {
    "n": 2, "avg": Decimal("2.5"), "min": Decimal("2"),
    "max": Decimal("3"), "median": Decimal("2.5"), "last_at": None,
}


def _capture_reference(monkeypatch):
    seen: dict = {}

    async def fake_fetchrow(request, sql, *args, table=None):
        seen["sql"] = sql
        seen["args"] = args
        return _AGG_ROW

    monkeypatch.setattr(worker_main.db, "fetchrow", fake_fetchrow)
    return seen


def test_reference_price_matches_by_product_key_and_any_alias(monkeypatch):
    """product_key 身份优先；旧行按「本单所选名 + 该产品历史用过的任何英文名」回落。"""
    seen = _capture_reference(monkeypatch)
    resp = _get(
        "/api/v1/quotes/reference-price?customer_id=3"
        "&product_name=Field+Fence&product_key=field_fence")
    assert resp.status_code == 200, resp.text
    sql = seen["sql"]
    assert "i.spec_snapshot->>'product_key' = $3" in sql
    assert "SELECT j.product_name FROM quote_order_items j" in sql
    assert "j.spec_snapshot->>'product_key' = $3" in sql
    assert "i.product_name = $4" in sql          # 本单所选名（换名后仍命中同一产品）
    args = seen["args"]
    assert args[0] == "default" and args[1] == 3
    assert args[2] == "field_fence" and args[3] == "Field Fence"
    assert args[4] == 180


def test_reference_price_legacy_call_with_only_name_keeps_old_behavior(monkeypatch):
    """旧调用方只传 product_name ⇒ 仍按名字精确匹配（不破坏既有语义）。"""
    seen = _capture_reference(monkeypatch)
    resp = _get(
        "/api/v1/quotes/reference-price?customer_id=3&product_name=Field+Fence")
    assert resp.status_code == 200, resp.text
    sql = seen["sql"]
    assert "i.product_name = $3" in sql
    assert "spec_snapshot->>'product_key'" not in sql
    assert seen["args"][:3] == ("default", 3, "Field Fence")


def test_reference_price_requires_name_or_key(monkeypatch):
    """两者都不给 ⇒ 422（不再默默按空名匹配出 0 条）。"""
    _capture_reference(monkeypatch)
    resp = _get("/api/v1/quotes/reference-price?customer_id=3")
    assert resp.status_code == 422
    assert resp.json()["detail"]["error"] == "validation_error"


# ════════════════════════════════════════════════════════════════════════════
# 3. 继承链：单证快照原样带出选中英文名（order → doc_payload）
# ════════════════════════════════════════════════════════════════════════════


class _SnapshotDb:
    """doc_payload.order_snapshot 的两条查询：订单头 + 行项。"""

    def __init__(self, product_name: str):
        self.product_name = product_name

    async def fetchrow(self, request, sql, *args, table=None):
        return {
            "id": 21, "order_no": "ORD-US-ACME-1", "customer_id": 3,
            "customer_name": "ACME 贸易", "status": "pending", "currency": "USD",
            "total_amount": Decimal("100.00"), "fx_rate": None,
            "incoterm": "FOB", "payment_terms": None, "port_of_loading": None,
            "port_of_destination": None, "shipping_marks": None,
            "country_of_origin": None,
        }

    async def fetch(self, request, sql, *args, table=None):
        return [{
            "product_name": self.product_name, "qty": Decimal("10"),
            "qty_unit": "ROLLS", "unit_price": Decimal("2.5"),
            "line_amount": Decimal("25"), "spec_snapshot": {"product_key": "field_fence"},
        }]


def test_doc_snapshot_inherits_selected_english_name():
    """订单行项上的英文名（用户本单所选）原样进单证快照，不改写。"""
    snap = asyncio.run(
        doc_payload.order_snapshot(_SnapshotDb("Field Fence"), None, 21))
    assert snap["items"][0]["product_name"] == "Field Fence"
    assert snap["items"][0]["spec_snapshot"]["product_key"] == "field_fence"
