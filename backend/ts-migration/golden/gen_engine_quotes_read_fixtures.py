# -*- coding: utf-8 -*-
r"""生成 P3 第四批切片金标 fixture：GET /api/v1/quotes（列表）+ /quotes/{quote_id}（详情）。

为什么要有这个脚本（而不是手写 fixture）
==========================================
fixture 里的 old_sql / facade / response 必须来自**旧路径真实跑一遍**，否则「改造前后一致」
无从谈起。本脚本用内核旧端点 + 桩 DB 跑一遍，把「实际发出的 SQL、绑定参数、响应 JSON」
原样落盘；两侧测试（backend/worker/tests/test_engine_rpc_quotes_read.py 与
backend/ts-worker/tests/engine-quotes-read.test.ts）都读**同一份** fixture。

本切片要点：
- 列表 = COUNT(*) + 当前页行 + 行数 GROUP BY + 下游单证/订单「锁定」两条 DISTINCT；
- 详情 = 单头（含可见性谓词）+ 行项 + 锁定两条（**第二条只在第一条无行时才发**，C 类形态）；
- 时间戳口径：门面用 tsIsoSql 同款**条件式** to_char（零微秒无小数，docs §8.9）；
  DATE 列用 to_char(col,'YYYY-MM-DD')（Python date.isoformat 口径）；
- 可见性：门面 SQL 下推 _scope_sql 同款谓词，内核再用共享 can_view 判一次（防御纵深）。
- fixture 同时覆盖「零微秒」与「非零微秒」时间戳样本（tsIsoSql 的回归点）。

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑，借它的 uv 环境）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_quotes_read_fixtures.py
"""
from __future__ import annotations

import json
import platform
import re
import sys
from datetime import date, datetime
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

# ── 时间戳/日期样本（零微秒与非零微秒都要有，锁 tsIsoSql 的条件式片段）────────
TS_NONZERO = "2026-10-19T10:00:00.123456+00:00"
TS_ZERO = "2026-10-19T10:05:00+00:00"
TS_ZERO_VALID = "2026-10-26T00:00:00+00:00"
TS_NONZERO_2 = "2026-10-19T09:00:00.987654+00:00"

QUOTE_ORDERS = [
    {   # 11：私有 + owner=我（行级可见规则 3）；被 orders 锁定
        "id": 11, "tenant_id": TENANT, "quote_no": "QUO-US-ACME-20261019000000",
        "customer_id": 3, "customer_name": "ACME 贸易", "inquiry_id": 9,
        "status": "draft", "currency": "USD", "total_amount": 100.0,
        "valid_until": TS_ZERO_VALID, "notes": "首批试单", "fx_rate": 7.1,
        "fx_rate_date": "2026-10-19",
        "tax_archive_id": 21, "tax_archive_code": "TAX-2026",
        "tax_archive_name": "出口退税档案",
        "tax_snapshot": {"output_vat_rate": 0.13, "rebate_rate": 0.09},
        "incoterm": "FOB", "payment_terms": "T/T", "port_of_loading": "Tianjin",
        "port_of_destination": "Hamburg", "shipping_marks": "N/M",
        "country_of_origin": "China", "destination_country": "Germany",
        "destination_region": "Hamburg", "carrier": "COSCO",
        "freight_valid_from": "2026-10-20", "freight_valid_to": "2026-11-20",
        "created_by": "5", "owner_id": "5", "owner_scope": "private", "team_id": 2,
        "created_at": TS_NONZERO, "updated_at": TS_ZERO,
    },
    {   # 12：owner=我；被 trade_docs（非 quotation）锁定
        "id": 12, "tenant_id": TENANT, "quote_no": "QUO-US-GLOBAL-20261018000000",
        "customer_id": 4, "customer_name": "GLOBAL LTD", "inquiry_id": None,
        "status": "sent", "currency": "EUR", "total_amount": 250.0,
        "valid_until": None, "notes": None, "fx_rate": 7.8, "fx_rate_date": None,
        "tax_archive_id": None, "tax_archive_code": None, "tax_archive_name": None,
        "tax_snapshot": None,
        "incoterm": None, "payment_terms": None, "port_of_loading": None,
        "port_of_destination": None, "shipping_marks": None, "country_of_origin": None,
        "destination_country": None, "destination_region": None, "carrier": None,
        "freight_valid_from": None, "freight_valid_to": None,
        "created_by": "5", "owner_id": "5", "owner_scope": "private", "team_id": 2,
        "created_at": TS_NONZERO_2, "updated_at": TS_NONZERO_2,
    },
    {   # 13：owner_scope=tenant（行级可见规则 2，团队不同也可见）；未被锁定
        "id": 13, "tenant_id": TENANT, "quote_no": "QUO-US-ACME-20261017000000",
        "customer_id": 3, "customer_name": "ACME 贸易", "inquiry_id": None,
        "status": "accepted", "currency": "USD", "total_amount": 88.5,
        "valid_until": None, "notes": None, "fx_rate": 7.1, "fx_rate_date": "2026-10-17",
        "tax_archive_id": None, "tax_archive_code": None, "tax_archive_name": None,
        "tax_snapshot": None,
        "incoterm": "CIF", "payment_terms": "L/C", "port_of_loading": "Qingdao",
        "port_of_destination": "Rotterdam", "shipping_marks": None,
        "country_of_origin": "China", "destination_country": "Netherlands",
        "destination_region": "Rotterdam", "carrier": None,
        "freight_valid_from": None, "freight_valid_to": None,
        "created_by": "9", "owner_id": "9", "owner_scope": "tenant", "team_id": 3,
        "created_at": "2026-10-17T08:00:00+00:00", "updated_at": "2026-10-17T08:01:00+00:00",
    },
]

