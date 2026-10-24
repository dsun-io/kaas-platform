# -*- coding: utf-8 -*-
r"""生成 P3 第七批金标：GET /api/v1/pricing-data（定价数据矩阵）的 fixture。

用旧路径 + 桩 DB 真实跑一遍（与其它批次同款）；datetime.now 在生成期**冻结**
（_pricing_reference 的 30 天窗口依赖 now），否则 fixture 不可复现。
"""
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

client = TestClient(worker_main.app, raise_server_exceptions=False)

ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}
TENANT = "default"
PRODUCT_KEY = "field_fence"
FROZEN = datetime(2026, 10, 24, 21, 0, 0, tzinfo=timezone.utc)
QUERY = "product_key=" + PRODUCT_KEY + "&scope=own"

calls: list = []


def _record(sql: str, params) -> None:
    calls.append((re.sub(r"\s+", " ", sql).strip(), list(params)))


class _FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):  # noqa: D102 - 只冻结 now()
        return FROZEN if tz is None else FROZEN.astimezone(tz)


def _product():
    quote_api._require_engine()
    return quote_api.get_product(PRODUCT_KEY)


def _cost_rows() -> list:
    """造 2 条定价数据（覆盖「窗口内/外」与「零/非零微秒」两种时间戳形态）。

    注意：现有注册表产品的 pricing_key 都至少有一个维度**只声明字段、不声明选项**
    （field_fence 的 de 是 numeric、chain_link 的 d/coating 都无选项）⇒
    _matrix_rows 恒为 []（这是产品定义现状，不是切片引入的）。所以 response.rows 是空，
    定价数据行只影响 scope=all 的 customer 分组；本 fixture 锁的是「口径没变」。
    """
    product = _product()
    fields = [d["field"] for d in (product.pricing_key or []) if d.get("field")]
    assert fields, "field_fence 必须有定价键字段"
    unit = product.cost_unit.split("/")[-1] if product.cost_unit else "kg"
    ts_in_window = datetime(2026, 10, 20, 10, 0, 0, 123456, tzinfo=timezone.utc)
    ts_old = datetime(2025, 1, 1, 8, 0, 0, tzinfo=timezone.utc)
    values_a = {field: ("2.0" if field == "de" else "zinc_40") for field in fields}
    values_b = {field: ("3.0" if field == "de" else "zinc_200") for field in fields}
    return [
        {
            "id": 101,
            "customer_id": quote_api._customer_of(ACTOR),
            "product_spec_json": {"values": values_a, "labels": {}},
            "spec_hash": PRODUCT_KEY + ":" + quote_api.pricing_key_of(product, values_a),
            "amount": 12.5,
            "unit": unit,
            "effective_from": ts_in_window,
            "source": "manual",
            "notes": "fixture 行",
            "created_at": ts_in_window,          # 非零微秒 + 30 天窗口内
        },
        {
            "id": 102,
            "customer_id": quote_api._customer_of(ACTOR),
            "product_spec_json": {"values": values_b, "labels": {}},
            "spec_hash": PRODUCT_KEY + ":" + quote_api.pricing_key_of(product, values_b),
            "amount": 9.0,
            "unit": unit,
            "effective_from": ts_old,            # 零微秒 + 30 天窗口外
            "source": "manual",
            "notes": None,
            "created_at": ts_old,
        },
    ]


async def fake_fetch(request, sql, *args, **kwargs):
    _record(sql, args)
    if "FROM customer_cost_items" in sql:
        return [dict(r) for r in _cost_rows()]
    raise AssertionError("unexpected db.fetch: " + sql)


def _dataset_items(items: list) -> list:
    out = []
    for row in items:
        out.append({
            "id": int(row["id"]),
            "customer_id": row["customer_id"],
            "product_spec_json": row["product_spec_json"],
            "spec_hash": row["spec_hash"],
            "amount": float(row["amount"]),
            "unit": row["unit"],
            "effective_from": row["effective_from"].isoformat(),
            "source": row["source"],
            "notes": row["notes"],
            "created_at": row["created_at"].isoformat(),
        })
    return out


def main() -> None:
    original_fetch = worker_main.db.fetch
    original_dt = worker_main.datetime
    worker_main.db.fetch = fake_fetch
    worker_main.datetime = _FrozenDateTime
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(
        ACTOR, email="buyer@qa.test", display_name="买家", status="active",
        console_access=False, plan="free")
    try:
        response = client.get("/api/v1/pricing-data?" + QUERY)
    finally:
        worker_main.db.fetch = original_fetch
        worker_main.datetime = original_dt
        worker_main.app.dependency_overrides.clear()

    assert response.status_code == 200, response.text
    body = response.json()

    product = _product()
    cost_items = _cost_rows()
    extended = quote_api.extend_product(
        product, quote_api._extensions_from_items(cost_items, product))
    dims = quote_api.describe_pricing_key(extended)
    rows = quote_api._matrix_rows(extended)

    ts_sql = lambda col: (
        "CASE WHEN to_char(" + col + " AT TIME ZONE 'UTC', 'US') = '000000'"
        " THEN to_char(" + col + " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS')"
        " ELSE to_char(" + col + " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"
        " END || '+00:00' AS " + col)

    fixture = {
        "_comment": (
            "P3 第七批金标：GET /api/v1/pricing-data（定价数据矩阵 / 历史）。"
            "old_sql = 旧路径实际执行的查询（同一份数据查两次：客户自建档位 + 成本表）；"
            "facade = 门面供数契约（一次 dataset、内核复用两份）；"
            "response = 旧路径真实响应。**生成期冻结了 datetime.now**（_pricing_reference "
            "的 30 天窗口依赖 now）⇒ 两侧测试也必须冻结到同一时刻，否则 avg_30d 会漂。"
            "时间戳同时覆盖零/非零微秒。"
        ),
        "endpoint": {"method": "GET", "path": "/api/v1/pricing-data",
                     "query_string": QUERY},
        "rpc": "/api/v1/internal/engine/quote/pricing-data",
        "frozen_now": FROZEN.isoformat(),
        "request": {"query": {"product_key": PRODUCT_KEY, "scope": "own"}},
        "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id",
                                        "is_tenant_admin")},
        "datasets": {"customer_cost_items": _dataset_items(cost_items)},
        "old_sql": [{"sql": sql, "params": params} for sql, params in calls],
        "facade": {
            "customer_cost_items": {
                "sql": (
                    "SELECT id, customer_id, product_spec_json, spec_hash, amount, unit, "
                    + ts_sql("effective_from") + ", source, notes, " + ts_sql("created_at")
                    + " FROM customer_cost_items"
                    " WHERE tenant_id=$1 AND left(spec_hash, length($2))=$2 AND status='active'"
                    " AND customer_id=$3 ORDER BY id DESC"),
                "params": [TENANT, PRODUCT_KEY + ":", quote_api._customer_of(ACTOR)],
            },
        },
        "response": body,
    }
    out = Path(__file__).with_name("engine-pricing-data.fixture.json")
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fixture written:", out.name, "bytes:", out.stat().st_size)
    print("old db calls:", len(calls), "| matrix rows:", len(rows),
          "| dims:", len(dims))
    print("configured cells:", sum(1 for r in body["rows"] if r["configured"]))


if __name__ == "__main__":
    main()
