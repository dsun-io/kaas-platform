# -*- coding: utf-8 -*-
r"""生成 P2 同族只读切片金标 fixture（verify / formulas / spec 三条）。

为什么要有这个脚本（而不是手写 fixture）
==========================================
fixture 里的 sql / sql_params / response 必须是**旧路径真实产物**，否则「改造前后一致」
无从谈起。本脚本用内核旧端点 + 桩 DB 跑一遍，把「实际发出的 SQL、绑定参数、响应 JSON」
原样落盘；两侧测试（backend/worker/tests/test_engine_rpc_quote_readonly.py 与
backend/ts-worker/tests/engine-quote-readonly.test.ts）都读**同一份** fixture。

覆盖的三条（与 docs/P2_COUPLING_ENGINE_2026-10-24.md §9 未完成清单 #1 同族）：
  POST /api/v1/export-quote/verify                          → engine-quote-verify.fixture.json
  GET  /api/v1/export-quote/products/{key}/formulas         → engine-quote-formulas.fixture.json
  GET  /api/v1/export-quote/products/{key}/spec             → engine-quote-spec.fixture.json
（同族第 4 条 explain 的 handler 逻辑在 ws_quote_ext.py，不在本批写入范围，见
  docs/P2_COUPLING_ENGINE_2026-10-24.md §9 与 task-10 结论。）

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑，借它的 uv 环境）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_quote_readonly_fixtures.py

纪律：
- 只有**故意**改响应形状/供数契约时才重跑，且 PR 里必须人工 review fixture diff（尤其 response 段）；
- 测试禁止自更新 fixture（防止「测试跟着错误实现走」）；
- 请求参数固定（verify 固定 quote_date；formulas 固定 with_columns=true），否则 response 漂移；
- 幂等：同一命令重跑两次 sha256 相同。
"""
from __future__ import annotations

import json
import platform
import re
import sys
from pathlib import Path

# 预热 stdlib platform / asyncpg：下面把 worker/src 插到 sys.path[0] 后，
# asyncpg 内部 import platform 会命中 worker 的 platform 包（无 uname）——
# pytest 环境天然已预热，独立脚本必须显式做（与 calculate 生成器同款，2026-10-24 实测）。
import asyncpg  # noqa: F401

platform.uname()

BACKEND = Path(__file__).resolve().parents[2]          # backend/
WORKER = BACKEND / "worker"
sys.path.insert(0, str(WORKER / "src"))
sys.path.insert(0, str(WORKER / "tests"))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.export_quote import get_product  # noqa: E402
from kaas_common.export_quote.tenant_products import spec_to_dict  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

# ── 身份（verify = 内部管理员；formulas/spec = 普通业务账号）──────────────────
OWNER = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}
ADMIN = {
    "id": 5, "email": "ops@qa.test", "display_name": "内部核算",
    "account_type": "internal", "role": "system_admin", "status": "active",
    "team_id": 2, "console_access": True, "plan": "pro", "is_tenant_admin": False,
}

VERIFY_REQUEST = {
    "product_key": "field_fence",
    "fx_rate": 7.1,
    "orders": [{"total": 1000, "unit": "m"}],
    "quote_date": "2026-10-24",
}
FORMULAS_QUERY = "with_columns=true"
EXPLAIN_REQUEST = {
    "product_key": "field_fence",
    "body": {
        "spec": {"coating": "热镀锌 40g/㎡", "wave": "无波款"},
        "total": 30000,
    },
}
FORMULAS_REQUEST = {
    "product_key": "field_fence",
    "query": {"with_columns": "true", "with_customer_options": None, "customer_id": None},
}
SPEC_REQUEST = {"product_key": "field_fence"}

