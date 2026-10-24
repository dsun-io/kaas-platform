# -*- coding: utf-8 -*-
r"""生成 P3 第五批切片金标 fixture：GET /api/v1/trade-docs（列表）+ /{doc_id}（详情）。

为什么要脚本而不是手写（与 export-quote / render-data / quotes 同款）
====================================================================
fixture 里的 old_sql / facade / response 必须来自旧路径真实跑一遍：用内核旧端点 + 桩 DB
跑一遍，把「实际发出的 SQL、绑定参数、响应 JSON」原样落盘；两侧测试（worker 与 ts-worker）
都读同一份 fixture ⇒ 任一侧语义漂移都会在 CI 变红。

本切片要点：
- 列表 = COUNT(*) + 当前页行 + 逐行的「链路更晚单证」检查（N 次 queries）+
  trade_doc_render_checks（ANY 批量，可能为空）；
- 详情 = 单头（**无** SQL 作用域谓词，可见性是行级纯判定 _require_doc_visible）+
  entity_links（上游 refs）+ 链路更晚单证检查；
- 时间戳一律条件式 to_char（零微秒无小数，docs §8.9）；
- BIGINT 用 number / NUMERIC total_amount 用 number（旧路径由 FastAPI 把 Decimal 转 float）；
- 可见性：门面 SQL 只对列表下推作用域谓词；内核再判一次（_doc_visible / _require_doc_visible）。

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_trade_docs_read_fixtures.py
"""
from __future__ import annotations

import json
import platform
import re
import sys
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import asyncpg  # noqa: F401  (预热 stdlib platform，见同目录其它生成器注释)

platform.uname()

BACKEND = Path(__file__).resolve().parents[2]
WORKER = BACKEND / "worker"
sys.path.insert(0, str(WORKER / "src"))
sys.path.insert(0, str(WORKER / "tests"))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}
TENANT = "default"

TS_NONZERO = "2026-10-20T10:00:00.123456+00:00"
TS_ZERO = "2026-10-19T09:00:00+00:00"
TS_ISSUED_ZERO = "2026-10-21T08:00:00+00:00"
TS_ISSUED_NONZERO = "2026-10-20T10:30:00.987654+00:00"

RAW_PAYLOAD_11 = {
    "sources": {"order": {"order_no": "ORD-US-ACME-20261019", "customer_name": "ACME 贸易"}},
    "custom": {"shipping_marks": "N/M", "incoterm": "FOB"},
}

TRADE_DOCS = [
    {   # 11：owner=我 + 本团队；同链路（order 21）后面还有 12 ⇒ doc_no_editable=false
        "id": 11, "tenant_id": TENANT, "doc_no": "PACKING-US-ACME-20261020000001",
        "doc_type": "packing_list", "order_id": 21, "customer_id": 3, "quote_id": None,
        "status": "issued", "currency": "USD", "total_amount": 100.0,
        "issued_at": TS_ISSUED_ZERO, "issued_by": "5",
        "raw_payload": RAW_PAYLOAD_11,
        "owner_id": "5", "owner_scope": "private", "team_id": 2, "with_seal": True,
        "created_at": TS_NONZERO, "updated_at": TS_ZERO,
    },
    {   # 12：owner_scope=tenant（不同团队也可见）；已是最晚 ⇒ doc_no_editable=true
        "id": 12, "tenant_id": TENANT, "doc_no": "PACKING-US-ACME-20261019000002",
        "doc_type": "packing_list", "order_id": 21, "customer_id": 3, "quote_id": None,
        "status": "issued", "currency": "USD", "total_amount": 250.5,
        "issued_at": TS_ISSUED_NONZERO, "issued_by": "9",
        "raw_payload": None,
        "owner_id": "9", "owner_scope": "tenant", "team_id": 3, "with_seal": False,
        "created_at": TS_ZERO, "updated_at": TS_NONZERO,
    },
]

RENDER_CHECKS = [{
    "trade_doc_id": 11,
    "matches": False,
    "reason": "data_changed",
    "render_version_drift": True,
    "checked_at": TS_NONZERO,
}]

ENTITY_LINKS = [
    {"dst_type": "order", "dst_id": 21, "rel_type": "generated_from", "meta": None},
    {"dst_type": "inquiry", "dst_id": 9, "rel_type": "generated_from",
     "meta": {"origin_ref_type": "derived_from"}},
]

LIST_QUERY = "doc_type=packing_list&status=issued"

