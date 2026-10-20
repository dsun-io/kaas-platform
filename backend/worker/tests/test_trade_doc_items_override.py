"""A5-W2：draft 单 `custom.items_override` 受控通道（内核 + PATCH + facts + 渲染）—— 无数据库。

契约（前端 `lib/trade-doc/item-batch.ts` / MSW 已按此实现）：
- 仅 draft；非 draft 422 `ITEMS_OVERRIDE_DRAFT_ONLY`；
- 禁金额键（422 `ITEMS_OVERRIDE_AMOUNT_FORBIDDEN`）；index 必填/不越界（422 `ITEMS_OVERRIDE_INDEX`）；
  qty>0 / unit_price≥0；空数组=清除覆盖；
- 渲染：在 sources items 的**副本**上覆盖并重算 line_amount（不改 sources）；
- facts：被覆盖行 `source=manual` / `trust=unverified` / `evidence_ref=custom.items_override[index=N]`，
  未覆盖行保持原 trust；`_baseline_facts`（清空 custom）不受影响；
- 审计：`append_audit` 的 custom diff 自动记录 items_override 的 before/after。
"""
from __future__ import annotations

import json
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

from kaas_common.trade_doc.facts import (  # noqa: E402
    SOURCE_MANUAL,
    TRUST_UNVERIFIED,
    extract_facts,
)
from kaas_common.trade_doc.payload_shared import (  # noqa: E402
    apply_items_override,
    build_render_data,
    items_override_of,
    validate_items_override,
)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin", "team_id": None}
_TS = datetime(2026, 10, 20, tzinfo=timezone.utc)

SOURCE_ITEMS = [
    {"product_name": "Chain Link Fence", "qty": 100, "unit_price": 12.5,
     "line_amount": 1250.0, "qty_unit": "ROLLS", "spec_snapshot": {}},
    {"product_name": "Barbed Wire", "qty": 20, "unit_price": 8.0,
     "line_amount": 160.0, "qty_unit": "ROLLS", "spec_snapshot": {}},
]


def _payload(override=None, status="draft") -> dict:
    payload = {
        "sources": {"quote": {"quote_no": "Q-1", "items": [dict(i) for i in SOURCE_ITEMS]}},
        "custom": {},
    }
    if override is not None:
        payload["custom"]["items_override"] = override
    return payload


# ── 内核：校验 ──────────────────────────────────────────────────────────────

def test_validate_items_override_accepts_contract_shape():
    ok = [
        {"index": 0, "qty": 80, "unit_price": 13.0, "unit": "ROLLS",
         "spec": "2m x 25m", "origin": "China"},
        {"index": 1},
    ]
    assert validate_items_override(ok, item_count=2) is None


@pytest.mark.parametrize(("override", "expected_code"), [
    ([{"index": 0, "line_amount": 1}], "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN"),
    ([{"index": 0, "amount": 1}], "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN"),
    ([{"qty": 10}], "ITEMS_OVERRIDE_INDEX"),
    ([{"index": -1}], "ITEMS_OVERRIDE_INDEX"),
    ([{"index": 1.5}], "ITEMS_OVERRIDE_INDEX"),
    ([{"index": 2}], "ITEMS_OVERRIDE_INDEX"),           # 越界（共 2 行）
    ([{"index": 0, "qty": 0}], "ITEMS_OVERRIDE_QTY"),
    ([{"index": 0, "qty": "x"}], "ITEMS_OVERRIDE_QTY"),
    ([{"index": 0, "unit_price": -1}], "ITEMS_OVERRIDE_PRICE"),
    ([{"index": 0, "unit": 3}], "ITEMS_OVERRIDE_VALUE"),
], ids=["line_amount", "amount", "missing-index", "negative-index", "float-index",
        "out-of-range", "zero-qty", "str-qty", "negative-price", "bad-unit"])
def test_validate_items_override_rejects(override, expected_code):
    problem = validate_items_override(override, item_count=2)
    assert problem is not None and problem["code"] == expected_code


def test_items_override_of_non_list_is_empty():
    assert items_override_of({"items_override": "x"}) == []
    assert items_override_of({}) == []


# ── 内核：应用覆盖 ─────────────────────────────────────────────────────────