# 供数行 = 旧 SQL 的结果（JSONB 已解码、BIGINT 已是 int；与门面 postgres.js 行为一致）
TENANT_ROWS = [{
    "spec": spec_to_dict(get_product("field_fence")),
    "override": None,
    "team_id": 2,
}]
COST_ROWS = [
    {   # 产品定义里已有的档位（zinc_40）
        "id": 101, "customer_id": "default",
        "product_spec_json": {"values": {"de": 2.0, "coating_code": "zinc_40"},
                              "labels": {"de": "2.0", "coating_code": "热镀锌 40g/㎡"}},
        "spec_hash": "field_fence:de=2|coating_code=zinc_40",
        "amount": 12.5, "unit": "CNY/kg",
        "effective_from": None, "source": "seed", "notes": None, "created_at": None,
    },
    {   # 客户自建档位（zinc_60）：formulas/spec 走客户自定义档位合并分支
        "id": 102, "customer_id": "default",
        "product_spec_json": {"values": {"de": 2.0, "coating_code": "zinc_60"},
                              "labels": {"de": "2.0", "coating_code": "镀锌60g/㎡"}},
        "spec_hash": "field_fence:de=2|coating_code=zinc_60",
        "amount": 13.75, "unit": "CNY/kg",
        "effective_from": None, "source": "manual", "notes": None, "created_at": None,
    },
]

captured: list[tuple[str, list]] = []


async def fake_fetch(request, sql, *args, table=None):
    captured.append((re.sub(r"\s+", " ", sql).strip(), list(args)))
    if "FROM tenant_products" in sql:
        return [dict(r) for r in TENANT_ROWS]
    if "FROM customer_cost_items" in sql:
        return [dict(r) for r in COST_ROWS]
    raise AssertionError("unexpected SQL: " + sql)


original_fetch = worker_main.db.fetch


def run_old(actor: dict, method: str, path: str, json_body=None,
            expected_sql: tuple = ("tenant_products", "customer_cost_items")):
    """用旧路径真实跑一遍；返回 (response_json, sql, sql_params)。

    expected_sql = 该端点旧路径**实际会执行**的 dataset 集合（多/少都是实现漂移）。
    """
    captured.clear()
    worker_main.db.fetch = fake_fetch
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(actor)
    try:
        resp = client.request(method, path, json=json_body)
    finally:
        worker_main.db.fetch = original_fetch
        worker_main.app.dependency_overrides.clear()
    assert resp.status_code == 200, (path, resp.status_code, resp.text)
    sqls: dict[str, str] = {}
    params: dict[str, list] = {}
    for sql, args in captured:
        if "FROM tenant_products" in sql:
            sqls["tenant_products"] = sql
            params["tenant_products"] = args
        elif "FROM customer_cost_items" in sql:
            sqls["customer_cost_items"] = sql
            params["customer_cost_items"] = args
    assert set(sqls) == set(expected_sql), (path, sqls)
    assert len(captured) == len(expected_sql) or path.endswith("/verify"), captured
    return resp.json(), sqls, params


def fixture_actor(actor: dict) -> dict:
    return {k: actor[k] for k in ("id", "account_type", "role", "team_id", "is_tenant_admin")}


def write_fixture(name: str, *, comment: str, endpoint: dict, rpc: str, request: dict,
                  actor: dict, response: dict, sqls: dict, params: dict,
                  datasets: dict) -> None:
    fixture = {
        "_comment": comment,
        "endpoint": endpoint,
        "rpc": rpc,
        "request": request,
        "actor": fixture_actor(actor),
        "datasets": datasets,
        "sql": sqls,
        "sql_params": params,
        "response": response,
    }
    out = Path(__file__).with_name(name)
    out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("fixture written:", out.name, "bytes:", out.stat().st_size,
          "| response keys:", list(response))


