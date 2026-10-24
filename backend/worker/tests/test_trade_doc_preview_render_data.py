"""POST /api/v1/trade-docs/preview-render-data（开单前完整成品预览）回归。

覆盖
----
1. 真实上游（订单 / 报价 / 询盘）→ 行项、数量、单价、金额、贸易条款、买卖方/银行区块；
2. 与 GET /trade-docs/{id}/render-data 的 data 逐字段同形状（除编号/日期这类"此刻值"）；
3. 零写库：全程没有 INSERT/UPDATE/DELETE，写接口一次都没被调用；
4. 无上游（只挂客户）→ 200、货物为空、金额自然为空（不塞样板数据）；
5. with_seal=False 不注入默认章（连公章表都不查）；缺省/True 注入（与 render-data 同口径）；
6. 越权客户 / 订单 / 报价 → 404（不泄露存在性）；缺 doc_type / customer_id → 422；
7. 报价单 1:1：该报价已有报价单时，预览返回已存在的那张（与 create 语义一致）。

做法同 test_company_profile_tax_bank_seal.py：假 db + 依赖覆盖，不连 Hyperdrive。
写库防护用 _WriteForbidden 兜底：任何 INSERT/UPDATE/DELETE 都会让用例直接报错。
"""
from __future__ import annotations

import importlib
import re
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}
MEMBER = {"id": 5, "account_type": "internal", "role": "customer_member", "team_id": 2}
PNG = b"png-default-seal"

_MUTATING = re.compile(r"\b(INSERT|UPDATE|DELETE)\b")


class _WriteForbidden(RuntimeError):
    """预览端点出现写库调用 —— 直接炸，避免"数字变好了但其实写了库"。"""


