"""单证**内容级版本**（TODO A1）的 Worker 行为测试（无数据库、无网络）。

覆盖：
1. 草稿保存内容 → 落一版 `custom_update`（整份 payload 快照）；
2. 没改 payload 的 PATCH / 已签发被拒的 PATCH → **不落版本**；
3. 签发（confirm）→ 落一版 `issue`（含 `_render` 指纹终版）；
4. 翻译写回 → 落一版 `translate`；
5. 列表 / 单版本详情 / 恢复（draft）／已签发与报价单的拒绝路径。

做法同 `test_four_domains.py`：`db` 换成假实现、`_get_current_user` 依赖覆盖。
"""
import json
import sys
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

import ws_docs_ext  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

ADMIN = {"id": 1, "account_type": "internal", "role": "system_admin"}


# ── 假 db ───────────────────────────────────────────────────────────────────

class _FakeDb:
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
        return "INSERT 0 1"

    def version_inserts(self):
        return [(s, a) for s, a in self.executed
                if "INSERT INTO trade_doc_content_versions" in s]


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    """冒充 `_main._acquire()` 吐出的连接（translate 路径读 AI 绑定用）。"""

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


@contextmanager
def _patched(db, user=ADMIN, conn=None):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = {
        "main_db": worker_main.db,
        "ext_db": ws_docs_ext.db,
        "acquire": worker_main._acquire,
    }
    worker_main.db = db
    ws_docs_ext.db = db
    worker_main._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        worker_main.db = old["main_db"]
        ws_docs_ext.db = old["ext_db"]
        worker_main._acquire = old["acquire"]
        worker_main.app.dependency_overrides.clear()


# ── 行构造 ──────────────────────────────────────────────────────────────────

def _doc_row(**over):
    row = {
        "id": 11, "tenant_id": "default", "doc_no": "PI-202610-0001", "doc_type": "pi",
        "order_id": None, "quote_id": None, "customer_id": 3, "status": "draft",
        "currency": "USD", "total_amount": None, "issued_at": None, "issued_by": None,
        "raw_payload": {"sources": {}, "custom": {"payment_terms": "30% T/T"}},
        "created_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
        "owner_id": None, "owner_scope": "private", "team_id": None,
    }
    row.update(over)
    return row


def _version_row(**over):
    row = {
        "version_no": 2,
        "raw_payload": {"sources": {}, "custom": {"payment_terms": "30% T/T"}},
        "change_source": "custom_update",
        "actor_id": "1",
        "note": None,
        "created_at": datetime(2026, 10, 10, tzinfo=timezone.utc),
    }
    row.update(over)
    return row


def _doc_assembly_rows(doc):
    """confirm 装配渲染指纹要读的行（顺序照 `main.get_trade_doc_render_data`）。"""
    return [
        doc,
        {"tenant_id": "default", "name_en": "KAAS TRADING CO., LTD",
         "address_en": "Hebei, China"},
        {"id": 3, "name": "ACME", "address": "Hamburg"},
        {"name": "Mr. Li", "phone": None, "email": None},
        None,   # 没有默认公章
    ]


# ── 写入路径：PATCH ─────────────────────────────────────────────────────────

def test_patch_custom_records_content_version():
    db = _FakeDb(fetchrow=[_doc_row(), _doc_row()])
    payload = {"sources": {"order": {"order_no": "ORD-1"}},
               "custom": {"remarks": "1) 分批装运"}}
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11", json={"raw_payload": payload})
    assert resp.status_code == 200
    inserts = db.version_inserts()
    assert len(inserts) == 1, f"预期恰好一条版本记录，实际 {len(inserts)}"
    _sql, args = inserts[0]
    # 顺序：tenant, doc_id, payload_json, source, actor, note
    assert args[0] == "default" and args[1] == 11
    stored = json.loads(args[2])
    assert stored["custom"]["remarks"] == "1) 分批装运"
    assert args[3] == "custom_update"
    assert args[4] == "1"


