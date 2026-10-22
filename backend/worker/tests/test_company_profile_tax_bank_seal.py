"""企业信息税号/中英银行字段 + 单证盖章开关（2026-10-22）回归。

覆盖
----
1. PUT /tenant/company-profile：tax_id 小写→大写（去空格）入库、非法 422
   `INVALID_TAX_ID` 且不写库、新字段 GET 回显（空串照写，允许显式清空）；
2. GET /trade-docs/{id}/render-data：`seller.tax_id` 与**结构化** `bank_info`
   （beneficiary/beneficiary_address/beneficiary_tax_id/bank/bank_address/
   account_no/swift）；
3. `trade_docs.with_seal`：False 不注入默认章（连公章表都不查）；True 仍注入默认章；
4. POST /trade-docs：`with_seal` 解析（默认 True；仅 False/0/'false'/'0' 为 False）
   并写进 INSERT 列。

做法同 test_four_domains.py / test_render_asset_seal.py：假 db + 依赖覆盖，不连 Hyperdrive。
"""
from __future__ import annotations

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
PNG = b"\x89PNG-default-seal"


class _FakeDb:
    """冒充 platform/db.py：fetchrow 按调用顺序吐预设行，execute 记录 SQL/参数。"""

    def __init__(self, *, fetchrow=None):
        self._fetchrow = list(fetchrow or [])
        self.fetchrow_calls: list[tuple[str, tuple]] = []
        self.executed: list[tuple[str, tuple]] = []

    async def fetchrow(self, request, sql, *args, table=None):
        self.fetchrow_calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetchval(self, request, sql, *args, table=None):
        return None

    async def fetch(self, request, sql, *args, table=None):
        return []

    async def execute(self, request, sql, *args):
        self.executed.append((sql, args))
        return "UPDATE 1"


class _ProfileDb:
    """企业信息端点假库：execute 把 upsert 参数存成行，fetchrow 回读（模拟持久化）。"""

    def __init__(self):
        self.row = None
        self.executed: list[tuple[str, tuple]] = []
        self.fetchrow_calls: list[tuple[str, tuple]] = []

    async def execute(self, request, sql, *args):
        self.executed.append((sql, args))
        fields = main._COMPANY_FIELDS
        self.row = {f: args[i + 1] for i, f in enumerate(fields)}
        return "INSERT 0 1"

    async def fetchrow(self, request, sql, *args, table=None):
        self.fetchrow_calls.append((sql, args))
        return self.row


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """冒充 `_acquire()` 吐出的连接（单证 create 的写入事务路径）。"""

    def __init__(self, *, fetchrow=None, fetchval=None):
        self._fetchrow = list(fetchrow or [])
        self._fetchval = list(fetchval or [])
        self.calls: list[tuple[str, tuple]] = []

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
        self.calls.append((sql, args))
        return "INSERT 0 1"

    def transaction(self):
        return _FakeTxn()

    def args_of(self, marker: str):
        for sql, args in self.calls:
            if marker in sql:
                return sql, args
        raise AssertionError(f"没找到 SQL 片段 {marker!r}:\n" + "\n".join(s for s, _ in self.calls))


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
    try:
        yield db
    finally:
        main.db = old_db
        main._acquire = old_acquire
        main.app.dependency_overrides.clear()


# ── 1. 企业信息：税号规范化 + 新字段回显 ────────────────────────────────────

def test_put_company_profile_normalizes_tax_id_and_echoes_new_fields():
    db = _ProfileDb()
    with _patched(db):
        resp = client.put("/api/v1/tenant/company-profile", json={
            "name_en": "Acme Trading Co.",
            "phone": "",                          # 空串照写（可显式清空，不是 NULL）
            "tax_id": " 91310000ma1fl1234x ",
            "bank_name": "Bank of China",
            "bank_name_zh": "中国银行",
            "bank_address_en": "1 Bank Street, Shanghai",
            "bank_address_zh": "上海市银行路1号",
        })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tax_id"] == "91310000MA1FL1234X"     # 去空格 + 大写
    assert body["bank_name"] == "Bank of China"       # bank_name 仍是英文开户行
    assert body["bank_name_zh"] == "中国银行"
    assert body["bank_address_en"] == "1 Bank Street, Shanghai"
    assert body["bank_address_zh"] == "上海市银行路1号"
    assert body["phone"] == ""
    assert body["configured"] is True

    sql, args = db.executed[0]
    assert "INSERT INTO tenant_company_profile" in sql
    # 列序 = 既有 14 列 + 4 新列（末尾追加，老列序不变）
    assert "tax_id, bank_name_zh, bank_address_en, bank_address_zh)" in sql
    assert args[0] == "default"
    assert args[15] == "91310000MA1FL1234X"
    assert args[16] == "中国银行"
    assert args[17] == "1 Bank Street, Shanghai"
    assert args[18] == "上海市银行路1号"


def test_put_company_profile_rejects_invalid_tax_id_without_write():
    db = _ProfileDb()
    with _patched(db):
        resp = client.put("/api/v1/tenant/company-profile", json={
            "name_en": "Acme Trading Co.", "tax_id": "12345"})
    assert resp.status_code == 422, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "validation"
    assert detail["code"] == "INVALID_TAX_ID"
    assert "6–32" in detail["detail"]
    assert db.executed == []          # 校验失败不写库