QUOTE_ITEMS = [
    {
        "id": 1, "tenant_id": TENANT, "quote_order_id": 11, "sku_id": None,
        "product_name": "field_fence", "spec_snapshot": {"de": 2.0, "coating_code": "zinc_40"},
        "qty": 10.0, "qty_unit": "ROLLS", "unit_price": 2.5, "currency": "USD",
        "line_amount": 25.0, "sort_order": 0,
        "policy_override": {"profit_mode": "fixed"},
        "price_source": "auto", "cost_override": 1.2, "price_override": None,
        "weight_override": None, "volume_override": None, "image_url": None,
        "cost_breakdown": {"profit": 3.0}, "created_at": TS_NONZERO,
    },
    {
        "id": 2, "tenant_id": TENANT, "quote_order_id": 11, "sku_id": None,
        "product_name": "chain_link", "spec_snapshot": {"wire": "2.0"},
        "qty": 5.0, "qty_unit": "ROLLS", "unit_price": 4.0, "currency": "USD",
        "line_amount": 20.0, "sort_order": 1,
        "policy_override": None, "price_source": "manual", "cost_override": None,
        "price_override": 4.0, "weight_override": None, "volume_override": None,
        "image_url": None, "cost_breakdown": None, "created_at": TS_ZERO,
    },
]

ITEM_COUNTS = [
    {"quote_order_id": 11, "n": 2},
    {"quote_order_id": 13, "n": 1},
]
TRADE_DOCS_LOCKED = [{"quote_id": 12}]
ORDERS_LOCKED = [{"quote_id": 11}]

# ── 门面供数契约：SQL 必须与 TS 侧 engine.ts 逐字一致（由 fixture 锁定）──────
# quote_orders 列清单（与表结构一致；时间戳条件式 / DATE 用 to_char）
QUOTE_ORDER_COLUMNS = (
    "id, tenant_id, quote_no, customer_id, customer_name, inquiry_id, status, currency,"
    " total_amount, " + "%(ts_iso:valid_until)s" + ", notes, fx_rate, "
    + "to_char(fx_rate_date, 'YYYY-MM-DD') AS fx_rate_date"
    + ", tax_archive_id, tax_archive_code, tax_archive_name, tax_snapshot, incoterm,"
    " payment_terms, port_of_loading, port_of_destination, shipping_marks,"
    " country_of_origin, destination_country, destination_region, carrier, "
    + "to_char(freight_valid_from, 'YYYY-MM-DD') AS freight_valid_from"
    + ", to_char(freight_valid_to, 'YYYY-MM-DD') AS freight_valid_to"
    + ", created_by, owner_id, owner_scope, team_id, " + "%(ts_iso:created_at)s"
    + ", " + "%(ts_iso:updated_at)s"
)