class _FakeDb:
    """冒充 platform/db.py（全局 db）：读走预设队列，写一律炸。"""

    def __init__(self, *, fetchrow=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self.fetchrow_calls = []
        self.fetch_calls = []
        self.executed = []

    async def fetchrow(self, request, sql, *args, table=None):
        self.fetchrow_calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, request, sql, *args, table=None):
        self.fetchrow_calls.append((sql, args))
        return None

    async def fetch(self, request, sql, *args, table=None):
        self.fetch_calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def execute(self, request, sql, *args):
        self.executed.append((sql, args))
        raise _WriteForbidden(sql)

    def sqls(self):
        return [s for s, _ in self.fetchrow_calls + self.fetch_calls]


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """冒充 main._acquire() 的连接：客户闸门 / 上游闸门 / 编号读走预设队列。"""

    def __init__(self, *, fetchrow=None, fetchval=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self.calls = []
        self.executed = []

    async def fetchrow(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, sql, *args):
        self.calls.append((sql, args))
        return self._fetchval.pop(0) if self._fetchval else None

    async def fetch(self, sql, *args):
        self.calls.append((sql, args))
        return []

    async def execute(self, sql, *args):
        self.executed.append((sql, args))
        raise _WriteForbidden(sql)

    def transaction(self):
        return _FakeTxn()

    def sqls(self):
        return [s for s, _ in self.calls]


@contextmanager
def _patched(db, user=ADMIN, conn=None):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old_db = main.db
    old_acquire = main._acquire
    main.db = db
    if conn is not None:
        main._acquire = fake_acquire
    main.app.dependency_overrides[main._get_current_user] = lambda: user
    # ws_files 在导入时把 db 别名成本模块全局（ws_files.db = main.db）；而单证装配里
    # 是运行期 `import ws_files as _ws_files`（按 sys.modules 解析）—— 全量套件里
    # sys.modules["ws_files"] 可能是别的测试模块 load_main() 产出的实例，所以这里替换
    # "当前 sys.modules 里那一个"的 db 别名，照片解析才会走假库。
    live_ws = importlib.import_module("ws_files")
    old_ws_db = live_ws.db
    live_ws.db = db
    try:
        yield db
    finally:
        live_ws.db = old_ws_db
        main.db = old_db
        main._acquire = old_acquire
        main.app.dependency_overrides.clear()


# ── 假数据 ──────────────────────────────────────────────────────────────────

def _profile(**over):
    row = {
        "name_en": "POWERVOY LTD", "name_zh": "博威", "address_en": "Ningbo, China",
        "address_zh": "宁波", "phone": "+86-574-1", "email": "sales@powervoy.example",
        "website": None, "bank_name": "Bank of China, Ningbo Branch",
        "bank_account": "3901 5566 7788", "swift_code": "BKCHCNBJ220",
        "logo_url": None, "default_incoterm": "FOB",
        "default_payment_terms": "30% T/T", "default_country_of_origin": "CN",
        "tax_id": "91310000MA1FL1234X",
        "bank_name_zh": "中国银行宁波分行",
        "bank_address_en": "1 Bank Street, Ningbo",
        "bank_address_zh": "宁波市银行路1号",
    }
    row.update(over)
    return row


def _customer_row(**over):
    row = {"id": 3, "tenant_id": "default", "name": "ACME", "company_name": "ACME",
           "owner_id": None, "owner_scope": "team", "team_id": None,
           "is_deleted": False, "abbr": "ACME", "country": "US",
           "address": "Hamburg", "phone": None, "email": None}
    row.update(over)
    return row


def _customer_lite(**over):
    row = {"id": 3, "name": "ACME", "address": "Hamburg"}
    row.update(over)
    return row


def _order_row(**over):
    row = {"id": 9, "tenant_id": "default", "order_no": "ORD-US-ACME-20261020",
           "customer_id": 3, "customer_name": "ACME", "status": "confirmed",
           "currency": "USD", "total_amount": 2794.0, "fx_rate": 7.1,
           "incoterm": "FOB Ningbo", "payment_terms": "30% T/T in advance",
           "port_of_loading": "Ningbo", "port_of_destination": "Hamburg",
           "shipping_marks": "ACME/HAMBURG", "country_of_origin": "China",
           "owner_id": None, "owner_scope": "team", "team_id": 2}
    row.update(over)
    return row


def _order_items():
    return [
        {"product_name": "Hexagonal Wire Netting", "qty": 100.0, "qty_unit": "roll",
         "unit_price": 12.5, "line_amount": 1250.0,
         "spec_snapshot": {"specification": "Mesh 1/2 inch", "hs_code": "73144100",
                           "package": "Roll", "gross_weight": 20.5,
                           "net_weight": 18.0, "volume": 0.5}},
        {"product_name": "Chain Link Fence", "qty": 80.0, "qty_unit": "set",
         "unit_price": 19.3, "line_amount": 1544.0,
         "spec_snapshot": {"specification": "Mesh 2 inch"}},
    ]


def _expected_order_items():
    return [
        {"product_name": "Hexagonal Wire Netting", "qty": 100.0, "qty_unit": "roll",
         "unit_price": 12.5, "line_amount": 1250.0,
         "specification": "Mesh 1/2 inch", "hs_code": "73144100",
         "package": "Roll", "gross_weight": 20.5, "net_weight": 18.0, "volume": 0.5},
        {"product_name": "Chain Link Fence", "qty": 80.0, "qty_unit": "set",
         "unit_price": 19.3, "line_amount": 1544.0,
         "specification": "Mesh 2 inch"},
    ]


def _order_snapshot():
    return {
        "order_no": "ORD-US-ACME-20261020", "customer_id": 3,
        "customer_name": "ACME", "status": "confirmed", "currency": "USD",
        "total_amount": 2794.0, "fx_rate": 7.1,
        "incoterm": "FOB Ningbo", "payment_terms": "30% T/T in advance",
        "port_of_loading": "Ningbo", "port_of_destination": "Hamburg",
        "shipping_marks": "ACME/HAMBURG", "country_of_origin": "China",
        "items": _order_items(),
    }


def _quote_row(**over):
    row = {"id": 11, "tenant_id": "default", "quote_no": "QUO-US-ACME-20261019",
           "customer_id": 3, "customer_name": "ACME", "status": "accepted",
           "currency": "EUR", "total_amount": 4290.0,
           "incoterm": "CIF Hamburg", "payment_terms": "L/C at sight",
           "port_of_loading": "Shanghai", "port_of_destination": "Hamburg",
           "shipping_marks": "ACME", "country_of_origin": "China",
           "owner_id": None, "owner_scope": "team", "team_id": 2}
    row.update(over)
    return row


def _quote_items():
    return [
        {"product_name": "Hexagonal Wire Netting", "qty": 220.0, "qty_unit": "roll",
         "unit_price": 10.5, "line_amount": 2310.0,
         "spec_snapshot": {"specification": "Mesh 1/2 inch", "hs_code": "73144100"}},
        {"product_name": "Chain Link Fence", "qty": 90.0, "qty_unit": "set",
         "unit_price": 22.0, "line_amount": 1980.0,
         "spec_snapshot": {"specification": "Mesh 2 inch"}},
    ]


def _expected_quote_items():
    return [
        {"product_name": "Hexagonal Wire Netting", "qty": 220.0, "qty_unit": "roll",
         "unit_price": 10.5, "line_amount": 2310.0,
         "specification": "Mesh 1/2 inch", "hs_code": "73144100"},
        {"product_name": "Chain Link Fence", "qty": 90.0, "qty_unit": "set",
         "unit_price": 22.0, "line_amount": 1980.0,
         "specification": "Mesh 2 inch"},
    ]


def _quote_snapshot():
    return {
        "quote_no": "QUO-US-ACME-20261019", "customer_id": 3,
        "customer_name": "ACME", "status": "accepted", "currency": "EUR",
        "total_amount": 4290.0, "incoterm": "CIF Hamburg",
        "payment_terms": "L/C at sight", "port_of_loading": "Shanghai",
        "port_of_destination": "Hamburg", "shipping_marks": "ACME",
        "country_of_origin": "China", "items": _quote_items(),
    }


def _inquiry_row(**over):
    row = {"id": 5, "tenant_id": "default", "customer_id": 3, "status": "quoted",
           "channel": "email", "product_name_raw": "Hexagonal Wire Netting",
           "quantity": 500.0, "quantity_unit": "roll", "application": "fencing",
           "owner_id": None, "owner_scope": "team", "team_id": 2}
    row.update(over)
    return row


def _seal_row():
    return {"id": 7, "png_bytes": PNG, "mime": "image/png"}


def _persisted_doc_row(**over):
    row = {"id": 11, "tenant_id": "default", "doc_no": "PI-US-ACME-20261023120000",
           "doc_type": "pi", "order_id": 9, "quote_id": None, "customer_id": 3,
           "status": "draft", "currency": "USD", "total_amount": 2794.0,
           "raw_payload": {"sources": {}, "custom": {}},
           "created_at": datetime(2026, 10, 23, 12, 0, tzinfo=timezone.utc),
           "issued_at": None, "with_seal": True, "owner_id": None,
           "owner_scope": "team", "team_id": None}
    row.update(over)
    return row


# ── 断言助手 ────────────────────────────────────────────────────────────────

def _preview(json_body):
    return client.post("/api/v1/trade-docs/preview-render-data", json=json_body)


def _assert_zero_writes(db, conn):
    assert db.executed == [], "预览端点写了库（db.execute）：" + str(db.executed)
    assert conn.executed == [], "预览端点写了库（conn.execute）：" + str(conn.executed)
    for sql in db.sqls() + conn.sqls():
        assert not _MUTATING.search(sql), "预览端点出现了写语句：" + sql


def _seal_stamp(body):
    return body["data"]["company_stamp"]


# ── 1. 真实上游：订单 → 行项 / 金额 / 条款 / 买卖方 ─────────────────────────

def test_preview_pi_from_order_returns_real_items_terms_and_amounts(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_order_row(), _customer_row()], fetchval=[None])
    db = _FakeDb(
        fetchrow=[_order_row(), _profile(), _customer_lite(), {"name": "John"},
                  _seal_row()],
        fetch=[_order_items()],
    )
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3, "currency": "usd",
                         "order_id": 9, "raw_payload": {"remarks": "Handle with care"}})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert set(out) == {"doc", "data", "company_profile_configured"}
    doc, data = out["doc"], out["data"]

    # 虚拟单据：未落库，但编号/日期按"此刻开单"算出（编号只读计算、不占用）
    assert doc["id"] is None
    assert doc["status"] == "draft"
    assert doc["doc_type"] == "pi"
    assert doc["order_id"] == 9 and doc["quote_id"] is None
    assert doc["customer_id"] == 3
    assert doc["currency"] == "USD"
    assert doc["total_amount"] == 2794.0
    assert doc["with_seal"] is True
    assert re.fullmatch("PI-US-ACME-[0-9]{14}", doc["doc_no"]), doc["doc_no"]

    # data：与 render-data 同源同形状的真实单据数据
    assert data["pi_no"] == doc["doc_no"]
    assert data["pi_date"] == doc["created_at"]
    assert data["currency"] == "USD"
    assert data["total_amount"] == 2794.0
    assert data["items"] == _expected_order_items()
    assert data["incoterm"] == "FOB Ningbo"
    assert data["payment_terms"] == "30% T/T in advance"
    assert data["port_of_loading"] == "Ningbo"
    assert data["port_of_destination"] == "Hamburg"
    assert data["shipping_marks"] == "ACME/HAMBURG"
    assert data["country_of_origin"] == "China"
    assert data["seller"]["company"] == "POWERVOY LTD"
    assert data["seller"]["tax_id"] == "91310000MA1FL1234X"
    assert data["bank_info"] == {
        "beneficiary": "POWERVOY LTD",
        "beneficiary_address": "Ningbo, China",
        "beneficiary_tax_id": "91310000MA1FL1234X",
        "bank": "Bank of China, Ningbo Branch",
        "bank_address": "1 Bank Street, Ningbo",
        "account_no": "3901 5566 7788",
        "swift": "BKCHCNBJ220",
    }
    assert data["buyer"] == {"name": "ACME", "address": "Hamburg", "contact": "John"}
    # 请求体里的手工内容（custom）也进装配（与 create 的 raw_payload 口径一致）
    assert data["remarks"] == "Handle with care"
    assert _seal_stamp(out).startswith("data:image/png;base64,")
    assert out["company_profile_configured"] is True

    # 上游行项来自真实订单快照，而不是任何样板底稿
    assert doc["raw_payload"]["sources"]["order"]["order_no"] == "ORD-US-ACME-20261020"
    _assert_zero_writes(db, conn)
    # 预置队列必须正好用完（防止调用顺序悄悄漂移导致断言失真）
    assert conn._fetchrow == [] and conn._fetchval == []
    assert db._fetchrow == [] and db._fetch == []


