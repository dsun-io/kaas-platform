# -*- coding: utf-8 -*-
r"""生成 P3 第六批切片金标 fixture（4 条「需要内核计算」的只读端点）。

端点与 fixture：
1. GET /api/v1/export-quote/products                    → engine-products.fixture.json
2. GET /api/v1/quotes/product-name-preference           → engine-product-name-preference.fixture.json
3. GET /api/v1/export-quote/products/{key}/import-template（JSON 分支）
                                                        → engine-import-template.fixture.json
4. GET /api/v1/export-quote/import/order/template-info  → engine-order-template-info.fixture.json

做法与前面几批一致：用内核旧端点 + 桩 DB 真实跑一遍，把实际 SQL/参数/响应落盘；
两侧测试（worker / ts-worker）读同一份 fixture。

关键点：
- 产品集合（_quotable_specs）= 注册表 ∪ 团队可见 tenant_products − 停用 + 团队资料英文名；
- 产品名偏好：旧 SQL 的 WHERE 里有「lower(name)=ANY(名字列表)」（名字列表由产品定义派生），
  供数路径改成候选集 + 内核同序首命中（见 quote_api._name_preference_disambiguate）；
- import-template 只切 JSON 分支（带 format 的产文件分支留旧路径）。

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_catalog_read_fixtures.py
"""
from __future__ import annotations

import json
import platform
import re
import sys
from pathlib import Path

import asyncpg  # noqa: F401  (预热 stdlib platform)

platform.uname()

BACKEND = Path(__file__).resolve().parents[2]
WORKER = BACKEND / "worker"
sys.path.insert(0, str(WORKER / "src"))
sys.path.insert(0, str(WORKER / "tests"))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import quote_api  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}
TENANT = "default"

# 产品定义：用注册表里真实存在的产品（spec JSONB 由共享内核序列化，不能手抄）
from kaas_common.export_quote import get_product, product_keys  # noqa: E402
from kaas_common.export_quote.tenant_products import spec_to_dict  # noqa: E402

SPEC_KEY = "field_fence"
DISABLED_KEY = "chain_link"
SPEC_DICT = spec_to_dict(get_product(SPEC_KEY))

TENANT_PRODUCT_ROWS = [
    {"product_key": SPEC_KEY, "spec": SPEC_DICT, "team_id": 2},
]
DISABLED_ROWS = [{"product_key": DISABLED_KEY}]
PROFILE_ROWS = [
    {"product_key": SPEC_KEY, "info": {"name_en_list": ["Field Fence", "Fence Panel"]}},
]
CUSTOMER_ROWS = [
    {"id": 3, "owner_id": "5", "owner_scope": "private", "team_id": 2},
]
PREFERENCE_CANDIDATES = [
    # 最新一行是历史行但名字不在该产品名字列表里 ⇒ 必须被谓词跳过
    {"product_name": "Fence Panel (old)", "product_key": None},
    {"product_name": "Field Fence", "product_key": None},
]
IMPORT_PRODUCT_ROWS = [
    {"spec": SPEC_DICT, "override": None, "team_id": 2},
]

NAME_PREF_QUERY = "customer_id=3&product_key=" + SPEC_KEY
ORDER_KEYS_QUERY = "product_keys=" + SPEC_KEY

calls: list = []


def _record(sql: str, params) -> None:
    calls.append((re.sub(r"\s+", " ", sql).strip(), list(params)))


class _FakeConn:
    async def fetchrow(self, sql, *args):
        _record(sql, args)
        if "FROM customers" in sql:
            wanted = int(args[0])
            for row in CUSTOMER_ROWS:
                if int(row["id"]) == wanted:
                    return dict(row)
            return None
        if "FROM quote_order_items" in sql:
            key = args[2]
            folded = args[3] if len(args) > 3 else []
            for row in PREFERENCE_CANDIDATES:
                name = row["product_name"]
                if row["product_key"] == key:
                    return dict(row)
                if row["product_key"] is None and name.casefold() in folded:
                    return dict(row)
            return None
        raise AssertionError("unexpected conn.fetchrow: " + sql)


class _FakeAcquire:
    def __init__(self, request):
        self.request = request

    async def __aenter__(self):
        return _FakeConn()

    async def __aexit__(self, *exc):
        return False