QUOTE_ITEM_COLUMNS = (
    "id, tenant_id, quote_order_id, sku_id, product_name, spec_snapshot, qty, qty_unit,"
    " unit_price, currency, line_amount, sort_order, policy_override, price_source,"
    " cost_override, price_override, weight_override, volume_override, image_url,"
    " cost_breakdown, " + "%(ts_iso:created_at)s"
)


def _render(sql_template: str) -> str:
    """把 %(ts_iso:col)s 占位替换成条件式 to_char 片段（与 engine.ts tsIsoSql 逐字一致）。"""

    def _sub(match: "re.Match[str]") -> str:
        col = match.group(1)
        utc = col + " AT TIME ZONE 'UTC'"
        return (
            "CASE WHEN to_char(" + utc + ", 'US') = '000000'"
            " THEN to_char(" + utc + ", 'YYYY-MM-DD\"T\"HH24:MI:SS')"
            " ELSE to_char(" + utc + ", 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
            " END || '+00:00' AS " + col
        )

    return re.sub(r"%\(ts_iso:([a-z_]+)\)s", _sub, sql_template)


SCOPE_FRAG = "(owner_id = $%d OR owner_scope = 'tenant' OR team_id = $%d)"

LIST_QUERY = "page=1&page_size=20"


def _list_cond_params() -> tuple[str, list]:
    # 列表 fixture 请求无筛选参数 ⇒ 参数顺序 = tenant, 作用域(owner_id, team_id)
    params = [TENANT, str(ACTOR["id"]), ACTOR["team_id"]]
    cond = "tenant_id = $1 AND (owner_id = $2 OR owner_scope = 'tenant' OR team_id = $3)"
    return cond, params


def _detail_cond_params(quote_id: int) -> tuple[str, list]:
    params = [TENANT, quote_id, str(ACTOR["id"]), ACTOR["team_id"]]
    cond = ("tenant_id = $1 AND id = $2"
            " AND (owner_id = $3 OR owner_scope = 'tenant' OR team_id = $4)")
    return cond, params


def _facade(list_cond: str, list_params: list, detail_cond: str,
            detail_params: list) -> dict:
    page_size = 20
    offset = 0
    quote_columns = _render(QUOTE_ORDER_COLUMNS)
    item_columns = _render(QUOTE_ITEM_COLUMNS)
    return {
        "quote_orders_total": {
            "sql": "SELECT COUNT(*) AS count FROM quote_orders WHERE " + list_cond,
            "params": list(list_params),
        },
        "quote_orders": {
            "columns": quote_columns,
            "sql": ("SELECT " + quote_columns + " FROM quote_orders WHERE " + list_cond
                    + " ORDER BY created_at DESC, id DESC LIMIT $%d OFFSET $%d"
                    % (len(list_params) + 1, len(list_params) + 2)),
            "params": list(list_params) + [page_size, offset],
        },
        "quote_order_item_counts": {
            "columns": item_columns,
            "sql": ("SELECT quote_order_id, COUNT(*) AS n FROM quote_order_items"
                    " WHERE tenant_id=$1 AND quote_order_id = ANY($2::bigint[])"
                    " GROUP BY quote_order_id"),
            "params": [TENANT, [11, 12, 13]],
        },
        "trade_docs_locked": {
            "sql": ("SELECT DISTINCT quote_id FROM trade_docs"
                    " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[])"
                    " AND doc_type <> 'quotation'"),
            "params": [TENANT, [11, 12, 13]],
        },
        "orders_locked": {
            "sql": ("SELECT DISTINCT quote_id FROM orders"
                    " WHERE tenant_id=$1 AND quote_id = ANY($2::bigint[])"),
            "params": [TENANT, [11, 12, 13]],
        },
        "quote_orders_detail": {
            "columns": quote_columns,
            "sql": ("SELECT " + quote_columns + " FROM quote_orders WHERE " + detail_cond),
            "params": list(detail_params),
        },
        "quote_order_items_detail": {
            "columns": item_columns,
            "sql": ("SELECT " + item_columns + " FROM quote_order_items"
                    " WHERE tenant_id=$1 AND quote_order_id=$2 ORDER BY sort_order, id"),
            "params": [TENANT, 11],
        },
        "trade_docs_lock_detail": {
            "sql": ("SELECT 1 AS locked FROM trade_docs WHERE tenant_id=$1 AND quote_id=$2"
                    " AND doc_type <> 'quotation' LIMIT 1"),
            "params": [TENANT, 11],
        },
        "orders_lock_detail": {
            "sql": ("SELECT 1 AS locked FROM orders WHERE tenant_id=$1 AND quote_id=$2 LIMIT 1"),
            "params": [TENANT, 11],
        },
    }