# ── 门面供数契约（SQL 必须与 TS engine.ts 逐字一致；fixture 锁定）────────────
TRADE_DOC_COLUMNS = (
    "id, tenant_id, doc_no, doc_type, order_id, customer_id, quote_id, status,"
    " currency, total_amount, %(ts_iso:issued_at)s, issued_by, raw_payload,"
    " owner_id, owner_scope, team_id, with_seal, %(ts_iso:created_at)s,"
    " %(ts_iso:updated_at)s"
)

TS_ISO_RE = re.compile(r"%\(ts_iso:([a-z_]+)\)s")


def _render(sql_template: str) -> str:
    def _sub(match):
        col = match.group(1)
        utc = col + " AT TIME ZONE 'UTC'"
        return (
            "CASE WHEN to_char(" + utc + ", 'US') = '000000'"
            ' THEN to_char(' + utc + """, 'YYYY-MM-DD"T"HH24:MI:SS')"""
            " ELSE to_char(" + utc + """, 'YYYY-MM-DD"T"HH24:MI:SS.US')"""
            " END || '+00:00' AS " + col
        )

    return TS_ISO_RE.sub(_sub, sql_template)


LIST_COND = (
    "tenant_id = $1 AND doc_type = $2 AND status = $3"
    " AND (team_id = $4 OR owner_id = $5 OR owner_scope = 'tenant')"
)
LIST_PARAMS = [TENANT, "packing_list", "issued", 2, "5"]
DETAIL_COND = "tenant_id = $1 AND id = $2"
DETAIL_PARAMS = [TENANT, 11]
LATER_SQL_ORDER = (
    "SELECT 1 FROM trade_docs WHERE tenant_id=$1 AND order_id=$2 AND id>$3 LIMIT 1"
)
CHECKS_SQL = (
    "SELECT trade_doc_id, matches, reason, render_version_drift, checked_at"
    " FROM trade_doc_render_checks WHERE tenant_id=$1"
    " AND trade_doc_id = ANY($2::bigint[])"
)
LINKS_SQL = (
    "SELECT dst_type, dst_id, rel_type, meta FROM entity_links"
    " WHERE tenant_id=$1 AND src_type='trade_doc' AND src_id=$2"
    " AND deleted_at IS NULL ORDER BY id"
)

list_calls: list = []
detail_calls: list = []
_mode = {"name": "list"}


def _record(sql: str, params) -> None:
    target = list_calls if _mode["name"] == "list" else detail_calls
    target.append((re.sub(r"\s+", " ", sql).strip(), list(params)))


