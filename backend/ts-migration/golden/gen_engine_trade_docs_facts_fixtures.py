# -*- coding: utf-8 -*-
r"""生成 P3 第八批金标：GET /trade-docs/{id}/facts + /consistency 的 fixture。"""
from __future__ import annotations

import json
import platform
import re
import sys
from datetime import datetime, timezone
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
from kaas_common.export_quote import get_product  # noqa: E402
from kaas_common.export_quote.tenant_products import spec_to_dict  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}
TENANT = "default"
PRODUCT_KEY = "field_fence"
TS_NONZERO = "2026-10-20T10:00:00.123456+00:00"
TS_ZERO = "2026-10-19T09:00:00+00:00"
TS_ISSUED = "2026-10-21T08:00:00+00:00"

RAW_PAYLOAD = {
    "sources": {
        "order": {
            "order_no": "ORD-US-ACME-20261019",
            "customer_name": "ACME 贸易",
            "items": [{
                "product_name": "Field Fence",
                "spec_snapshot": {"product_key": PRODUCT_KEY,
                                  "packaging_id": "pk_1"},
            }],
        },
    },
    "custom": {"incoterm": "DAP Yangzhou, Jiangsu, China", "payment_terms": "T/T 30%"},
}

TRADE_DOCS = [
    {   # 11：PI（基线）
        "id": 11, "tenant_id": TENANT, "doc_no": "PI-US-ACME-20261019000001",
        "doc_type": "pi", "order_id": 1, "customer_id": 3, "quote_id": None,
        "status": "issued", "currency": "USD", "total_amount": 100.0,
        "issued_at": TS_ISSUED, "issued_by": "5", "raw_payload": RAW_PAYLOAD,
        "owner_id": "5", "owner_scope": "private", "team_id": 2, "with_seal": True,
        "created_at": TS_NONZERO, "updated_at": TS_ZERO,
    },
    {   # 12：CI（Incoterms 版本被删 ⇒ 冲突）
        "id": 12, "tenant_id": TENANT, "doc_no": "CI-US-ACME-20261020000002",
        "doc_type": "ci", "order_id": 1, "customer_id": 3, "quote_id": None,
        "status": "draft", "currency": "USD", "total_amount": 100.0,
        "issued_at": None, "issued_by": "5",
        "raw_payload": {**RAW_PAYLOAD,
                        "custom": {"incoterm": "DAP Yangzhou",
                                   "payment_terms": "T/T 30%"}},
        "owner_id": "5", "owner_scope": "private", "team_id": 2, "with_seal": True,
        "created_at": TS_ZERO, "updated_at": TS_NONZERO,
    },
]

FACT_ROWS = [
    {"fact_key": "incoterm", "trust": "confirmed", "immutable": True,
     "confirmed_by": "7", "confirmed_at": TS_NONZERO,
     "text_zh": "交货条件", "text_en": "DAP Yangzhou (Incoterms 2020)",
     "source": "manual", "evidence_ref": "custom.incoterm"},
    {"fact_key": "payment_terms", "trust": "inferred", "immutable": False,
     "confirmed_by": None, "confirmed_at": None,
     "text_zh": "付款条件", "text_en": None,
     "source": "inferred", "evidence_ref": None},
]

# 产品定义（带包装配置，让 _packing_from_product 的「本单行命中」分支可达）
SPEC = spec_to_dict(get_product(PRODUCT_KEY))
SPEC["packaging"] = [
    {"id": "pk_1", "name": "卷装", "method": "roll", "is_default": False},
    {"id": "pk_2", "name": "托盘", "method": "pallet", "is_default": True},
]
PRODUCT_ROWS = [{"spec": SPEC, "override": None, "team_id": 2}]

calls: list = []


def _record(sql: str, params) -> None:
    calls.append((re.sub(r"\s+", " ", sql).strip(), list(params)))


