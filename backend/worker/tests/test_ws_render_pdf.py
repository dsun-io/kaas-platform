"""Worker 侧「自动出 PDF」的单测：binding 优先 → REST 兜底 → 未配置 503。

为什么需要这个文件
------------------
生产 API 就是这个 Worker（`kaas.powervoy.com` / `api.kaas.powervoy.com`）。
新增的 `POST /api/v1/trade-docs/{doc_id}/pdf` 在**生产**只有一条可用路径：
`wrangler.jsonc` 里的 `"browser": {"binding": "BROWSER"}` →
`env.BROWSER.quickAction("pdf", {html})`（**不需要任何 API token**）。
REST（需 `BROWSER_RENDERING_TOKEN`）只是本地/无 binding 时的兜底。

本文件在 CPython 里**不真的触发 Pyodide**：`js` / `pyodide.ffi` 用最小假模块替换，
`_binding_quick_action_pdf` / `_rest_quick_action_pdf` 在多数用例里直接 monkeypatch。
覆盖三件坏掉也不会报错的事：

1. 有 binding 就必须走 binding（且失败时**如实 502**，不偷偷换路掩盖故障）；
2. 没 binding 但有 token → 走 REST，并且请求形状正确（Bearer 头 + `{"html": …}`）；
3. 两者都没有 → **503 `PDF_RENDERER_NOT_CONFIGURED`**（绝不假装成功）。
"""
from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()  # 装好 `workers` stub，保证 `main` 可导入，再 import ws_files

import ws_files as wsf  # noqa: E402

from kaas_common.files import RENDERER_NOT_CONFIGURED_DETAIL  # noqa: E402

ACCOUNT_ID = "766f8d7eb5a7d20e272673073ec8c3fd"
TOKEN = "cf-token-example"
PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n"

GOOD_HTML = (
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
    "<h1>PROFORMA INVOICE</h1>"
    '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Company Stamp">'
    "</body></html>"
)

_ENV_KEYS = (
    "BROWSER", "BROWSER_RENDERING_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID",
    "BROWSER_RENDERING_TOKEN", "CLOUDFLARE_API_TOKEN", "PDF_HTML_ALLOWED_HOSTS",
)


class _Env:
    """`request.scope["env"]` 的替身：按**属性**读绑定（与 Pyodide 的 env 一致）。"""

    def __init__(self, bindings: dict):
        self.__dict__.update(bindings)


class _FakeRequest:
    def __init__(self, bindings: dict | None = None):
        self.scope: dict = {"env": _Env(bindings or {})}


@pytest.fixture(autouse=True)
def _no_ambient_env(monkeypatch):
    """开发机/CI 的 os.environ 里可能躺着 CLOUDFLARE_*；一律清掉，测试才确定。"""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def _run(coro):
    return asyncio.run(coro)


class _FakeBinding:
    """假 browser binding：记录 quickAction 调用。"""

    def __init__(self, result=PDF_BYTES, error: Exception | None = None):
        self.calls: list[tuple] = []
        self._result = result
        self._error = error

    async def quickAction(self, action, payload):
        self.calls.append((action, payload))
        if self._error is not None:
            raise self._error
        return _FakeResponse(200, self._result)


class _FakeBuffer:
    def __init__(self, data: bytes):
        self._data = bytes(data)

    def to_py(self):
        return bytearray(self._data)


class _FakeResponse:
    def __init__(self, status: int, data: bytes = b""):
        self.status = status
        self._data = bytes(data)

    async def arrayBuffer(self):
        return _FakeBuffer(self._data)


class _FakeJSFetch:
    def __init__(self, response):
        self.calls: list[tuple] = []
        self._response = response

    async def __call__(self, url, opts=None):
        self.calls.append((url, opts))
        return self._response