def _py_doc_row(row: dict) -> dict:
    out = dict(row)
    for field in ("issued_at", "created_at", "updated_at"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    if out.get("total_amount") is not None:
        out["total_amount"] = Decimal(str(out["total_amount"]))
    return out


def _later_of(order_id, quote_id, doc_id: int):
    if quote_id is not None:
        return 1 if any(d["quote_id"] == quote_id and d["id"] > doc_id for d in TRADE_DOCS) else None
    if order_id is not None:
        return 1 if any(d["order_id"] == order_id and d["id"] > doc_id for d in TRADE_DOCS) else None
    return None


class _FakeConn:
    async def fetchval(self, sql, *args):
        _record(sql, args)
        if "COUNT(*)" in sql:
            return len(TRADE_DOCS)
        if "FROM trade_docs" in sql and "AND id>$3" in sql:
            tenant, ref, doc_id = args
            if "quote_id=$2" in sql:
                return _later_of(None, ref, int(doc_id))
            return _later_of(ref, None, int(doc_id))
        raise AssertionError("unexpected fetchval: " + sql)

    async def fetch(self, sql, *args):
        _record(sql, args)
        if "FROM trade_docs" in sql:
            return [_py_doc_row(r) for r in TRADE_DOCS]
        if "FROM trade_doc_render_checks" in sql:
            return [dict(r) for r in RENDER_CHECKS]
        if "FROM entity_links" in sql:
            return [dict(r) for r in ENTITY_LINKS]
        raise AssertionError("unexpected fetch: " + sql)


class _FakeAcquire:
    def __init__(self, request):
        self.request = request

    async def __aenter__(self):
        return _FakeConn()

    async def __aexit__(self, *exc):
        return False


async def fake_db_fetchrow(request, sql, *args, **kwargs):
    _record(sql, args)
    if "FROM trade_docs" in sql:
        wanted = int(args[1])
        for row in TRADE_DOCS:
            if row["id"] == wanted:
                return _py_doc_row(row)
        return None
    raise AssertionError("unexpected db.fetchrow: " + sql)


def _stub(original: dict) -> dict:
    original["fetchrow"] = worker_main.db.fetchrow
    original["acquire"] = worker_main._acquire
    worker_main.db.fetchrow = fake_db_fetchrow
    worker_main._acquire = lambda request: _FakeAcquire(request)
    return original


def _restore(original: dict) -> None:
    worker_main.db.fetchrow = original["fetchrow"]
    worker_main._acquire = original["acquire"]
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


def main() -> None:
    original: dict = {}
    _stub(original)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: _actor()
    try:
        _mode["name"] = "list"
        resp = client.get("/api/v1/trade-docs?" + LIST_QUERY)
        assert resp.status_code == 200, resp.text
        list_body = resp.json()

        _mode["name"] = "detail"
        resp = client.get("/api/v1/trade-docs/11")
        assert resp.status_code == 200, resp.text
        detail_body = resp.json()
    finally:
        _restore(original)

    columns = _render(TRADE_DOC_COLUMNS)
    facade = {
        "trade_docs_total": {
            "sql": "SELECT COUNT(*) AS count FROM trade_docs WHERE " + LIST_COND,
            "params": list(LIST_PARAMS),
        },
        "trade_docs": {
            "columns": columns,
            "sql": ("SELECT " + columns + " FROM trade_docs WHERE " + LIST_COND
                    + " ORDER BY created_at DESC, id DESC LIMIT $6 OFFSET $7"),
            "params": list(LIST_PARAMS) + [20, 0],
        },
        "later_docs": {"sql": LATER_SQL_ORDER, "params": [TENANT, 21, 11]},
        "render_checks": {"sql": CHECKS_SQL, "params": [TENANT, [11, 12]]},
        "trade_docs_detail": {
            "columns": columns,
            "sql": "SELECT " + columns + " FROM trade_docs WHERE " + DETAIL_COND,
            "params": list(DETAIL_PARAMS),
        },
        "entity_links": {"sql": LINKS_SQL, "params": [TENANT, 11]},
        "later_docs_detail": {"sql": LATER_SQL_ORDER, "params": [TENANT, 21, 11]},
    }

    datasets_list = {
        "trade_docs_total": [{"count": len(TRADE_DOCS)}],
        "trade_docs": TRADE_DOCS,
        "later_docs": [{"doc_id": 11}],
        "render_checks": RENDER_CHECKS,
    }
    datasets_detail = {
        "trade_docs": [TRADE_DOCS[0]],
        "entity_links": ENTITY_LINKS,
        "later_docs": [{"locked": 1}],
    }

    _write("engine-trade-docs-list.fixture.json", {
        "_comment": (
            "P3 第五批切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8）："
            "GET /api/v1/trade-docs（列表）。由 gen_engine_trade_docs_read_fixtures.py 用内核"
            "旧路径真实跑一遍生成：response = 旧路径真实响应体；old_sql = 旧路径实际执行的 SQL"
            " 与绑定参数（按执行顺序，含逐行的链路更晚单证检查 N 次）；facade = 门面供数契约；"
            "datasets = 门面下发给内核的行。两侧测试共用本文件。"
            "时间戳同时覆盖零微秒（11 的 issued_at/updated_at、12 的 created_at）与非零微秒。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/trade-docs",
                     "query_string": LIST_QUERY},
        "rpc": "/api/v1/internal/engine/trade-docs/list",
        "request": {"query": {"doc_type": "packing_list", "status": "issued",
                              "order_id": None, "page": None, "page_size": None}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": datasets_list,
        "old_sql": [{"sql": sql, "params": params} for sql, params in list_calls],
        "facade": facade,
        "response": list_body,
    })

    _write("engine-trade-docs-detail.fixture.json", {
        "_comment": (
            "P3 第五批切片金标：GET /api/v1/trade-docs/{doc_id}（详情）。同脚本用旧路径真实生成。"
            "注意：详情 SQL 没有作用域谓词 —— 可见性是行级纯判定 _require_doc_visible"
            "（404 DOC_NOT_FOUND，不泄露存在性）；上游 refs = 列优先 + entity_links 兜底。"
            "时间戳同时覆盖零微秒（issued_at）与非零微秒（created_at/updated_at）。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/trade-docs/11", "query_string": ""},
        "rpc": "/api/v1/internal/engine/trade-docs/detail",
        "request": {"doc_id": 11},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": datasets_detail,
        "old_sql": [{"sql": sql, "params": params} for sql, params in detail_calls],
        "facade": facade,
        "response": detail_body,
    })

    print("list old db calls:", len(list_calls), "| detail old db calls:", len(detail_calls))
    print("list ids:", [i["id"] for i in list_body["items"]],
          "| editable:", [i["doc_no_editable"] for i in list_body["items"]],
          "| render_check:", [i["render_check"] for i in list_body["items"]])
    print("detail refs:", detail_body["refs"], "| editable:", detail_body["doc_no_editable"])


if __name__ == "__main__":
    main()
