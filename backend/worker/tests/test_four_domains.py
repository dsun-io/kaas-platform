"""客户/订单/报价/单证 四域补口的 Worker 行为测试（无数据库、无网络）。

与 `test_worker_routes.py`（只验路由面）互补：这里验**逻辑**——
枚举字典与共享内核同源、出运台账的归属隔离 / 状态机 / 枚举校验。

做法同 `test_ws_products_seals.py`：把 `db`（platform/db.py）换成假实现、
把 `_get_current_user` 换成依赖覆盖，不碰 Hyperdrive 也能把 handler 跑到返回。
"""
import re
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_crm_ext  # noqa: E402
import ws_docs_ext  # noqa: E402
import ws_enums  # noqa: E402,F401
import ws_quote_ext  # noqa: E402
import ws_shipments  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from kaas_common.domain.enums import ENUMS  # noqa: E402
from kaas_common.workstation.state_machines import SHIPMENT_NEXT  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}
MEMBER = {"id": 9, "account_type": "customer", "role": "user"}


# ── 假 db ───────────────────────────────────────────────────────────────────

class _FakeDb:
    """冒充 platform/db.py：按调用顺序吐预设结果，并记录 SQL 与参数。"""

    def __init__(self, *, fetchval=None, fetchrow=None, fetch=None):
        self._fetchval = list(fetchval or [])
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append(("fetchval", sql, args))
        return self._fetchval.pop(0) if self._fetchval else 0

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append(("fetchrow", sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append(("fetch", sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, request, sql, *args):
        self.calls.append(("execute", sql, args))
        self.executed.append((sql, args))
        return "UPDATE 1"

    def sql_calls(self) -> str:
        return "\n".join(sql for _, sql, _ in self.calls)


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """冒充 `_main._acquire()` 吐出的连接（多语句共用一条连接的事务路径）。"""

    def __init__(self, row=None, fetchrow=None, fetch=None, fetchval=None):
        self._fetchrow = list(fetchrow) if fetchrow is not None else (
            [] if row is None else [row])
        self._fetch = list(fetch or [])
        self._fetchval = list(fetchval) if isinstance(fetchval, list) else (
            [] if fetchval is None else [fetchval])
        self.calls: list[tuple[str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, sql, *args):
        self.calls.append((sql, args))
        self.executed.append((sql, args))
        return "INSERT 0 1"

    def transaction(self):
        return _FakeTxn()

    def sql(self) -> str:
        return "\n".join(s for s, _ in self.calls)


# 这些模块都在模块级绑定了 `db = _main.db`，测试要一起替换。
# 必须用**本模块 import 到的对象**，不能用 sys.modules 现查：每个测试文件都会
# load_main() 重载一次，sys.modules 里可能是别的文件创建的那一份（app 与模块对不上）。
_DB_MODULES = (ws_shipments, ws_docs_ext, ws_crm_ext)


@contextmanager
def _patched(db, user=ADMIN, conn=None, doc_no="SHP-202610-0001"):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = {}
    old_acquires = {}
    for module in _DB_MODULES:
        old[module] = module.db
        module.db = db
        # 有的模块在**模块级**捕获了 `_acquire = _main._acquire`（ws_crm_ext），
        # 只改 worker_main 不够 —— 它拿的还是旧函数对象，会去连真 Hyperdrive。
        if hasattr(module, "_acquire"):
            old_acquires[module] = module._acquire
            module._acquire = fake_acquire
    old_acquire = worker_main._acquire
    old_doc_no = worker_main._next_doc_no
    old_main_db = worker_main.db          # main.py 里的既有端点直接用 main.db
    worker_main.db = db
    worker_main._acquire = fake_acquire
    worker_main._next_doc_no = lambda request, doc_type: _async(doc_no)
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        for module, value in old.items():
            module.db = value
        for module, value in old_acquires.items():
            module._acquire = value
        worker_main.db = old_main_db
        worker_main._acquire = old_acquire
        worker_main._next_doc_no = old_doc_no
        worker_main.app.dependency_overrides.clear()


async def _async(value):
    return value


def _shipment_row(**over):
    row = {
        "id": 5, "tenant_id": "default", "shipment_no": "SHP-202610-0001",
        "order_id": None, "customer_id": None, "customer_name": "ACME",
        "consignee": None, "notify_party": None, "cargo_desc": "牛栏网",
        "cargo_qty": 350, "cargo_qty_unit": "roll", "cargo_weight_kg": None,
        "cargo_volume_cbm": None, "pol": "NINGBO", "pod": "HAMBURG",
        "pol_name": None, "pod_name": None, "vessel": None, "voyage": None,
        "container_no": None, "so_no": None, "booking_no": None, "bl_no": None,
        "bl_type": None, "etd": None, "eta": None, "atd": None, "ata": None,
        "status": "booking", "freight_remark": None,
        "created_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
        "owner_id": "9", "owner_scope": "private",
    }
    row.update(over)
    return row


# ── 单证枚举字典：必须与共享内核同源 ────────────────────────────────────────

def test_enums_matches_shared_kernel():
    """GET /enums 的每一项都必须等于共享内核的常量表（不许 worker 另写一份）。"""
    resp = client.get("/api/v1/enums")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == set(ENUMS)
    for key, values in ENUMS.items():
        assert body[key] == list(values), f"{key} 与共享内核不一致"


def test_enums_exposes_doc_type_used_by_trade_docs_page():
    """单证页靠 doc_type 渲染下拉（use-trade-docs.ts:229）—— 少一个就是线上选项缺失。"""
    body = client.get("/api/v1/enums").json()
    assert "pi" in body["doc_type"]
    assert "ci" in body["doc_type"]
    assert body["shipment_status"] == ["booking", "in_transit", "arrived", "customs", "delivered"]


# ── 出运台账 ────────────────────────────────────────────────────────────────

def test_shipments_list_admin_not_scoped_but_paginated():
    db = _FakeDb(fetchval=[1], fetch=[[_shipment_row()]])
    with _patched(db):
        resp = client.get("/api/v1/shipments")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1 and body["page"] == 1 and body["page_size"] == 20
    assert body["items"][0]["shipment_no"] == "SHP-202610-0001"
    assert body["items"][0]["cargo_qty"] == 350.0
    sql = db.sql_calls()
    assert "tenant_id = $1" in sql and "ORDER BY created_at DESC" in sql
    assert "owner_id = " not in sql          # 管理员不加归属过滤


def test_shipments_list_member_is_owner_scoped():
    db = _FakeDb(fetchval=[0], fetch=[[],])
    with _patched(db, user=MEMBER):
        resp = client.get("/api/v1/shipments")
    assert resp.status_code == 200
    sql = db.sql_calls()
    assert "(owner_id = $2 OR owner_scope = 'tenant')" in sql


def test_shipments_rejects_illegal_status_filter():
    """枚举校验用共享内核 → 非法值 422，且不查库。"""
    db = _FakeDb()
    with _patched(db):
        resp = client.get("/api/v1/shipments", params={"status": "flying"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"
    assert db.calls == []


def test_shipments_get_invisible_row_is_404():
    """别家 owner 的私有单不可见 → 404（不泄露存在性）。"""
    db = _FakeDb(fetchrow=[_shipment_row(owner_id="777", owner_scope="private")])
    with _patched(db, user=MEMBER):
        resp = client.get("/api/v1/shipments/5")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "SHIPMENT_NOT_FOUND"


def test_shipments_patch_illegal_transition_409():
    """booking 不能直接跳 delivered —— 状态机来自共享内核。"""
    db = _FakeDb(fetchrow=[_shipment_row(status="booking")])
    with _patched(db, user=ADMIN):
        resp = client.patch("/api/v1/shipments/5", json={"status": "delivered"})
    assert resp.status_code == 409
    detail = resp.json()["detail"]
    assert detail["code"] == "ILLEGAL_TRANSITION"
    assert detail["allowed"] == list(SHIPMENT_NEXT["booking"])


def test_shipments_patch_legal_transition_updates():
    db = _FakeDb(fetchrow=[_shipment_row(status="booking"),
                           _shipment_row(status="in_transit", vessel="MSC A")])
    with _patched(db, user=ADMIN):
        resp = client.patch("/api/v1/shipments/5",
                            json={"status": "in_transit", "vessel": "MSC A"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "in_transit"
    sql = db.sql_calls()
    assert "vessel = $3" in sql and "status = $4" in sql and "updated_at = now()" in sql


def test_shipments_patch_write_access_denied_for_other_owner():
    db = _FakeDb(fetchrow=[_shipment_row(owner_id="777", owner_scope="tenant")])
    with _patched(db, user=MEMBER):
        resp = client.patch("/api/v1/shipments/5", json={"vessel": "X"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "NOT_OWNER"


def test_shipments_create_snapshots_order_and_backfills_status():
    """带 order_id：客户名快照 + 行项汇总货物 + 建关联 + producing→shipped。"""
    order = {"id": 3, "tenant_id": "default", "customer_name": "ACME",
             "status": "producing", "owner_id": "1", "owner_scope": "private"}
    items = [{"product_name": "牛栏网", "qty": 200, "qty_unit": "roll"},
             {"product_name": "立柱", "qty": 150, "qty_unit": "pcs"}]
    db = _FakeDb(fetchrow=[order], fetch=[items])
    conn = _FakeConn(_shipment_row(order_id=3, customer_name="ACME",
                                   cargo_desc="牛栏网, 立柱", cargo_qty=350,
                                   owner_id="1"))
    with _patched(db, user=ADMIN, conn=conn):
        resp = client.post("/api/v1/shipments", json={"order_id": 3})
    assert resp.status_code == 201
    assert resp.json()["shipment_no"] == "SHP-202610-0001"
    executed = " ".join(sql for sql, _ in conn.executed)
    assert "INSERT INTO order_shipment_refs" in executed
    assert "UPDATE orders SET status='shipped'" in executed


def test_shipments_create_rejects_unknown_order():
    db = _FakeDb(fetchrow=[None])
    with _patched(db, user=ADMIN, conn=_FakeConn(None)):
        resp = client.post("/api/v1/shipments", json={"order_id": 999})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "ORDER_NOT_FOUND"


def test_shipments_create_rejects_illegal_enum():
    db = _FakeDb()
    with _patched(db, user=ADMIN):
        resp = client.post("/api/v1/shipments", json={"owner_scope": "world"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"

# ── 单证补充端点（ws_docs_ext）──────────────────────────────────────────────

def _doc_row(**over):
    row = {
        "id": 11, "tenant_id": "default", "doc_no": "PI-202610-0001", "doc_type": "pi",
        "order_id": None, "customer_id": 3, "status": "draft", "currency": "USD",
        "total_amount": None, "issued_at": None, "issued_by": None,
        "raw_payload": {"sources": {}, "custom": {"payment_terms": "30% T/T"}},
        "created_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
    }
    row.update(over)
    return row


def _order_snapshot_row():
    return {
        "id": 3, "order_no": "ORD-202610-0001", "customer_id": 3, "customer_name": "ACME",
        "status": "confirmed", "currency": "USD", "total_amount": 1200, "fx_rate": None,
        "incoterm": "FOB", "payment_terms": "T/T", "port_of_loading": "NINGBO",
        "port_of_destination": "HAMBURG", "shipping_marks": None,
        "country_of_origin": "CN",
    }


def test_trade_doc_confirm_requires_items():
    db = _FakeDb(fetchrow=[_doc_row()], fetch=[[]])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "CONFIRM_INVALID"
    assert any("明细" in i for i in detail["issues"])


def test_trade_doc_confirm_locks_draft():
    items = [{"product_name": "牛栏网", "qty": 1, "unit_price": 120, "line_amount": 120}]
    db = _FakeDb(fetchrow=[_doc_row(), _doc_row(status="issued", issued_by="1")],
                 fetch=[items])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 200
    assert resp.json()["status"] == "issued"


def test_trade_doc_confirm_rejects_already_issued():
    db = _FakeDb(fetchrow=[_doc_row(status="issued")], fetch=[[]])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "NOT_DRAFT"


def test_trade_doc_confirm_rejects_amount_mismatch():
    """合计层金额勾稽：单证合计 ≠ 行项目合计时不得确认（信用证不符点防线）。

    内核 validate_confirm 只校验到行级；合计层此前线上完全没有 ——
    生产因此能确认一张「合计与明细对不上」的单据。
    """
    items = [{"product_name": "牛栏网", "qty": 1, "unit_price": 120, "line_amount": 120}]
    db = _FakeDb(fetchrow=[_doc_row(total_amount=100)], fetch=[items])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "AMOUNT_MISMATCH"


def test_trade_doc_confirm_accepts_matching_total():
    """合计与行项目一致时照常确认 —— 补的校验不能误伤正常单据。"""
    items = [{"product_name": "牛栏网", "qty": 1, "unit_price": 120, "line_amount": 120}]
    db = _FakeDb(fetchrow=[_doc_row(total_amount=120),
                           _doc_row(status="issued", total_amount=120, issued_by="1")],
                 fetch=[items])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 200
    assert resp.json()["status"] == "issued"


def test_trade_doc_refresh_sources_requires_draft():
    db = _FakeDb(fetchrow=[_doc_row(status="issued")])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/refresh-sources")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "NOT_DRAFT"


def test_trade_doc_refresh_sources_without_upstream():
    db = _FakeDb(fetchrow=[_doc_row()])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/refresh-sources")
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "NO_UPSTREAM"


def test_trade_doc_refresh_sources_keeps_custom_and_backfills_total():
    order = _order_snapshot_row()
    items = [{"product_name": "牛栏网", "qty": 10, "qty_unit": "roll",
              "unit_price": 120, "line_amount": 1200, "spec_snapshot": None}]
    refreshed = _doc_row(order_id=3, total_amount=1200.0, raw_payload={
        "sources": {"order": order}, "custom": {"payment_terms": "30% T/T"}})
    # fetchrow 调用顺序：取单证 → 取订单快照 → UPDATE ... RETURNING
    db = _FakeDb(fetchrow=[_doc_row(order_id=3), order, refreshed], fetch=[items])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/refresh-sources")
    assert resp.status_code == 200
    body = resp.json()
    assert body["sources"] == ["order"]
    assert body["doc"]["total_amount"] == 1200.0
    # 手工改过的 custom 必须保留（优先级最高）
    assert body["doc"]["raw_payload"]["custom"]["payment_terms"] == "30% T/T"


def test_trade_doc_translate_empty_fields_short_circuits():
    db = _FakeDb(fetchrow=[_doc_row()])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/translate", json={"fields": {}})
    assert resp.status_code == 200
    assert resp.json()["path"] == "none"


def test_trade_doc_translate_degrades_to_template_and_logs_usage():
    db = _FakeDb(fetchrow=[_doc_row()])
    conn = _FakeConn(fetchrow=[{"enabled": False}])
    with _patched(db, conn=conn):
        resp = client.post("/api/v1/trade-docs/11/translate",
                           json={"fields": {"buyer": "上海某某"}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == "template"
    assert body["fields"] == {"buyer": "上海某某"}
    assert any("ai_usage" in sql for sql, _ in conn.executed)   # 每次调用必落账


# ── 客户 / 询盘补充端点（ws_crm_ext）───────────────────────────────────────

def _customer_row(**over):
    row = {"id": 3, "tenant_id": "default", "name": "ACME", "country": "US",
           "address": None, "default_port": None, "credit_level": None,
           "stage": "inquiry", "notes": None, "owner_id": "1", "owner_scope": "private",
           "is_deleted": False, "created_at": None, "updated_at": None}
    row.update(over)
    return row


def _inquiry_row(**over):
    row = {"id": 1, "tenant_id": "default", "customer_id": 3, "channel": "email",
           "category_id": None, "product_name_raw": "牛栏网", "quantity": 10,
           "quantity_unit": "roll", "application": None, "status": "open", "notes": None,
           "created_by": "1", "created_at": None, "updated_at": None, "owner_id": "1",
           "owner_scope": "private", "lead_id": None, "inquiry_seq": None,
           "spec_snapshot": None}
    row.update(over)
    return row


def test_customer_patch_maps_company_name_to_name_column():
    """`company_name` 在库里叫 `name`；映射错了就是「改名返回 200、刷新没变」。"""
    db = _FakeDb(fetchrow=[_customer_row(), _customer_row(name="ACME 2")])
    with _patched(db):
        resp = client.patch("/api/v1/customers/3", json={"company_name": "ACME 2"})
    assert resp.status_code == 200
    sql = db.sql_calls()
    assert "SET name = $1" in sql
    assert "company_name" not in sql


def test_customer_patch_rejects_bad_owner_scope():
    db = _FakeDb(fetchrow=[_customer_row()])
    with _patched(db):
        resp = client.patch("/api/v1/customers/3", json={"owner_scope": "world"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "INVALID_ENUM"


def test_inquiries_list_joins_company_name():
    db = _FakeDb(fetch=[[{**_inquiry_row(), "company_name": "ACME"}]])
    with _patched(db):
        resp = client.get("/api/v1/inquiries")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["items"][0]["company_name"] == "ACME"
    assert "JOIN customers" in db.sql_calls()


def test_inquiry_won_links_customer_stage_and_lead():
    inq = _inquiry_row(status="open", lead_id=77)
    conn = _FakeConn(fetchrow=[inq, {"id": 3, "stage": "inquiry"},
                               _inquiry_row(status="won", lead_id=77)])
    with _patched(_FakeDb(), conn=conn):
        resp = client.patch("/api/v1/inquiries/1", json={"status": "won"})
    assert resp.status_code == 200
    executed = " ".join(sql for sql, _ in conn.executed)
    assert "cust_stage_log" in executed
    assert "UPDATE customers SET stage" in executed
    assert "lead_candidates" in executed


def test_inquiry_illegal_transition_409():
    conn = _FakeConn(fetchrow=[_inquiry_row(status="won")])
    with _patched(_FakeDb(), conn=conn):
        resp = client.patch("/api/v1/inquiries/1", json={"status": "open"})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "ILLEGAL_TRANSITION"


# ── 报价补充端点（ws_quote_ext）────────────────────────────────────────────

def test_rebate_rate_lookup_always_answers_200():
    """查不到也是正常响应（202 + found:false），不抛 4xx —— 业务要的是「知道有没有」。"""
    with _patched(_FakeDb()):
        resp = client.post("/api/v1/export-quote/rebate-rate/lookup",
                           json={"hs_code": "7314410000"})
    assert resp.status_code == 200
    assert "found" in resp.json()


def test_rebate_rate_lookup_bad_rate_set_400():
    with _patched(_FakeDb()):
        resp = client.post("/api/v1/export-quote/rebate-rate/lookup",
                           json={"hs_code": "7314410000", "rate_set_code": "nope"})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "rate_set_error"


def test_explain_requires_all_axes():
    with _patched(_FakeDb()):
        resp = client.post("/api/v1/export-quote/products/field_fence/explain",
                           json={"spec": {}})
    assert resp.status_code == 400
    assert resp.json()["detail"]["error"] == "missing_axis"


def test_explain_unknown_product_404():
    with _patched(_FakeDb()):
        resp = client.post("/api/v1/export-quote/products/not-a-product/explain",
                           json={"spec": {}})
    assert resp.status_code == 404

# ── P0 回归：既有单证端点曾因装配助手未定义而运行期 NameError（生产 500）──────
# 这类 bug 静态 import 检查抓不到：名字只在函数体内被引用，Python 调用时才解析。
# 所以必须有**真的打一次请求**的测试。

def test_trade_doc_create_assembles_payload():
    order = _order_snapshot_row()
    items = [{"product_name": "牛栏网", "qty": 10, "qty_unit": "roll",
              "unit_price": 120, "line_amount": 1200, "spec_snapshot": None}]
    created = _doc_row(doc_no="SHP-202610-0001", doc_type="pi", order_id=3, customer_id=3,
                       total_amount=1200.0,
                       raw_payload={"sources": {"order": order}, "custom": {}})
    # db（上游快照/事件）：取订单 → 行项；conn（写入 + 客户闸门）：
    # 客户（从订单快照继承 customer_id=3，同样要过闸门）→ INSERT ... RETURNING
    db = _FakeDb(fetchrow=[order], fetch=[items])
    conn = _FakeConn(fetchrow=[_customer_row(id=3), created])
    with _patched(db, conn=conn):
        resp = client.post("/api/v1/trade-docs", json={"doc_type": "pi", "order_id": 3})
    assert resp.status_code == 201
    body = resp.json()
    assert body["doc_no"] == "SHP-202610-0001"          # 取号在测试里被固定
    assert body["raw_payload"]["sources"]["order"]["order_no"] == "ORD-202610-0001"
    assert body["total_amount"] == 1200.0
    # 单证必须带客户（约束 ck_docs_has_customer），且客户来自上游快照继承
    inserts = [(s, a) for s, a in conn.calls if "INSERT INTO trade_docs" in s]
    assert inserts, conn.sql()
    assert inserts[0][1][5] == 3                        # customer_id
    assert inserts[0][1][3] == 3 and inserts[0][1][4] is None   # order_id 落列、quote_id 为空



def test_trade_doc_render_data_assembles_seller_and_buyer():
    profile = {"name_en": "POWERVOY", "address_en": "Ningbo", "phone": None, "email": None,
               "bank_name": None, "bank_account": None, "swift_code": None,
               "default_incoterm": "FOB", "default_payment_terms": None,
               "default_country_of_origin": "CN"}
    customer = {"id": 3, "name": "ACME", "address": "Hamburg"}
    contact = {"name": "John"}
    doc = _doc_row(order_id=3, raw_payload={
        "sources": {"order": {**_order_snapshot_row(), "items": []}}, "custom": {}})
    # fetchrow 顺序：取单证 → 企业主体 → 客户 → 主联系人
    db = _FakeDb(fetchrow=[doc, profile, customer, contact])
    with _patched(db):
        resp = client.get("/api/v1/trade-docs/11/render-data")
    assert resp.status_code == 200
    body = resp.json()
    assert body["company_profile_configured"] is True
    assert body["data"]["seller"]["company"] == "POWERVOY"      # 共享内核 seller_block
    assert body["data"]["buyer"]["name"] == "ACME"
    assert body["data"]["buyer"]["contact"] == "John"
    assert body["data"]["incoterm"] == "FOB"


def test_company_profile_get_does_not_crash_without_row():
    db = _FakeDb(fetchrow=[None])
    with _patched(db):
        resp = client.get("/api/v1/tenant/company-profile")
    assert resp.status_code == 200
    assert resp.json()["configured"] is False


# ── P1 回归：platform/db.execute 不收 table=，传了就是运行期 TypeError ────────

def test_no_db_execute_with_table_kwarg():
    """静态守卫：`db.execute(..., table=...)` 必然 TypeError（execute 只回状态串）。

    历史上有 10 处（含单证 create/patch、订单状态、付款计划、企业主体 upsert），
    全部会在生产 500。这里用括号配平扫描，避免"看漏一行"。
    """
    src_dir = Path(__file__).resolve().parents[1] / "src"
    offenders = []
    for path in sorted(src_dir.glob("*.py")):
        src = path.read_text(encoding="utf-8")
        for m in re.finditer(r"\bdb\.execute\(", src):
            start = m.end() - 1
            depth, i = 0, start
            while i < len(src):
                ch = src[i]
                if ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth -= 1
                    if depth == 0:
                        break
                i += 1
            if "table=" in src[start:i + 1]:
                offenders.append(f"{path.name}:{src[:m.start()].count(chr(10)) + 1}")
    assert not offenders, f"db.execute 不接受 table= 参数，这些调用会 TypeError: {offenders}"

# ── 客户域过滤（§10.3 + 团队 + 软删除）──────────────────────────────────────
# 客户域原先完全不执行可见性过滤，导致「列表里看得见、点进去 404」；
# 且 is_deleted 只写不读 —— 软删除的客户照样列出来。这里把两条都钉住。

TEAM_MEMBER = {"id": 9, "email": "newbie@kaas.local", "account_type": "customer",
               "role": "user", "team_id": 1}


def _cust_row(**over):
    row = {"id": 1, "tenant_id": "default", "name": "联佳丝网", "code": "lianjia",
           "country": None, "address": None, "default_port": None, "credit_level": None,
           "stage": "lead", "notes": None, "created_by": None, "owner_id": None,
           "owner_scope": "private", "team_id": 1, "is_deleted": False,
           "created_at": None, "updated_at": None}
    row.update(over)
    return row


def test_customers_list_excludes_deleted_and_applies_team_scope():
    conn = _FakeConn(fetchval=[1], fetch=[[_cust_row()]])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.get("/api/v1/customers")
    assert resp.status_code == 200
    assert resp.json()["total"] == 1
    sql = conn.sql()
    assert "is_deleted = false" in sql
    # 本团队可见：owner 我 / 租户共享 / team_id = 我的团队
    assert "(owner_id = $2 OR owner_scope = 'tenant' OR team_id = $3)" in sql


def test_customers_list_admin_still_excludes_deleted():
    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched(_FakeDb(), user=ADMIN, conn=conn):
        resp = client.get("/api/v1/customers")
    assert resp.status_code == 200
    sql = conn.sql()
    assert "is_deleted = false" in sql
    assert "owner_id = $" not in sql          # 管理员不加归属过滤


def test_customers_list_without_team_keeps_old_scope():
    """没分组的成员：不加团队条件（行为与上线前一致，零回归）。"""
    no_team = {**TEAM_MEMBER, "team_id": None}
    conn = _FakeConn(fetchval=[0], fetch=[[]])
    with _patched(_FakeDb(), user=no_team, conn=conn):
        client.get("/api/v1/customers")
    assert "team_id = $" not in conn.sql()


def test_customer_detail_visible_via_team():
    conn = _FakeConn(fetchrow=[_cust_row()])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.get("/api/v1/customers/1")
    assert resp.status_code == 200
    assert resp.json().get("company_name") == "联佳丝网"
    assert "is_deleted = false" in conn.sql()


def test_customer_detail_other_team_is_404():
    """别家公司的客户：详情 404（不再"列表里有、点进去没有"）。"""
    conn = _FakeConn(fetchrow=[_cust_row(team_id=2, owner_id=None)])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.get("/api/v1/customers/1")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"


def test_customer_detail_deleted_is_404():
    """软删除的客户一律视为不存在（SQL 里已带 is_deleted = false）。"""
    conn = _FakeConn(fetchrow=[None])           # SQL 过滤掉 → 查不到
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.get("/api/v1/customers/1")
    assert resp.status_code == 404


def test_customer_stage_change_respects_visibility():
    conn = _FakeConn(fetchrow=[_cust_row(team_id=2)])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.patch("/api/v1/customers/1/stage", json={"stage": "won"})
    assert resp.status_code == 404


def test_customer_inquiry_creation_respects_visibility():
    conn = _FakeConn(fetchrow=[_cust_row(team_id=2)])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.post("/api/v1/customers/1/inquiries",
                           json={"customer_id": 1, "channel": "email",
                                 "product_name_raw": "牛栏网"})
    assert resp.status_code == 404

def test_customer_creation_stamps_creator_team():
    """用户添加的客户按**团队**鉴权：创建时把创建者的 team_id 写进客户行。"""
    conn = _FakeConn(fetchrow=[_cust_row(team_id=1)])
    with _patched(_FakeDb(), user=TEAM_MEMBER, conn=conn):
        resp = client.post("/api/v1/customers", json={"company_name": "Tim Trading"})
    assert resp.status_code == 201
    inserts = [(s, a) for s, a in conn.calls if "INSERT INTO customers" in s]
    assert inserts, conn.sql()
    assert inserts[0][1][-1] == 1        # 最后一个参数 = 创建者所在团队