def _install_fake_pyodide(monkeypatch, fetch_impl):
    """塞入最小 `js` / `pyodide.ffi` 假模块（monkeypatch 结束自动移除）。"""
    js = types.ModuleType("js")
    js.fetch = fetch_impl
    monkeypatch.setitem(sys.modules, "js", js)

    pyodide = types.ModuleType("pyodide")
    pyodide.__path__ = []  # 让 `pyodide.ffi` 可被当作子模块解析
    ffi = types.ModuleType("pyodide.ffi")
    ffi.to_js = lambda obj, **kwargs: obj
    pyodide.ffi = ffi
    monkeypatch.setitem(sys.modules, "pyodide", pyodide)
    monkeypatch.setitem(sys.modules, "pyodide.ffi", ffi)


# ── 选路：binding → REST → 503 ───────────────────────────────────────────────

class TestBrowserBinding:
    def test_returns_binding_object_when_declared(self):
        binding = _FakeBinding()
        assert wsf._browser_binding(_FakeRequest({"BROWSER": binding})) is binding

    def test_none_when_not_declared(self):
        assert wsf._browser_binding(_FakeRequest({})) is None


class TestRenderPdfBytes:
    def test_binding_wins_and_needs_no_token(self, monkeypatch):
        binding = _FakeBinding()
        used: list[tuple] = []

        async def _fake(b, html):
            used.append((b, html))
            return PDF_BYTES

        monkeypatch.setattr(wsf, "_binding_quick_action_pdf", _fake)
        data, renderer = _run(wsf._render_pdf_bytes(_FakeRequest({"BROWSER": binding}), GOOD_HTML))
        assert data == PDF_BYTES
        assert renderer == "binding"
        # 有 binding 就只走 binding（环境里没有任何 token，REST 路径根本没被碰过）
        assert used == [(binding, GOOD_HTML)]

    def test_binding_quick_action_call_shape(self, monkeypatch):
        """生产真正走的那一行：`quickAction("pdf", {"html": …})` + `arrayBuffer().to_py()`。"""
        _install_fake_pyodide(monkeypatch, _FakeJSFetch(_FakeResponse(200, b"")))
        binding = _FakeBinding()
        data = _run(wsf._binding_quick_action_pdf(binding, GOOD_HTML))
        assert data == PDF_BYTES
        assert binding.calls == [("pdf", {"html": GOOD_HTML})]

    def test_binding_failure_is_502_not_silent_reroute(self, monkeypatch):
        async def _boom(b, html):
            raise RuntimeError("The RPC receiver does not implement the method quickAction")

        monkeypatch.setattr(wsf, "_binding_quick_action_pdf", _boom)
        with pytest.raises(HTTPException) as ei:
            _run(wsf._render_pdf_bytes(_FakeRequest({"BROWSER": _FakeBinding()}), GOOD_HTML))
        assert ei.value.status_code == 502
        assert ei.value.detail["code"] == "PDF_RENDER_FAILED"

    def test_no_binding_no_token_is_503(self, monkeypatch):
        with pytest.raises(HTTPException) as ei:
            _run(wsf._render_pdf_bytes(_FakeRequest({}), GOOD_HTML))
        assert ei.value.status_code == 503
        assert ei.value.detail["code"] == "PDF_RENDERER_NOT_CONFIGURED"
        assert ei.value.detail["detail"] == RENDERER_NOT_CONFIGURED_DETAIL

    def test_rest_used_when_no_binding_but_token_configured(self, monkeypatch):
        request = _FakeRequest({
            "BROWSER_RENDERING_ACCOUNT_ID": ACCOUNT_ID,
            "BROWSER_RENDERING_TOKEN": TOKEN,
        })

        async def _fake(cfg, html):
            assert cfg["token"] == TOKEN
            assert html == GOOD_HTML
            return PDF_BYTES

        monkeypatch.setattr(wsf, "_rest_quick_action_pdf", _fake)
        data, renderer = _run(wsf._render_pdf_bytes(request, GOOD_HTML))
        assert (data, renderer) == (PDF_BYTES, "rest")