def _py_quote_row(row: dict) -> dict:
    """dataset 行 → 旧路径桩的行形状（时间戳/日期还原成 datetime/date）。"""
    out = dict(row)
    for field in ("created_at", "updated_at", "valid_until"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = datetime.fromisoformat(value)
    for field in ("fx_rate_date", "freight_valid_from", "freight_valid_to"):
        value = out.get(field)
        if isinstance(value, str) and value:
            out[field] = date.fromisoformat(value)
    return out


def _py_item_row(row: dict) -> dict:
    out = dict(row)
    value = out.get("created_at")
    if isinstance(value, str) and value:
        out["created_at"] = datetime.fromisoformat(value)
    return out


list_calls: list = []
detail_calls: list = []
_mode = {"name": "list"}


def _record(sql: str, params) -> None:
    target = list_calls if _mode["name"] == "list" else detail_calls
    target.append((re.sub(r"\s+", " ", sql).strip(), list(params)))


async def fake_fetchval(request, sql, *args):
    _record(sql, args)
    if "COUNT(*)" in sql:
        return len(QUOTE_ORDERS)
    if "FROM trade_docs" in sql:
        return 1 if any(r["quote_id"] == int(args[1]) for r in TRADE_DOCS_LOCKED) else None
    if "FROM orders" in sql:
        return 1 if any(r["quote_id"] == int(args[1]) for r in ORDERS_LOCKED) else None
    raise AssertionError("unexpected fetchval: " + sql)


async def fake_fetch(request, sql, *args):
    _record(sql, args)
    if "FROM quote_orders" in sql:
        return [_py_quote_row(r) for r in QUOTE_ORDERS]
    if "FROM quote_order_items" in sql:
        return [dict(r) for r in ITEM_COUNTS]
    if "FROM trade_docs" in sql:
        ids = set(int(x) for x in args[1])
        return [dict(r) for r in TRADE_DOCS_LOCKED if r["quote_id"] in ids]
    if "FROM orders" in sql:
        ids = set(int(x) for x in args[1])
        return [dict(r) for r in ORDERS_LOCKED if r["quote_id"] in ids]
    raise AssertionError("unexpected fetch: " + sql)


class _FakeConn:
    async def fetchrow(self, sql, *args):
        _record(sql, args)
        if "FROM quote_orders" in sql:
            wanted = int(args[1])
            for row in QUOTE_ORDERS:
                if row["id"] == wanted:
                    return _py_quote_row(row)
            return None
        raise AssertionError("unexpected conn.fetchrow: " + sql)

    async def fetch(self, sql, *args):
        _record(sql, args)
        if "FROM quote_order_items" in sql:
            wanted = int(args[1])
            return [_py_item_row(r) for r in QUOTE_ITEMS if r["quote_order_id"] == wanted]
        raise AssertionError("unexpected conn.fetch: " + sql)


class _FakeAcquire:
    def __init__(self, request):
        self.request = request

    async def __aenter__(self):
        return _FakeConn()

    async def __aexit__(self, *exc):
        return False


def _stub_db(original: dict) -> dict:
    original["fetchval"] = worker_main.db.fetchval
    original["fetch"] = worker_main.db.fetch
    original["acquire"] = worker_main.db.acquire
    worker_main.db.fetchval = fake_fetchval
    worker_main.db.fetch = fake_fetch
    worker_main.db.acquire = lambda request: _FakeAcquire(request)
    return original


def _restore_db(original: dict) -> None:
    worker_main.db.fetchval = original["fetchval"]
    worker_main.db.fetch = original["fetch"]
    worker_main.db.acquire = original["acquire"]
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
    _stub_db(original)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: _actor()
    try:
        _mode["name"] = "list"
        resp = client.get("/api/v1/quotes?" + LIST_QUERY)
        assert resp.status_code == 200, resp.text
        list_body = resp.json()

        _mode["name"] = "detail"
        resp = client.get("/api/v1/quotes/11")
        assert resp.status_code == 200, resp.text
        detail_body = resp.json()
    finally:
        _restore_db(original)

    list_cond, list_params = _list_cond_params()
    detail_cond, detail_params = _detail_cond_params(11)
    facade = _facade(list_cond, list_params, detail_cond, detail_params)

    datasets_list = {
        "quote_orders_total": [{"count": len(QUOTE_ORDERS)}],
        "quote_orders": QUOTE_ORDERS,
        "quote_order_item_counts": ITEM_COUNTS,
        "trade_docs_locked": TRADE_DOCS_LOCKED,
        "orders_locked": ORDERS_LOCKED,
    }
    datasets_detail = {
        "quote_orders": [QUOTE_ORDERS[0]],
        "quote_order_items": QUOTE_ITEMS,
        "trade_docs_locked": [],
        "orders_locked": [{"locked": 1}],
    }

    _write("engine-quotes-list.fixture.json", {
        "_comment": (
            "P3 第四批切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8）："
            "GET /api/v1/quotes（列表）。由 gen_engine_quotes_read_fixtures.py 用内核**旧路径**"
            "真实跑一遍生成：response = 旧路径真实响应体；old_sql = 旧路径实际执行的 SQL 与绑定"
            "参数（按执行顺序）；facade = 门面供数契约（查哪些 dataset / SQL 文本 / 绑定参数）；"
            "datasets = 门面下发给内核的行。两侧测试共用本文件（TS 断言 SQL/参数/payload/回放，"
            "Python 断言旧==新==response 且旧 SQL 不变）。"
            "时间戳同时覆盖零微秒（valid_until/updated_at/13 的 created_at）与非零微秒"
            "（11 的 created_at、12 的 created_at）—— 门面 SQL 必须用条件式 to_char（docs §8.9）。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/quotes",
                     "query_string": LIST_QUERY},
        "rpc": "/api/v1/internal/engine/quotes/list",
        "request": {"query": {"status": None, "customer_id": None, "inquiry_id": None,
                              "page": "1", "page_size": "20"}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": datasets_list,
        "old_sql": [{"sql": sql, "params": params} for sql, params in list_calls],
        "facade": facade,
        "response": list_body,
    })

    _write("engine-quotes-detail.fixture.json", {
        "_comment": (
            "P3 第四批切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6/§8）："
            "GET /api/v1/quotes/{quote_id}（详情）。同目录同脚本用旧路径真实生成；"
            "注意旧路径「锁定」查询是 C 类形态：trade_docs 有行就不再查 orders —— "
            "门面按同一条件取数（datasets.trade_docs_locked 为空时才查 orders）。"
            "行项时间戳同样覆盖零微秒（id=2 的 created_at）与非零微秒（id=1）。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/quotes/11", "query_string": ""},
        "rpc": "/api/v1/internal/engine/quotes/detail",
        "request": {"quote_id": 11},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": datasets_detail,
        "old_sql": [{"sql": sql, "params": params} for sql, params in detail_calls],
        "facade": facade,
        "response": detail_body,
    })

    print("list old db calls:", len(list_calls), "| detail old db calls:", len(detail_calls))
    print("list items:", [i["id"] for i in list_body["items"]],
          "| editable:", [i["quote_no_editable"] for i in list_body["items"]])
    print("detail items:", [i["id"] for i in detail_body["items"]],
          "| editable:", detail_body["quote_no_editable"])


if __name__ == "__main__":
    main()