# ── 2. 与已落库单据的 render-data 逐字段同形状 ──────────────────────────────

def test_preview_data_matches_persisted_render_data(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_order_row(), _customer_row()], fetchval=[None])
    db_preview = _FakeDb(
        fetchrow=[_order_row(), _profile(), _customer_lite(), {"name": "John"},
                  _seal_row()],
        fetch=[_order_items()],
    )
    with _patched(db_preview, conn=conn):
        preview = _preview({"doc_type": "pi", "customer_id": 3, "order_id": 9})
    assert preview.status_code == 200, preview.text

    doc_row = _persisted_doc_row(
        raw_payload={"sources": {"order": _order_snapshot()}, "custom": {}})
    db_get = _FakeDb(
        fetchrow=[doc_row, _profile(), _customer_lite(), {"name": "John"},
                  _seal_row()],
    )
    with _patched(db_get):
        rendered = client.get("/api/v1/trade-docs/11/render-data")
    assert rendered.status_code == 200, rendered.text

    a = dict(preview.json()["data"])
    b = dict(rendered.json()["data"])
    # 编号/日期是"此刻值"（预览是现在，已落库单据是开单当时）⇒ 比对时剔除
    for key in ("pi_no", "pi_date"):
        a.pop(key, None)
        b.pop(key, None)
    assert a == b, "预览 data 与 render-data 的 data 形状不一致"
    _assert_zero_writes(db_preview, conn)