# ── REST 兜底：请求形状与错误映射 ───────────────────────────────────────────

class TestRestQuickAction:
    def test_200_returns_bytes_and_sends_bearer_json(self, monkeypatch):
        fetch = _FakeJSFetch(_FakeResponse(200, PDF_BYTES))
        _install_fake_pyodide(monkeypatch, fetch)
        cfg = {"url": "https://api.cloudflare.com/client/v4/accounts/x/browser-rendering/pdf",
               "token": TOKEN}
        data = _run(wsf._rest_quick_action_pdf(cfg, GOOD_HTML))
        assert data == PDF_BYTES
        url, opts = fetch.calls[0]
        assert url == cfg["url"]
        assert opts["method"] == "POST"
        assert opts["headers"]["Authorization"] == f"Bearer {TOKEN}"
        assert opts["headers"]["Content-Type"] == "application/json"
        assert opts["body"] == json.dumps({"html": GOOD_HTML})

    def test_non_200_is_502(self, monkeypatch):
        fetch = _FakeJSFetch(_FakeResponse(429, b"rate limited"))
        _install_fake_pyodide(monkeypatch, fetch)
        with pytest.raises(HTTPException) as ei:
            _run(wsf._rest_quick_action_pdf({"url": "https://x/pdf", "token": TOKEN}, GOOD_HTML))
        assert ei.value.status_code == 502
        assert ei.value.detail["code"] == "PDF_RENDER_FAILED"
        assert "429" in ei.value.detail["detail"]


# ── 端点：校验 → 出字节 → 落档（假 _create_file / attach_doc_file） ──────────

class _Created:
    def __init__(self):
        self.creates: list[dict] = []
        self.links: list[dict] = []


@pytest.fixture
def archived(monkeypatch):
    fake = _Created()

    async def _create(**kwargs):
        fake.creates.append(kwargs)
        return {"id": 55, "storage": "inline", "kind": kwargs["kind"], "name": kwargs["name"]}

    async def _attach(doc_id, body, request, user):
        fake.links.append({"doc_id": doc_id, "file_id": body.file_id, "role": body.role})
        return {"id": 3, "role": body.role}

    monkeypatch.setattr(wsf, "_create_file", _create)
    monkeypatch.setattr(wsf, "attach_doc_file", _attach)
    return fake


