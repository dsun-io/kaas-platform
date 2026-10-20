"""服务端签发自动上传（TODO F1，方案 A）守卫。

方案 A（2026-10-20 用户拍板）：签发请求可携带前端**预览用的同一份 HTML**，
服务端在同一请求里出 PDF 并归档为 `render_pdf`（新版本上位）。

关键边界：
1. PDF 失败**不回滚签发** —— 签发是法律动作、归档是后续动作；响应带
   `pdf_archive {ok:false, code}` 让界面提示手动上传，绝不把"已签发"静默吞掉；
2. 不带 HTML ⇒ 保持旧行为（不产 PDF，响应无 pdf_archive 键）；
3. 两条签发入口（`POST .../confirm` 与 `PATCH /trade-docs/{id}` status=issued）行为一致。
"""
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


class _FakeDb:
    def __init__(self, *, fetchrow=None, fetch=None):
        self._fetchrow = list(fetchrow or [])
        self._fetch = list(fetch or [])
        self.calls: list[tuple[str, tuple]] = []

    async def fetchrow(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetchrow.pop(0) if self._fetchrow else None

    async def fetch(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        return self._fetch.pop(0) if self._fetch else []

    async def fetchval(self, request, sql, *args, table=None):
        self.calls.append((sql, args))
        return 0

    async def execute(self, request, sql, *args):
        self.calls.append((sql, args))
        return "UPDATE 1"


class _FakeTxn:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


class _FakeConn:
    def __init__(self, row=None):
        self._row = row

    async def fetchrow(self, sql, *args):
        return self._row

    async def fetchval(self, sql, *args):
        return None

    async def fetch(self, sql, *args):
        return []

    async def execute(self, sql, *args):
        return "UPDATE 1"

    def transaction(self):
        return _FakeTxn()


@contextmanager
def _patched(db, conn=None):
    @asynccontextmanager
    async def fake_acquire(request):
        yield conn

    old = {"main_db": worker_main.db, "ext_db": ws_docs_ext.db,
           "acquire": worker_main._acquire}
    worker_main.db = db
    ws_docs_ext.db = db
    worker_main._acquire = fake_acquire
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: ADMIN
    try:
        yield
    finally:
        worker_main.db = old["main_db"]
        ws_docs_ext.db = old["ext_db"]
        worker_main._acquire = old["acquire"]
        worker_main.app.dependency_overrides.clear()


def _doc_row(**over):
    row = {
        "id": 11, "tenant_id": "default", "doc_no": "PI-202610-0011", "doc_type": "pi",
        "order_id": None, "quote_id": None, "customer_id": 3, "status": "draft",
        "currency": "USD", "total_amount": 120, "issued_at": None, "issued_by": None,
        "raw_payload": {"sources": {}, "custom": {"payment_terms": "30% T/T"}},
        "created_at": datetime(2026, 10, 20, tzinfo=timezone.utc),
        "updated_at": datetime(2026, 10, 20, tzinfo=timezone.utc),
        "owner_id": None, "owner_scope": "private", "team_id": None,
    }
    row.update(over)
    return row


def _assembly_rows(doc):
    return [
        doc,
        {"tenant_id": "default", "name_en": "KAAS", "address_en": "Hebei"},
        {"id": 3, "name": "ACME", "address": "Hamburg"},
        {"name": "Li", "phone": None, "email": None},
        None,
    ]


def _patch_archive(monkeypatch, *, exc=None, file_id=99):
    """补丁打在**调用时 import 的那个模块对象**上。

    注意：每个测试文件都会 `load_main()` 重载模块，本文件顶部 `import ws_files`
    拿到的可能不是后续测试文件重载后的同一对象；而 confirm 里是函数内
    `import ws_files`（按 sys.modules 现查）。所以这里用 importlib 现取，避免
    "补丁打在旧对象上、被调的是新对象" 的假通过/假失败。
    """
    import importlib

    mod = importlib.import_module("ws_files")

    async def fake(request, doc_id, html, user, name=None):
        if exc is not None:
            raise exc
        return {"file": {"id": file_id}, "renderer": "binding", "bytes": 1234,
                "storage": "r2"}

    monkeypatch.setattr(mod, "archive_rendered_pdf", fake)


def _patch_archive_fail(monkeypatch):
    import importlib

    from fastapi import HTTPException

    mod = importlib.import_module("ws_files")

    async def fake(request, doc_id, html, user, name=None):
        raise HTTPException(status_code=503, detail={
            "error": "unavailable", "code": "PDF_RENDERER_NOT_CONFIGURED",
            "detail": "未配置渲染器",
        })

    monkeypatch.setattr(mod, "archive_rendered_pdf", fake)


def _confirm(monkeypatch, *, html=None, archive_ok=True):
    doc = _doc_row()
    issued = _doc_row(status="issued", issued_by="1")
    items = [{"product_name": "牛栏网", "qty": 1, "unit_price": 120, "line_amount": 120}]
    db = _FakeDb(
        fetchrow=[doc, *_assembly_rows(doc), issued],
        fetch=[items],
    )
    _patch_archive(monkeypatch) if archive_ok else _patch_archive_fail(monkeypatch)
    with _patched(db):
        return client.post("/api/v1/trade-docs/11/confirm",
                           json={"html": html} if html else {})


def test_confirm_with_html_archives_pdf(monkeypatch):
    resp = _confirm(monkeypatch, html="<html>PI</html>")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "issued"
    assert body["pdf_archive"]["ok"] is True
    assert body["pdf_archive"]["file_id"] == 99
    assert body["pdf_archive"]["renderer"] == "binding"


def test_confirm_pdf_failure_does_not_roll_back_issue(monkeypatch):
    resp = _confirm(monkeypatch, html="<html>PI</html>", archive_ok=False)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "issued"                 # 签发没被吞
    assert body["pdf_archive"]["ok"] is False
    assert body["pdf_archive"]["status_code"] == 503
    assert body["pdf_archive"]["detail"]["code"] == "PDF_RENDERER_NOT_CONFIGURED"


def test_confirm_without_html_keeps_old_behavior(monkeypatch):
    resp = _confirm(monkeypatch)
    assert resp.status_code == 200
    assert "pdf_archive" not in resp.json()


def test_patch_issue_with_html_archives_pdf(monkeypatch):
    doc = _doc_row()
    db = _FakeDb(fetchrow=[doc, _doc_row(status="issued")])
    _patch_archive(monkeypatch)
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11",
                            json={"status": "issued", "html": "<html>PI</html>"})
    assert resp.status_code == 200
    assert resp.json()["pdf_archive"]["ok"] is True


def test_patch_issue_pdf_failure_does_not_roll_back(monkeypatch):
    doc = _doc_row()
    db = _FakeDb(fetchrow=[doc, _doc_row(status="issued")])
    _patch_archive_fail(monkeypatch)
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11",
                            json={"status": "issued", "html": "<html>PI</html>"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "issued"
    assert body["pdf_archive"]["ok"] is False


def test_patch_without_html_does_not_archive(monkeypatch):
    doc = _doc_row()
    db = _FakeDb(fetchrow=[doc, _doc_row(status="issued")])
    _patch_archive_fail(monkeypatch)       # 若被误调用会立刻失败可见
    with _patched(db):
        resp = client.patch("/api/v1/trade-docs/11", json={"status": "issued"})
    assert resp.status_code == 200
    assert "pdf_archive" not in resp.json()