def test_apply_items_override_maps_fields_and_derives_amount_without_mutating():
    rows = [dict(i) for i in SOURCE_ITEMS]
    out = apply_items_override(rows, [{
        "index": 0, "qty": 80, "unit_price": 13.25,
        "unit": "PCS", "spec": "2m x 25m", "origin": "China",
    }])
    assert out[0]["qty"] == 80 and out[0]["unit_price"] == 13.25
    assert out[0]["qty_unit"] == "PCS"
    assert out[0]["specification"] == "2m x 25m"
    assert out[0]["country_of_origin"] == "China"
    assert out[0]["line_amount"] == 1060.0        # 80 × 13.25，由覆盖值重算
    assert out[1] == rows[1]
    assert rows[0]["qty"] == 100                  # 入参不被修改


def test_build_render_data_applies_override_on_copy_and_hides_key():
    sources = {"quote": {"currency": "USD", "items": [dict(i) for i in SOURCE_ITEMS]}}
    data = build_render_data(
        doc_type="pi", doc_no="PI-1", doc_status="draft", currency="USD",
        total_amount=1000, sources=sources,
        custom={"items_override": [{"index": 1, "qty": 10, "unit_price": 9}]},
    )
    assert data["items"][1]["qty"] == 10
    assert data["items"][1]["line_amount"] == 90.0
    assert data["items"][0]["qty"] == 100
    assert "items_override" not in data
    # sources 未被动过
    assert sources["quote"]["items"][1]["qty"] == 20


def test_build_render_data_without_override_unchanged():
    sources = {"quote": {"items": [dict(i) for i in SOURCE_ITEMS]}}
    data = build_render_data(
        doc_type="pi", doc_no="PI-1", doc_status="draft", currency="USD",
        total_amount=1000, sources=sources, custom={},
    )
    assert data["items"][1]["qty"] == 20
    assert data["items"][1]["line_amount"] == 160.0


# ── 内核：facts ─────────────────────────────────────────────────────────────

def _facts_by_key(payload: dict) -> dict[str, object]:
    return {fact.key: fact for fact in extract_facts(payload, "pi")}


def test_facts_overridden_row_is_manual_unverified_with_evidence():
    facts = _facts_by_key(_payload([
        {"index": 0, "qty": 80, "unit_price": 13.25},
    ]))
    for key in ("qty[1]", "unit_price[1]", "line_amount[1]"):
        fact = facts[key]
        assert fact.source == SOURCE_MANUAL, key
        assert fact.trust == TRUST_UNVERIFIED, key
        assert fact.evidence_ref == "custom.items_override[index=0]", key
    assert facts["qty[1]"].value == "80"
    assert facts["line_amount[1]"].value == "1060"     # 80 × 13.25
    # 未覆盖行保持来源快照的 trust/evidence
    assert facts["qty[2]"].trust == "confirmed"
    assert facts["qty[2]"].value == "20"


def test_facts_baseline_clearing_custom_ignores_override():
    payload = _payload([{"index": 0, "qty": 80, "unit_price": 13.25}])
    baseline_payload = json.loads(json.dumps(payload))
    baseline_payload["custom"] = {}
    baseline = _facts_by_key(baseline_payload)
    assert baseline["qty[1]"].value == "100"
    assert baseline["qty[1]"].trust == "confirmed"
    assert baseline["line_amount[1]"].value == "1250"


# ── Worker PATCH / render-data / facts 端点 ─────────────────────────────────

DOC_ID = 11


class _FakeDb:
    def __init__(self, payload: dict, status: str = "draft") -> None:
        self.doc = {
            "id": DOC_ID, "tenant_id": "default", "doc_no": "PI-2026-0011",
            "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": None,
            "status": status, "currency": "USD", "total_amount": 1410,
            "issued_at": None, "issued_by": None, "raw_payload": payload,
            "created_at": _TS, "updated_at": _TS,
            "owner_id": "1", "owner_scope": "private", "team_id": 1,
        }
        self.updates: list[tuple[str, tuple]] = []
        self.calls: list[tuple[str, str, tuple]] = []

    @staticmethod
    def _split(args: tuple) -> tuple[str, tuple]:
        if args and isinstance(args[0], str):
            return args[0], args[1:]
        return args[1], args[2:]

    async def fetchrow(self, *args, table=None):
        sql, params = self._split(args)
        self.calls.append(("fetchrow", sql, params))
        if "FROM trade_docs WHERE tenant_id=$1 AND id=$2" in sql:
            return dict(self.doc)
        return None

    async def fetch(self, *args, table=None):
        self.calls.append(("fetch", *self._split(args)))
        return []

    async def fetchval(self, *args, table=None):
        self.calls.append(("fetchval", *self._split(args)))
        return None

    async def execute(self, *args):
        sql, params = self._split(args)
        self.calls.append(("execute", sql, params))
        self.updates.append((sql, params))
        if "UPDATE trade_docs SET" in sql:
            self.doc["status"] = params[2]
            if len(params) > 3 and params[3] is not None:
                self.doc["raw_payload"] = json.loads(params[3])
        return "OK"