def _py_doc(row: dict) -> dict:
    out = dict(row)
    for field in ("issued_at", "created_at", "updated_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    return out


class _FakeAcquireConn:
    async def fetchrow(self, sql, *args):
        _record(sql, args)
        raise AssertionError("unexpected fetchrow: " + sql)

    async def fetch(self, sql, *args):
        _record(sql, args)
        raise AssertionError("unexpected fetch: " + sql)


async def fake_fetchrow(request, sql, *args, **kwargs):
    _record(sql, args)
    if "FROM trade_docs" in sql:
        wanted = int(args[1])
        for row in TRADE_DOCS:
            if row["id"] == wanted:
                return _py_doc(row)
        return None
    raise AssertionError("unexpected db.fetchrow: " + sql)


async def fake_fetch(request, sql, *args, **kwargs):
    _record(sql, args)
    if "FROM trade_doc_facts" in sql:
        return [dict(r) for r in FACT_ROWS]
    if "FROM tenant_products" in sql:
        return [dict(r) for r in PRODUCT_ROWS]
    if "FROM trade_docs" in sql and "order_id=$2" in sql:
        return [_py_doc(r) for r in TRADE_DOCS if r["order_id"] == int(args[1])]
    if "FROM entity_links" in sql:
        return []
    raise AssertionError("unexpected db.fetch: " + sql)


def _stub(original: dict) -> dict:
    original["fetchrow"] = worker_main.db.fetchrow
    original["fetch"] = worker_main.db.fetch
    original["acquire"] = worker_main._acquire
    worker_main.db.fetchrow = fake_fetchrow
    worker_main.db.fetch = fake_fetch
    worker_main._acquire = lambda request: _FakeAcquireConn()
    return original


def _restore(original: dict) -> None:
    worker_main.db.fetchrow = original["fetchrow"]
    worker_main.db.fetch = original["fetch"]
    worker_main._acquire = original["acquire"]
    worker_main.app.dependency_overrides.clear()


def _ts_sql(col: str) -> str:
    return ("CASE WHEN to_char(" + col + " AT TIME ZONE 'UTC', 'US') = '000000'"
            " THEN to_char(" + col + " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')"
            " ELSE to_char(" + col + " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
            " END || '+00:00' AS " + col)


def _doc_columns() -> str:
    return ("id, tenant_id, doc_no, doc_type, order_id, customer_id, quote_id, status,"
            " currency, total_amount, " + _ts_sql("issued_at") + ", issued_by, raw_payload,"
            " owner_id, owner_scope, team_id, with_seal, " + _ts_sql("created_at")
            + ", " + _ts_sql("updated_at"))


def _write(name: str, fixture: dict) -> None:
    out = Path(__file__).with_name(name)
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fixture written:", out.name, "bytes:", out.stat().st_size)


def _run(path: str) -> dict:
    global calls
    calls = []
    original: dict = {}
    _stub(original)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(
        ACTOR, email="buyer@qa.test", display_name="买家", status="active",
        console_access=False, plan="free")
    try:
        response = client.get(path)
    finally:
        _restore(original)
    assert response.status_code == 200, (path, response.text)
    return response.json()


def main() -> None:
    quote_api._require_engine()
    facts_body = None
    calls_facts: list = []
    facts_body = _run("/api/v1/trade-docs/11/facts")
    calls_facts = list(calls)
    consistency_body = _run("/api/v1/trade-docs/12/consistency")
    calls_consistency = list(calls)

    columns = _doc_columns()
    facts_fixture = {
        "_comment": (
            "P3 第八批金标：GET /trade-docs/{doc_id}/facts（事实清单 + 表内处置叠加）。"
            "old_sql = 旧路径实际执行的查询（doc → 产品定义 → 处置行）；"
            "datasets = 门面下发的 trade_docs(1) + trade_doc_facts + tenant_products(全量 active)。"
            "注意：门面恒下发 tenant_products（旧路径按行项快照形状才查；多一份只读数据等价），"
            "产品解析失败仍按无配置降级。时间戳覆盖零/非零微秒。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/trade-docs/11/facts",
                     "query_string": ""},
        "rpc": "/api/v1/internal/engine/trade-docs/facts",
        "request": {"doc_id": 11},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": {
            "trade_docs": [TRADE_DOCS[0]],
            "trade_doc_facts": FACT_ROWS,
            "tenant_products": PRODUCT_ROWS,
        },
        "old_sql": [{"sql": sql, "params": params} for sql, params in calls_facts],
        "facade": {
            "trade_docs": {
                "columns": columns,
                "sql": "SELECT " + columns + " FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                "params": [TENANT, 11],
            },
            "trade_doc_facts": {
                "sql": (
                    "SELECT fact_key, trust, immutable, confirmed_by, "
                    + _ts_sql("confirmed_at")
                    + ", text_zh, text_en, source, evidence_ref FROM trade_doc_facts"
                    " WHERE tenant_id=$1 AND trade_doc_id=$2 ORDER BY fact_key"),
                "params": [TENANT, 11],
            },
            "tenant_products": {
                "sql": "SELECT spec, override, team_id FROM tenant_products"
                       " WHERE tenant_id=$1 AND is_active",
                "params": [TENANT],
            },
        },
        "response": facts_body,
    }
    _write("engine-trade-docs-facts.fixture.json", facts_fixture)

    consistency_fixture = {
        "_comment": (
            "P3 第八批金标：GET /trade-docs/{doc_id}/consistency（跨单证事实矩阵）。"
            "old_sql = 旧路径实际执行的查询（doc → 同 order 链的单证行）；"
            "domain 退化顺序：order 列 → 边表 order → quote 链 → 自身（门面按同一条件发查询，"
            "内核 _domain_docs_from_parts 再判一次）。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/trade-docs/12/consistency",
                     "query_string": ""},
        "rpc": "/api/v1/internal/engine/trade-docs/consistency",
        "request": {"doc_id": 12},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": {
            "trade_docs": [TRADE_DOCS[1]],
            "linked_order_links": [],
            "trade_docs_by_order": [TRADE_DOCS[0], TRADE_DOCS[1]],
            "linked_quote_links": [],
            "trade_docs_by_quote": [],
        },
        "old_sql": [{"sql": sql, "params": params} for sql, params in calls_consistency],
        "facade": {
            "trade_docs": {
                "columns": columns,
                "sql": "SELECT " + columns + " FROM trade_docs WHERE tenant_id=$1 AND id=$2",
                "params": [TENANT, 12],
            },
            "trade_docs_by_order": {
                "columns": columns,
                "sql": "SELECT " + columns + " FROM trade_docs WHERE tenant_id=$1"
                       " AND order_id=$2 AND status <> 'void' ORDER BY id",
                "params": [TENANT, 1],
            },
            "linked_order_sql": (
                "SELECT dst_id FROM entity_links WHERE tenant_id=$1"
                " AND src_type='trade_doc' AND src_id=$2 AND dst_type='order'"
                " AND deleted_at IS NULL ORDER BY id LIMIT 1"),
            "linked_quote_sql": (
                "SELECT dst_id FROM entity_links WHERE tenant_id=$1"
                " AND src_type='trade_doc' AND src_id=$2 AND dst_type='quote'"
                " AND deleted_at IS NULL ORDER BY id LIMIT 1"),
        },
        "response": consistency_body,
    }
    _write("engine-trade-docs-consistency.fixture.json", consistency_fixture)

    print("facts old db calls:", len(calls_facts),
          "| consistency old db calls:", len(calls_consistency))
    print("facts items:", len(facts_body["items"]), "| summary:", facts_body["summary"])
    print("packing facts:", [i for i in facts_body["items"]
                             if i["key"].startswith("packing")])
    print("consistency ok:", consistency_body["ok"], "| items:", len(consistency_body["items"]),
          "| domain:", consistency_body["domain"])


if __name__ == "__main__":
    main()