# ── 3. 零写库：多种上游形态都不写 ───────────────────────────────────────────

def test_preview_endpoint_never_writes(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    cases = [
        {
            "body": {"doc_type": "pi", "customer_id": 3, "order_id": 9},
            "conn_rows": [_order_row(), _customer_row()],
            "conn_vals": [None],
            "db_rows": [_order_row(), _profile(), _customer_lite(),
                        {"name": "John"}, _seal_row()],
            "db_fetches": [_order_items()],
        },
        {
            "body": {"doc_type": "ci", "customer_id": 3},
            "conn_rows": [_customer_row()],
            "conn_vals": [None],
            "db_rows": [_profile(), _customer_lite(), {"name": "John"}, _seal_row()],
            "db_fetches": [],
        },
    ]
    for case in cases:
        conn = _FakeConn(fetchrow=case["conn_rows"], fetchval=case["conn_vals"])
        db = _FakeDb(fetchrow=case["db_rows"], fetch=case["db_fetches"])
        with _patched(db, conn=conn):
            resp = _preview(case["body"])
        assert resp.status_code == 200, resp.text
        _assert_zero_writes(db, conn)


# ── 4. 无上游（只挂客户）：货物/金额自然为空 ────────────────────────────────

def test_preview_direct_customer_without_upstream_has_empty_goods(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None])
    db = _FakeDb(fetchrow=[_profile(), _customer_lite(), {"name": "John"},
                           _seal_row()])
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    doc, data = out["doc"], out["data"]
    assert doc["order_id"] is None and doc["quote_id"] is None
    assert doc["total_amount"] is None
    # 不塞样板数据：货物为空、金额自然空
    assert "items" not in data
    assert "total_amount" not in data
    # 但真实买方 / 卖方 / 编号 / 日期仍然齐全
    assert data["buyer"]["name"] == "ACME"
    assert data["seller"]["company"] == "POWERVOY LTD"
    assert data["pi_no"] == doc["doc_no"]
    assert data["pi_date"] == doc["created_at"]
    # 企业主体默认条款（与 render-data 同口径）
    assert data["incoterm"] == "FOB"
    _assert_zero_writes(db, conn)