def main() -> None:
    # ① verify（管理员三遍核验）
    resp, sqls, params = run_old(ADMIN, "POST", "/api/v1/export-quote/verify",
                                 json_body=VERIFY_REQUEST)
    write_fixture(
        "engine-quote-verify.fixture.json",
        comment=("P2 同族只读切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6.6/§8.3/§9#1）："
                 "POST /export-quote/verify。由同目录 gen_engine_quote_readonly_fixtures.py "
                 "用内核旧路径（自取数）生成：response = 旧路径对固定 quote_date 请求的真实响应体；"
                 "sql/sql_params = 旧路径实际执行的 SQL 与绑定参数。"
                 "两侧测试都读本文件：Python 断言旧路径==新路径==response 且 SQL==sql；"
                 "TS 断言门面发出的 SQL==sql、发给内核的 datasets==datasets、回放==response。"
                 "actor 必须是内部管理员（旧端点 _require_internal_admin_dep）。"),
        endpoint={"method": "POST", "path": "/api/v1/export-quote/verify", "query_string": ""},
        rpc="/api/v1/internal/engine/quote/verify",
        request=VERIFY_REQUEST, actor=ADMIN, response=resp, sqls=sqls, params=params,
        datasets={"tenant_products": TENANT_ROWS, "customer_cost_items": COST_ROWS},
    )
    # 旧路径 verify 与 calculate 同款：同一份定价数据查两次（自建档位 + 成本表）
    assert len(captured) == 3, captured

    # ② formulas（计算说明书；with_columns=true、并入客户自定义档位）
    resp, sqls, params = run_old(
        OWNER, "GET", "/api/v1/export-quote/products/field_fence/formulas?" + FORMULAS_QUERY)
    write_fixture(
        "engine-quote-formulas.fixture.json",
        comment=("P2 同族只读切片金标（§6.6/§8.3/§9#1）：GET /export-quote/products/{key}/formulas"
                 "（?with_columns=true，with_customer_options 默认 true ⇒ 并入客户自建档位）。"
                 "由 gen_engine_quote_readonly_fixtures.py 用旧路径真实生成；"
                 "request 是 RPC 信封里的 request 段（GET 没有请求体：product_key + 原始 query 字符串）。"),
        endpoint={"method": "GET",
                  "path": "/api/v1/export-quote/products/field_fence/formulas",
                  "query_string": FORMULAS_QUERY},
        rpc="/api/v1/internal/engine/quote/formulas",
        request=FORMULAS_REQUEST, actor=OWNER, response=resp, sqls=sqls, params=params,
        datasets={"tenant_products": TENANT_ROWS, "customer_cost_items": COST_ROWS},
    )

    # ③ spec（产品原始定义；并入客户自定义档位后的有效定义）
    resp, sqls, params = run_old(
        OWNER, "GET", "/api/v1/export-quote/products/field_fence/spec")
    write_fixture(
        "engine-quote-spec.fixture.json",
        comment=("P2 同族只读切片金标（§6.6/§8.3/§9#1）：GET /export-quote/products/{key}/spec。"
                 "由 gen_engine_quote_readonly_fixtures.py 用旧路径真实生成："
                 "response = 有效产品定义（_effective_product = tenant_products 行 + 客户自建档位）。"),
        endpoint={"method": "GET", "path": "/api/v1/export-quote/products/field_fence/spec",
                  "query_string": ""},
        rpc="/api/v1/internal/engine/quote/spec",
        request=SPEC_REQUEST, actor=OWNER, response=resp, sqls=sqls, params=params,
        datasets={"tenant_products": TENANT_ROWS, "customer_cost_items": COST_ROWS},
    )

    # ④ explain（逐步代入；旧路径**只**读 tenant_products —— 不查定价数据）
    resp, sqls, params = run_old(
        OWNER, "POST", "/api/v1/export-quote/products/field_fence/explain",
        json_body=EXPLAIN_REQUEST["body"], expected_sql=("tenant_products",))
    write_fixture(
        "engine-quote-explain.fixture.json",
        comment=("P2 同族只读切片金标（§6.6/§8.3/§9#1）："
                 "POST /export-quote/products/{key}/explain（逐步代入计算说明书）。"
                 "由 gen_engine_quote_readonly_fixtures.py 用旧路径真实生成；"
                 "request = {product_key, body}（product_key 在路径上，body 是该端点原始请求体）；"
                 "旧路径只读 tenant_products ⇒ datasets.customer_cost_items 为空数组。"),
        endpoint={"method": "POST",
                  "path": "/api/v1/export-quote/products/field_fence/explain",
                  "query_string": ""},
        rpc="/api/v1/internal/engine/quote/explain",
        request=EXPLAIN_REQUEST, actor=OWNER, response=resp, sqls=sqls, params=params,
        datasets={"tenant_products": TENANT_ROWS, "customer_cost_items": []},
    )


if __name__ == "__main__":
    main()