class TestRenderDocPdfEndpoint:
    def test_unsafe_html_rejected_before_renderer(self, archived):
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(
                5, wsf.RenderPdfIn(html='<html><body><iframe src="https://evil"></iframe></body></html>'),
                _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 422
        assert ei.value.detail["code"] == "HTML_UNSAFE_MARKUP"
        assert archived.creates == []

    def test_external_image_rejected(self, archived):
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(
                5, wsf.RenderPdfIn(html='<html><body><img src="https://evil/a.png"></body></html>'),
                _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 422
        assert ei.value.detail["code"] == "HTML_EXTERNAL_RESOURCE"

    def test_default_whitelist_allows_own_domain(self, archived):
        """默认白名单（自家域名）放行 ⇒ 走到 503（未配渲染器），而不是被 422 挡住。"""
        html = '<html><body><img src="https://kaas.powervoy.com/a.png"></body></html>'
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=html), _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 503
        assert ei.value.detail["code"] == "PDF_RENDERER_NOT_CONFIGURED"

    def test_configured_whitelist_read_from_request_env(self, archived):
        """Worker 侧白名单必须走**请求期**读取（`main._binding`）：env 里配的 CDN 放行，
        默认域名此时不在白名单 ⇒ 422。证明两端读的是同一份配置、且是替换而非追加。"""
        html = '<html><body><img src="https://files.example.com/a.png"></body></html>'
        request = _FakeRequest({"PDF_HTML_ALLOWED_HOSTS": "files.example.com"})
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=html), request, {"id": 1}))
        assert ei.value.status_code == 503
        assert ei.value.detail["code"] == "PDF_RENDERER_NOT_CONFIGURED"

        html_default = '<html><body><img src="https://kaas.powervoy.com/a.png"></body></html>'
        with pytest.raises(HTTPException) as ei2:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=html_default), request, {"id": 1}))
        assert ei2.value.status_code == 422
        assert ei2.value.detail["code"] == "HTML_EXTERNAL_RESOURCE"

    def test_lookalike_domain_still_rejected(self, archived):
        """白名单最容易写错的"像域名但不是"：后缀伪造与协议相对地址都必须继续拒。"""
        for url in ("https://kaas.powervoy.com.evil.com/a.png",
                    "https://evilkaas.powervoy.com/a.png",
                    "//kaas.powervoy.com/a.png"):
            with pytest.raises(HTTPException) as ei:
                _run(wsf.render_doc_pdf(
                    5, wsf.RenderPdfIn(html=f'<html><body><img src="{url}"></body></html>'),
                    _FakeRequest({}), {"id": 1}))
            assert ei.value.status_code == 422
            assert ei.value.detail["code"] == "HTML_EXTERNAL_RESOURCE"

    def test_not_configured_is_503(self, archived):
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=GOOD_HTML),
                                    _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 503
        assert ei.value.detail["code"] == "PDF_RENDERER_NOT_CONFIGURED"
        assert archived.creates == []

    def test_non_pdf_response_is_502(self, archived, monkeypatch):
        async def _fake(request, html):
            return b'{"success":false}', "binding"

        monkeypatch.setattr(wsf, "_render_pdf_bytes", _fake)
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=GOOD_HTML),
                                    _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 502
        assert ei.value.detail["code"] == "PDF_RENDER_FAILED"
        assert archived.creates == []

    def test_oversized_pdf_is_422(self, archived, monkeypatch):
        from kaas_common.files import MAX_RENDER_PDF_BYTES

        async def _fake(request, html):
            return b"%PDF-" + b"0" * MAX_RENDER_PDF_BYTES, "binding"

        monkeypatch.setattr(wsf, "_render_pdf_bytes", _fake)
        with pytest.raises(HTTPException) as ei:
            _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=GOOD_HTML),
                                    _FakeRequest({}), {"id": 1}))
        assert ei.value.status_code == 422
        assert ei.value.detail["code"] == "FILE_TOO_LARGE"
        assert archived.creates == []

    def test_happy_path_archives_as_render_pdf_with_supersede(self, archived, monkeypatch):
        async def _fake(request, html):
            assert html == GOOD_HTML
            return PDF_BYTES, "binding"

        monkeypatch.setattr(wsf, "_render_pdf_bytes", _fake)
        out = _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=GOOD_HTML, name="PI-2026-001 系统版"),
                                      _FakeRequest({"BROWSER": _FakeBinding()}), {"id": 1}))

        assert out["renderer"] == "binding"
        assert out["bytes"] == len(PDF_BYTES)
        assert out["storage"] == "inline"
        assert len(archived.creates) == 1
        create = archived.creates[0]
        assert create["kind"] == "render_pdf"
        assert create["supersede"] is True
        assert create["content_type"] == "application/pdf"
        assert create["content"] == PDF_BYTES
        assert create["owner_type"] == "trade_doc"
        assert create["owner_id"] == "5"
        assert create["name"] == "PI-2026-001 系统版"
        assert archived.links == [{"doc_id": 5, "file_id": 55, "role": "render_pdf"}]

    def test_default_name_when_blank(self, archived, monkeypatch):
        async def _fake(request, html):
            return PDF_BYTES, "binding"

        monkeypatch.setattr(wsf, "_render_pdf_bytes", _fake)
        _run(wsf.render_doc_pdf(5, wsf.RenderPdfIn(html=GOOD_HTML),
                                _FakeRequest({"BROWSER": _FakeBinding()}), {"id": 1}))
        assert archived.creates[0]["name"] == "单证 5 系统 PDF"