# ── 5/6. with_seal 开关（与 render-data 同口径）─────────────────────────────

def test_preview_with_seal_false_skips_default_seal(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None])
    db = _FakeDb(fetchrow=[_profile(), _customer_lite(), {"name": "John"}])
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3, "with_seal": False})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert "company_stamp" not in out["data"]
    assert out["doc"]["with_seal"] is False
    # 不盖章 ⇒ 连公章表都不查（与 render-data 的省查询口径一致）
    assert not any("tenant_company_seals" in sql for sql in db.sqls())
    _assert_zero_writes(db, conn)


def test_preview_with_seal_default_injects_default_seal(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None])
    db = _FakeDb(fetchrow=[_profile(), _customer_lite(), {"name": "John"},
                           _seal_row()])
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3})   # 未传 with_seal
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["doc"]["with_seal"] is True
    assert _seal_stamp(out).startswith("data:image/png;base64,")
    _assert_zero_writes(db, conn)


# ── 7. 报价作为上游：真实报价行项/条款/金额 ─────────────────────────────────

def test_preview_from_quote_uses_quote_snapshot(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_quote_row(), _customer_row()], fetchval=[None])
    db = _FakeDb(
        fetchrow=[_quote_row(), _profile(), _customer_lite(), {"name": "John"},
                  _seal_row()],
        fetch=[_quote_items()],
    )
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3,
                         "quote_order_id": 11})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    doc, data = out["doc"], out["data"]
    assert doc["quote_id"] == 11 and doc["order_id"] is None
    assert data["items"] == _expected_quote_items()
    assert data["total_amount"] == 4290.0
    # 币种以报价快照为准（与 render-data 同口径；单头 currency 仍记请求值）
    assert data["currency"] == "EUR"
    assert doc["currency"] == "USD"
    assert data["incoterm"] == "CIF Hamburg"
    assert data["payment_terms"] == "L/C at sight"
    assert doc["raw_payload"]["sources"]["quote"]["quote_no"] == "QUO-US-ACME-20261019"
    _assert_zero_writes(db, conn)


# ── 8. 询盘作为上游：有买方/来源，但没有行项（与 render-data 同口径）────────

def test_preview_from_inquiry_has_no_items(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_inquiry_row(), _customer_row()], fetchval=[None])
    db = _FakeDb(fetchrow=[_inquiry_row(), _profile(), _customer_lite(),
                           {"name": "John"}, _seal_row()])
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3, "inquiry_id": 5})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert "items" not in out["data"]
    assert "total_amount" not in out["data"]
    assert out["doc"]["raw_payload"]["sources"]["inquiry"]["product_name_raw"] == (
        "Hexagonal Wire Netting")
    assert out["data"]["buyer"]["name"] == "ACME"
    _assert_zero_writes(db, conn)


# ── 9-12. 越权 / 不存在的上游 → 404（不泄露存在性）──────────────────────────

