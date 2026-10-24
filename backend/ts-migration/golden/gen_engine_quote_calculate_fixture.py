# -*- coding: utf-8 -*-
r"""生成 P2 首个切片金标 fixture（Python 旧路径自取数 → 同一输入的真实响应）。

为什么要有这个脚本（而不是手写 fixture）
==========================================
fixture 里的 sql / sql_params / response 必须是**旧路径真实产物**，否则「改造前后一致」无从谈起。
脚本用内核旧端点 + 桩 DB 跑一遍，把「实际发出的 SQL、绑定参数、响应 JSON」原样落盘；
两侧测试（backend/worker/tests/test_engine_rpc_quote_calculate.py 与
backend/ts-worker/tests/engine-quote-calculate.test.ts）都读**同一份** fixture。

用法（Windows / PowerShell 5.1；必须从 backend/worker 目录跑，借它的 uv 环境）：
  $env:UV_CACHE_DIR='D:\tools\uv-cache'; $env:PYTHONUTF8='1'
  cd backend/worker
  uv run --frozen --with pytest --with httpx2 python ../ts-migration/golden/gen_engine_quote_calculate_fixture.py

纪律：
- 只有**故意**改响应形状/供数契约时才重跑，且 PR 里必须人工 review fixture diff（尤其 response 段）；
- 测试禁止自更新 fixture（防止「测试跟着错误实现走」）；
- 请求体固定 quote_date（否则 response 里的 quote_date/valid_until 随机漂移，fixture 隔天就红）。
"""
from __future__ import annotations

import json
import platform
import re
import sys
from pathlib import Path

# 预热 stdlib platform / asyncpg：下面把 worker/src 插到 sys.path[0] 后，
# asyncpg 内部 import platform 会命中 worker 的 platform 包（无 uname）——
# pytest 环境天然已预热，独立脚本必须显式做（2026-10-24 实测）。
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

ACTOR = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False, "plan": "free", "is_tenant_admin": False,
}

REQUEST = {
    "product_key": "field_fence",
    "fx_rate": 7.1,
    "orders": [{"total": 1000, "unit": "m"}],
    "quote_date": "2026-10-24",
}

# 供数行 = 旧 SQL 的结果（JSONB 已解码、BIGINT 已是 int；与门面 postgres.js 行为一致）
TENANT_ROWS = [{
    "spec": spec_to_dict(get_product("field_fence")),
    "override": None,
    "team_id": 2,
}]
COST_ROWS = [
    {  # 产品定义里已有的档位（zinc_40）
        "id": 101, "customer_id": "default",
        "product_spec_json": {"values": {"de": 2.0, "coating_code": "zinc_40"},
                              "labels": {"de": "2.0", "coating_code": "热镀锌 40g/㎡"}},
        "spec_hash": "field_fence:de=2|coating_code=zinc_40",
        "amount": 12.5, "unit": "CNY/kg",
        "effective_from": None, "source": "seed", "notes": None, "created_at": None,
    },
    {  # 客户自建档位（zinc_60）：走 _extensions_from_items 的扩展分支
        "id": 102, "customer_id": "default",
        "product_spec_json": {"values": {"de": 2.0, "coating_code": "zinc_60"},
                              "labels": {"de": "2.0", "coating_code": "镀锌60g/㎡"}},
        "spec_hash": "field_fence:de=2|coating_code=zinc_60",
        "amount": 13.75, "unit": "CNY/kg",
        "effective_from": None, "source": "manual", "notes": None, "created_at": None,
    },
]

captured: list[tuple[str, list, str | None]] = []


async def fake_fetch(request, sql, *args, table=None):
    captured.append((re.sub(r"\s+", " ", sql).strip(), list(args), table))
    if "FROM tenant_products" in sql:
        return [dict(r) for r in TENANT_ROWS]
    if "FROM customer_cost_items" in sql:
        return [dict(r) for r in COST_ROWS]
    raise AssertionError("unexpected SQL: " + sql)


original_fetch = worker_main.db.fetch
worker_main.db.fetch = fake_fetch
worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: dict(ACTOR)
try:
    resp = client.post("/api/v1/export-quote/calculate", json=REQUEST)
finally:
    worker_main.db.fetch = original_fetch
    worker_main.app.dependency_overrides.clear()

assert resp.status_code == 200, resp.text
body = resp.json()

sqls: dict[str, str] = {}
params: dict[str, list] = {}
for sql, args, _table in captured:
    if "FROM tenant_products" in sql:
        sqls["tenant_products"] = sql
        params["tenant_products"] = args
    elif "FROM customer_cost_items" in sql:
        sqls["customer_cost_items"] = sql
        params["customer_cost_items"] = args
assert set(sqls) == {"tenant_products", "customer_cost_items"}, sqls
# 旧路径对同一条定价数据查询两次（自建档位 + 成本表）；新路径合并为一次供数
assert len([c for c in captured if "customer_cost_items" in c[0]]) == 2, captured

fixture = {
    "_comment": (
        "P2 首个端到端切片金标（docs/P2_COUPLING_ENGINE_2026-10-24.md §6.6/§8.3）。"
        "由同目录 gen_engine_quote_calculate_fixture.py 用内核旧路径（自取数）生成："
        "response = 该请求的真实响应体（quote_date 固定，消除 today 漂移）；"
        "sql/sql_params = 旧路径实际执行的 SQL 与绑定参数。"
        "两侧测试都读本文件：Python 断言旧路径==新路径==response 且 SQL==sql；"
        "TS 断言门面发出的 SQL==sql、发给内核的 datasets==datasets、回放==response。"
    ),
    "endpoint": {"method": "POST", "path": "/api/v1/export-quote/calculate"},
    "rpc": "/api/v1/internal/engine/quote/calculate",
    "request": REQUEST,
    "actor": {k: ACTOR[k] for k in ("id", "account_type", "role", "team_id", "is_tenant_admin")},
    "datasets": {"tenant_products": TENANT_ROWS, "customer_cost_items": COST_ROWS},
    "sql": sqls,
    "sql_params": params,
    "response": body,
}

out = Path(__file__).with_name("engine-quote-calculate.fixture.json")
out.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("fixture written:", out, "bytes:", out.stat().st_size)
print("response keys:", list(body), "| customer rows:", len(body["customer"]["rows"]))