async def fake_db_fetch(request, sql, *args, **kwargs):
    _record(sql, args)
    if "FROM tenant_products" in sql:
        if "AND product_key=$2" in sql:
            return [dict(r) for r in IMPORT_PRODUCT_ROWS]
        return [dict(r) for r in TENANT_PRODUCT_ROWS]
    if "FROM tenant_workstation_products" in sql:
        return [dict(r) for r in DISABLED_ROWS]
    if "FROM product_profiles" in sql:
        return [dict(r) for r in PROFILE_ROWS]
    raise AssertionError("unexpected db.fetch: " + sql)


def _stub(original: dict) -> dict:
    original["fetch"] = worker_main.db.fetch
    original["acquire"] = worker_main._acquire
    original["db_acquire"] = worker_main.db.acquire
    worker_main.db.fetch = fake_db_fetch
    worker_main._acquire = lambda request: _FakeAcquire(request)
    worker_main.db.acquire = lambda request: _FakeAcquire(request)
    return original


def _restore(original: dict) -> None:
    worker_main.db.fetch = original["fetch"]
    worker_main._acquire = original["acquire"]
    worker_main.db.acquire = original["db_acquire"]
    worker_main.app.dependency_overrides.clear()


def _actor() -> dict:
    row = dict(ACTOR)
    row.setdefault("email", "buyer@qa.test")
    row.setdefault("display_name", "买家")
    row.setdefault("status", "active")
    row.setdefault("console_access", False)
    row.setdefault("plan", "free")
    return row


def _write(name: str, fixture: dict) -> None:
    out = Path(__file__).with_name(name)
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fixture written:", out.name, "bytes:", out.stat().st_size)


CATALOG_SQLS = {
    "tenant_products": {
        "sql": "SELECT product_key, spec, team_id FROM tenant_products"
               " WHERE tenant_id=$1 AND is_active",
        "params": [TENANT],
    },
    "tenant_workstation_products": {
        "sql": "SELECT product_key FROM tenant_workstation_products"
               " WHERE tenant_id=$1 AND workstation='quote' AND is_enabled=false"
               " AND (team_id IS NULL OR team_id=$2)",
        "params": [TENANT, 2],
    },
    "product_profiles": {
        "sql": "SELECT product_key, info FROM product_profiles WHERE tenant_id=$1"
               " AND team_id=$2 ORDER BY updated_at DESC",
        "params": [TENANT, 2],
    },
}

DATASETS_CATALOG = {
    "tenant_products": TENANT_PRODUCT_ROWS,
    "tenant_workstation_products": DISABLED_ROWS,
    "product_profiles": PROFILE_ROWS,
}