def test_preview_foreign_customer_returns_404():
    conn = _FakeConn(fetchrow=[_customer_row(team_id=99)])
    db = _FakeDb()
    with _patched(db, user=MEMBER, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "CUSTOMER_NOT_FOUND"
    assert db.fetchrow_calls == []      # 客户闸门先于任何数据装配
    _assert_zero_writes(db, conn)


def test_preview_foreign_order_returns_404():
    conn = _FakeConn(fetchrow=[_order_row(team_id=99)])
    db = _FakeDb()
    with _patched(db, user=MEMBER, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3, "order_id": 9})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "ORDER_NOT_FOUND"
    assert db.fetchrow_calls == []      # 上游闸门先于快照读取
    _assert_zero_writes(db, conn)


def test_preview_foreign_quote_returns_404():
    conn = _FakeConn(fetchrow=[_quote_row(team_id=99)])
    db = _FakeDb()
    with _patched(db, user=MEMBER, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3,
                         "quote_order_id": 11})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "QUOTE_NOT_FOUND"
    _assert_zero_writes(db, conn)


def test_preview_missing_upstream_returns_404():
    conn = _FakeConn(fetchrow=[None])
    db = _FakeDb()
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3, "order_id": 999})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "ORDER_NOT_FOUND"
    _assert_zero_writes(db, conn)


# ── 13-15. 请求体校验 ──────────────────────────────────────────────────────

def test_preview_requires_doc_type_422():
    conn = _FakeConn()
    db = _FakeDb()
    with _patched(db, conn=conn):
        resp = _preview({})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["error"] == "bad_doc_type"
    assert conn.calls == [] and db.fetchrow_calls == []
    _assert_zero_writes(db, conn)


def test_preview_requires_customer_id_422():
    conn = _FakeConn()
    db = _FakeDb()
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "CUSTOMER_REQUIRED"
    assert conn.calls == []             # 缺客户在查库之前就 422
    _assert_zero_writes(db, conn)


def test_preview_rejects_protected_custom_422():
    conn = _FakeConn()
    db = _FakeDb()
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "pi", "customer_id": 3,
                         "raw_payload": {"items": [], "total_amount": 999}})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "CUSTOM_FIELD_PROTECTED"
    assert set(detail["fields"]) == {"items", "total_amount"}
    _assert_zero_writes(db, conn)


# ── 16. 报价单 1:1：已存在则预览那一张（与 create 语义一致）─────────────────

def test_preview_quotation_returns_existing_doc(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    existing_doc = _persisted_doc_row(
        id=77, doc_type="quotation", doc_no="QUO-US-ACME-20261019",
        order_id=None, quote_id=11, currency="EUR", total_amount=4290.0,
        raw_payload={"sources": {"quote": _quote_snapshot()}, "custom": {}},
    )
    conn = _FakeConn(fetchrow=[_quote_row(), _customer_row(), existing_doc])
    db = _FakeDb(
        fetchrow=[_quote_row(), _profile(), _customer_lite(), {"name": "John"},
                  _seal_row()],
        fetch=[_quote_items()],
    )
    with _patched(db, conn=conn):
        resp = _preview({"doc_type": "quotation", "customer_id": 3,
                         "quote_order_id": 11})
    assert resp.status_code == 200, resp.text
    out = resp.json()
    # 预览的是已存在的那一张，而不是再算一个新编号
    assert out["doc"]["id"] == 77
    assert out["data"]["quote_no"] == "QUO-US-ACME-20261019"
    assert out["data"]["total_amount"] == 4290.0
    assert out["data"]["items"] == _expected_quote_items()
    _assert_zero_writes(db, conn)


# ── 17. 照片引用：解析不了就跳过，不能 500 ─────────────────────────────────

def test_preview_photo_refs_unresolvable_are_skipped(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    conn = _FakeConn(fetchrow=[_customer_row()], fetchval=[None])
    # file_objects 查询故意返回 None（图库行不存在 / 别团队）⇒ 该条跳过
    db = _FakeDb(fetchrow=[_profile(), _customer_lite(), {"name": "John"}, None,
                           _seal_row()])
    body = {"doc_type": "pi", "customer_id": 3,
            "raw_payload": {"product_photos": [
                {"image": "data:image/png;base64,eA=="},
                {"file_id": 999},
            ]}}
    with _patched(db, conn=conn):
        resp = _preview(body)
    assert resp.status_code == 200, resp.text
    # 已给图源的条目原样保留；解析不到的引用被跳过（不印坏图、不 500）
    assert resp.json()["data"]["product_photos"] == [
        {"image": "data:image/png;base64,eA=="}]
    _assert_zero_writes(db, conn)