@contextmanager
def _patched(payload: dict, *, status: str = "draft"):
    fake = _FakeDb(payload, status=status)

    @asynccontextmanager
    async def fake_acquire(request):
        yield fake

    old_db, old_acquire = worker_main.db, worker_main._acquire
    worker_main.db = fake
    worker_main._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: ADMIN
    try:
        yield fake
    finally:
        worker_main.db = old_db
        worker_main._acquire = old_acquire
        worker_main.app.dependency_overrides.clear()


def _body(override):
    payload = _payload()
    payload["custom"]["items_override"] = override
    return {"raw_payload": payload}


def _patch(body: dict):
    return client.patch(f"/api/v1/trade-docs/{DOC_ID}", json=body)


def test_patch_draft_accepts_override_and_audits_it():
    with _patched(_payload()) as fake:
        resp = _patch(_body([{"index": 0, "qty": 80, "unit_price": 13.25}]))
    assert resp.status_code == 200, resp.text
    stored = fake.doc["raw_payload"]
    assert stored["custom"]["items_override"] == [
        {"index": 0, "qty": 80, "unit_price": 13.25}]
    audit = stored["_audit"]
    assert audit and audit[-1]["changed"]["items_override"]["from"] is None
    assert audit[-1]["changed"]["items_override"]["to"] == "<list 1>"
    assert "items" in fake.doc["raw_payload"]["sources"]["quote"]


def test_patch_empty_override_clears_it():
    with _patched(_payload([{"index": 0, "qty": 80}])) as fake:
        resp = _patch(_body([]))
    assert resp.status_code == 200, resp.text
    assert "items_override" not in fake.doc["raw_payload"]["custom"]


def test_patch_non_draft_override_422_draft_only():
    with _patched(_payload(), status="issued") as fake:
        resp = _patch(_body([{"index": 0, "qty": 80}]))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "ITEMS_OVERRIDE_DRAFT_ONLY"
    assert fake.updates == []


@pytest.mark.parametrize(("override", "code"), [
    ([{"index": 5, "qty": 80}], "ITEMS_OVERRIDE_INDEX"),
    ([{"index": 0, "line_amount": 1}], "ITEMS_OVERRIDE_AMOUNT_FORBIDDEN"),
    ([{"index": 0, "qty": 0}], "ITEMS_OVERRIDE_QTY"),
    ([{"index": 0, "unit_price": -1}], "ITEMS_OVERRIDE_PRICE"),
], ids=["out-of-range", "amount", "zero-qty", "negative-price"])
def test_patch_invalid_override_422_without_write(override, code):
    with _patched(_payload()) as fake:
        resp = _patch(_body(override))
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == code
    assert fake.updates == []


def test_patch_without_raw_payload_unaffected():
    with _patched(_payload()) as fake:
        resp = _patch({"currency": "EUR"})
    assert resp.status_code == 200, resp.text
    assert fake.doc["raw_payload"]["custom"] == {}


def test_render_data_endpoint_applies_override():
    payload = _payload([{"index": 0, "qty": 80, "unit_price": 13.25}])
    with _patched(payload):
        resp = client.get(f"/api/v1/trade-docs/{DOC_ID}/render-data")
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert items[0]["qty"] == 80
    assert items[0]["line_amount"] == 1060.0
    assert items[1]["qty"] == 20


def test_facts_endpoint_reports_override_unverified():
    payload = _payload([{"index": 0, "qty": 80, "unit_price": 13.25}])
    with _patched(payload):
        resp = client.get(f"/api/v1/trade-docs/{DOC_ID}/facts")
    assert resp.status_code == 200, resp.text
    facts = {item["key"]: item for item in resp.json()["items"]}
    assert facts["qty[1]"]["source"] == "manual"
    assert facts["qty[1]"]["trust"] == "unverified"
    assert facts["qty[1]"]["evidence_ref"] == "custom.items_override[index=0]"
    assert facts["qty[2]"]["trust"] == "confirmed"