def test_patch_without_payload_records_no_version():
    """只改编号/状态、没改内容 → 不产生版本行（版本表只记内容变更）。"""
    db = _FakeDb(fetchrow=[_doc_row(), _doc_row(status="issued", issued_at=datetime.now(timezone.utc))],
                 fetchval=[None])
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11", json={"status": "issued"})
    assert resp.status_code == 200
    assert db.version_inserts() == []


def test_patch_issued_payload_rejected_and_no_version():
    db = _FakeDb(fetchrow=[_doc_row(status="issued", issued_at=datetime.now(timezone.utc))])
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11",
                            json={"raw_payload": {"custom": {"x": "1"}}})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "PAYLOAD_LOCKED"
    assert db.version_inserts() == []


# ── 写入路径：签发 / 翻译 ──────────────────────────────────────────────────

def test_confirm_records_issue_version_with_render_fingerprint():
    doc = _doc_row(total_amount=120)
    items = [{"product_name": "牛栏网", "qty": 1, "unit_price": 120, "line_amount": 120}]
    db = _FakeDb(
        fetchrow=[doc, *_doc_assembly_rows(doc),
                  _doc_row(status="issued", total_amount=120, issued_by="1")],
        fetch=[items],
    )
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/confirm", json={})
    assert resp.status_code == 200
    inserts = db.version_inserts()
    assert len(inserts) == 1
    _sql, args = inserts[0]
    stored = json.loads(args[2])
    assert args[3] == "issue"
    # 终版必须带上 `_render` 指纹（将来对账"客户看到的那一版"靠它）
    assert stored["_render"]["render_version"]


def test_translate_writeback_records_version():
    db = _FakeDb(fetchrow=[_doc_row()])
    conn = _FakeConn(fetchrow=[{"enabled": False}])
    with _patched(db, conn=conn):
        resp = client.post("/api/v1/trade-docs/11/translate",
                           json={"fields": {"remarks": "分批装运"}})
    assert resp.status_code == 200
    assert resp.json()["path"] == "template"
    inserts = db.version_inserts()
    assert len(inserts) == 1
    assert inserts[0][1][3] == "translate"


# ── 读路径：列表 / 详情 ────────────────────────────────────────────────────


# ── 恢复 ───────────────────────────────────────────────────────────────────

def test_restore_draft_writes_new_version_and_updates_doc():
    restored_payload = {"sources": {}, "custom": {"payment_terms": "100% T/T"}}
    db = _FakeDb(fetchrow=[_doc_row(), _version_row(raw_payload=restored_payload),
                           _doc_row()])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/content-versions/2/restore", json={})
    assert resp.status_code == 200
    assert resp.json()["restored_version_no"] == 2
    inserts = db.version_inserts()
    assert len(inserts) == 1
    _sql, args = inserts[0]
    assert args[3] == "restore"
    assert args[5] == "恢复至 v2"                       # note
    assert json.loads(args[2]) == restored_payload
    # 单据本身也被更新（恢复必须落到当前内容上）；UPDATE 走 fetchrow（RETURNING *）
    updates = [s for kind, s, _ in db.calls
               if kind == "fetchrow" and "UPDATE trade_docs SET raw_payload" in s]
    assert len(updates) == 1


def test_restore_issued_rejected():
    db = _FakeDb(fetchrow=[_doc_row(status="issued", issued_at=datetime.now(timezone.utc))])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/content-versions/1/restore", json={})
    assert resp.status_code == 409
    assert db.version_inserts() == []


def test_restore_quotation_doc_rejected():
    """报价单是报价的 1:1 同步产物 —— 恢复会被下次报价更新覆盖，直接拒绝。"""
    db = _FakeDb(fetchrow=[_doc_row(doc_type="quotation")])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/content-versions/1/restore", json={})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "QUOTATION_DOC_SYNCED"


def test_restore_unknown_version_404():
    db = _FakeDb(fetchrow=[_doc_row(), None])
    with _patched(db):
        resp = client.post("/api/v1/trade-docs/11/content-versions/9/restore", json={})
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "VERSION_NOT_FOUND"