def main() -> None:
    original: dict = {}
    products_calls: list = []
    import_calls: list = []
    order_calls: list = []
    pref_calls: list = []

    def _run(fn, label: str) -> dict:
        global calls
        calls = []
        _stub(original)
        worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: _actor()
        try:
            response = fn()
        finally:
            _restore(original)
        target = {"products": products_calls, "import": import_calls,
                  "order": order_calls, "pref": pref_calls}[label]
        target.extend(calls)
        assert response.status_code == 200, (label, response.text)
        return response.json()

    products_body = _run(
        lambda: client.get("/api/v1/export-quote/products"), "products")
    pref_body = _run(
        lambda: client.get("/api/v1/quotes/product-name-preference?" + NAME_PREF_QUERY),
        "pref")
    import_body = _run(
        lambda: client.get("/api/v1/export-quote/products/" + SPEC_KEY + "/import-template"),
        "import")
    order_body = _run(
        lambda: client.get("/api/v1/export-quote/import/order/template-info?" + ORDER_KEYS_QUERY),
        "order")

    _write("engine-products.fixture.json", {
        "_comment": (
            "P3 第六批金标：GET /api/v1/export-quote/products（产品目录）。"
            "old_sql = 旧路径实际执行的 3 条查询；facade = 门面供数契约；"
            "response = 旧路径真实响应（= _product_catalog_payload 的同一份投影）。"
            "产品集合 = 注册表 ∪ 团队可见 tenant_products − 停用 + 团队资料英文名覆盖。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/export-quote/products",
                     "query_string": ""},
        "rpc": "/api/v1/internal/engine/quote/products",
        "request": {},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": DATASETS_CATALOG,
        "old_sql": [{"sql": sql, "params": params} for sql, params in products_calls],
        "facade": CATALOG_SQLS,
        "response": products_body,
    })

    _write("engine-product-name-preference.fixture.json", {
        "_comment": (
            "P3 第六批金标：GET /api/v1/quotes/product-name-preference。"
            "旧 SQL 的 WHERE 里有 lower(name)=ANY(名字列表)（名单由产品定义派生）⇒ 供数 SQL 改成"
            "候选集（product_key 命中或历史行），谓词由内核按同一行顺序首命中应用（见"
            "quote_api._name_preference_disambiguate）。fixture 里第一条候选是「名字不在名单里的"
            "历史行」，用来锁「谓词被应用、不是简单取第一条」。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/quotes/product-name-preference",
                     "query_string": NAME_PREF_QUERY},
        "rpc": "/api/v1/internal/engine/quote/product-name-preference",
        "request": {"query": {"customer_id": "3", "product_key": SPEC_KEY}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": dict(DATASETS_CATALOG, customers=CUSTOMER_ROWS,
                         preference_candidates=PREFERENCE_CANDIDATES),
        "old_sql": [{"sql": sql, "params": params} for sql, params in pref_calls],
        "facade": dict(
            CATALOG_SQLS,
            customers={
                "sql": "SELECT id, owner_id, owner_scope, team_id FROM customers"
                       " WHERE id=$1 AND tenant_id=$2 AND is_deleted = false",
                "params": [3, TENANT],
            },
            preference_candidates={
                "sql": (
                    "SELECT i.product_name, i.spec_snapshot->>'product_key' AS product_key"
                    " FROM quote_order_items i JOIN quote_orders q"
                    "   ON q.tenant_id = i.tenant_id AND q.id = i.quote_order_id"
                    " WHERE i.tenant_id=$1 AND q.customer_id=$2"
                    "   AND i.product_name IS NOT NULL AND i.product_name <> ''"
                    "   AND (i.spec_snapshot->>'product_key' = $3"
                    "        OR i.spec_snapshot->>'product_key' IS NULL)"
                    " AND (q.owner_id = $4 OR q.owner_scope = 'tenant' OR q.team_id = $5)"
                    " ORDER BY q.created_at DESC, i.id DESC"),
                "params": [TENANT, 3, SPEC_KEY, "5", 2],
            },
        ),
        "response": pref_body,
    })

    _write("engine-import-template.fixture.json", {
        "_comment": (
            "P3 第六批金标：GET /api/v1/export-quote/products/{key}/import-template 的"
            "**JSON 分支**（带 format 的产文件分支留旧路径，不在切片内）。"
            "产品解析复用 _product_or_404_from_rows（旧 SQL = _effective_product_raw 的查询）。"
        ),
        "endpoint": {"method": "GET",
                     "path": "/api/v1/export-quote/products/" + SPEC_KEY + "/import-template",
                     "query_string": ""},
        "rpc": "/api/v1/internal/engine/quote/import-template",
        "request": {"product_key": SPEC_KEY,
                    "query": {"format": "", "examples": None, "include_spec": None}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": {"tenant_products": IMPORT_PRODUCT_ROWS},
        "old_sql": [{"sql": sql, "params": params} for sql, params in import_calls],
        "facade": {
            "tenant_products": {
                "sql": "SELECT spec, override, team_id FROM tenant_products"
                       " WHERE tenant_id=$1 AND product_key=$2 AND is_active",
                "params": [TENANT, SPEC_KEY],
            },
        },
        "response": import_body,
    })

    _write("engine-order-template-info.fixture.json", {
        "_comment": (
            "P3 第六批金标：GET /api/v1/export-quote/import/order/template-info。"
            "产品集合与产品目录同一份；列并集 = order_template_columns(所选产品)（共享内核）。"
        ),
        "endpoint": {"method": "GET",
                     "path": "/api/v1/export-quote/import/order/template-info",
                     "query_string": ORDER_KEYS_QUERY},
        "rpc": "/api/v1/internal/engine/quote/order-template-info",
        "request": {"query": {"product_keys": SPEC_KEY}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": DATASETS_CATALOG,
        "old_sql": [{"sql": sql, "params": params} for sql, params in order_calls],
        "facade": CATALOG_SQLS,
        "response": order_body,
    })

    print("products calls:", len(products_calls), "| pref calls:", len(pref_calls),
          "| import calls:", len(import_calls), "| order calls:", len(order_calls))
    print("products total:", products_body["total"],
          "| keys:", [p["key"] for p in products_body["products"]])
    print("pref:", pref_body, "| import columns:", len(import_body["columns"]),
          "| order headers:", len(order_body["headers"]), "keys:", order_body["product_keys"])


if __name__ == "__main__":
    main()