# ── 2/3. render-data：卖方税号 / 结构化 bank_info / 盖章开关 ─────────────────

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


def _doc_row(**over):
    row = {
        "id": 11, "tenant_id": "default", "doc_no": "PI-202610-0001",
        "doc_type": "pi", "order_id": 3, "quote_id": None, "customer_id": 3,
        "status": "draft", "currency": "USD", "total_amount": 1200.0,
        "issued_at": None, "raw_payload": {"sources": {}, "custom": {}},
        "created_at": datetime(2026, 10, 22, tzinfo=timezone.utc),
        "with_seal": True,
    }
    row.update(over)
    return row


def test_render_data_assembles_seller_tax_id_and_structured_bank_info(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)   # 让公章走内核 data URI 回退
    seal = {"id": 3, "png_bytes": PNG, "mime": "image/png"}
    db = _FakeDb(fetchrow=[
        _doc_row(), _profile(),
        {"id": 3, "name": "ACME", "address": "Hamburg"}, {"name": "John"},
        seal,
    ])
    with _patched(db):
        resp = client.get("/api/v1/trade-docs/11/render-data")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["seller"]["company"] == "POWERVOY LTD"
    assert data["seller"]["tax_id"] == "91310000MA1FL1234X"
    assert data["bank_info"] == {
        "beneficiary": "POWERVOY LTD",
        "beneficiary_address": "Ningbo, China",
        "beneficiary_tax_id": "91310000MA1FL1234X",
        "bank": "Bank of China, Ningbo Branch",      # 英文开户行
        "bank_address": "1 Bank Street, Ningbo",     # 英文地址（中文列不进英文单证）
        "account_no": "3901 5566 7788",
        "swift": "BKCHCNBJ220",
    }
    # with_seal 缺省/True ⇒ 仍注入默认章
    assert data["company_stamp"].startswith("data:image/png;base64,")


def test_render_data_skips_default_seal_when_with_seal_false(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    db = _FakeDb(fetchrow=[
        _doc_row(with_seal=False), _profile(),
        {"id": 3, "name": "ACME", "address": "Hamburg"}, {"name": "John"},
    ])
    with _patched(db):
        resp = client.get("/api/v1/trade-docs/11/render-data")
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert "company_stamp" not in data
    # 不盖章时**不查**公章表（省一次查询）
    assert not any("tenant_company_seals" in sql for sql, _ in db.fetchrow_calls)


def test_render_data_keeps_explicit_custom_stamp_even_when_with_seal_false(monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    explicit = "data:image/png;base64,ZXhwbGljaXQ="
    doc = _doc_row(with_seal=False)
    doc["raw_payload"] = {"sources": {}, "custom": {"company_stamp": explicit}}
    db = _FakeDb(fetchrow=[
        doc, _profile(), {"id": 3, "name": "ACME", "address": "Hamburg"}, {"name": "John"},
    ])
    with _patched(db):
        resp = client.get("/api/v1/trade-docs/11/render-data")
    assert resp.status_code == 200, resp.text
    # 单据显式给的章以单据为准（既不覆盖、也不因 with_seal=False 被清掉）
    assert resp.json()["data"]["company_stamp"] == explicit


# ── 4. create：with_seal 解析并落列 ─────────────────────────────────────────

def _customer_row(**over):
    row = {"id": 3, "tenant_id": "default", "name": "ACME", "company_name": "ACME",
           "owner_id": None, "owner_scope": "team", "team_id": None,
           "is_deleted": False}
    row.update(over)
    return row


def _inserted_doc(with_seal=True):
    return {
        "id": 21, "tenant_id": "default", "doc_no": "PI-CN-ACME-20261022140000",
        "doc_type": "pi", "order_id": None, "quote_id": None, "customer_id": 3,
        "status": "draft", "currency": "USD", "total_amount": None,
        "raw_payload": {"sources": {}, "custom": {}}, "with_seal": with_seal,
        "created_at": None, "issued_at": None,
    }


def _create_doc(body):
    conn = _FakeConn(fetchrow=[_customer_row(), _inserted_doc()])
    db = _FakeDb()
    with _patched(db, conn=conn):
        resp = client.post("/api/v1/trade-docs", json=body)
    return resp, conn, db


def test_create_trade_doc_defaults_with_seal_true():
    resp, conn, _db = _create_doc({"doc_type": "pi", "customer_id": 3})
    assert resp.status_code == 201, resp.text
    sql, args = conn.args_of("INSERT INTO trade_docs")
    assert "with_seal" in sql and "$11" in sql
    assert args[10] is True           # 绑定参数：$1 tenant … $10 team_id、$11 with_seal
    assert resp.json()["with_seal"] is True


def test_create_trade_doc_with_seal_false_is_written():
    resp, conn, _db = _create_doc(
        {"doc_type": "pi", "customer_id": 3, "with_seal": False})
    assert resp.status_code == 201, resp.text
    _sql, args = conn.args_of("INSERT INTO trade_docs")
    assert args[10] is False


def test_create_trade_doc_with_seal_string_zero_is_false():
    """前端表单可能把开关序列化成 'false'/'0'（字符串），只这几种算不盖章。"""
    resp, conn, _db = _create_doc(
        {"doc_type": "pi", "customer_id": 3, "with_seal": "false"})
    assert resp.status_code == 201, resp.text
    _sql, args = conn.args_of("INSERT INTO trade_docs")
    assert args[10] is False
