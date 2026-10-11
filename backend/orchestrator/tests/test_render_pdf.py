"""自动出 PDF（Browser Rendering）共享内核 + orchestrator 端点的单测。

为什么需要这个文件
------------------
用户原话：「自动出pdf字节听起来是降低工作量的设计实现它」。这条链路的服务端新增了
`POST /api/v1/trade-docs/{doc_id}/pdf`：把**预览同源的那份 HTML** 交给 Cloudflare
Browser Rendering 出 PDF 字节，再走既有落档链路（`_store_bytes` → `_create_file`
→ `attach_doc_file`，`kind=render_pdf` 参与版本让位）。

两件必须被钉住的事（它们坏掉都不会报错、只会静静出错）：

1. **安全边界**：入参 HTML 会被**我们账号里的无头浏览器**渲染 ⇒ 不校验就等于把出网能力
   交出去（SSRF / 外联代理）。`<script>`／`<iframe>`／`on*=`／`javascript:`／任何非
   `data:` 的资源地址一律 422。
2. **不假装成功**：没配渲染器（无 binding、无 token）必须 **503
   `PDF_RENDERER_NOT_CONFIGURED`**；上游失败或返回的不是 PDF 必须 **502**，
   绝不允许把一段 JSON 错误体当成 PDF 存成 `render_pdf`。

本文件不发任何真实网络/数据库请求：渲染器、`_create_file`、`attach_doc_file`、
`httpx.AsyncClient` 全部替换成假实现（现有 `test_files_*` 的同一路数）。
"""
from __future__ import annotations

import types
from pathlib import Path

import pytest
from fastapi import HTTPException

from kaas_common.files import (
    BROWSER_RENDERING_QUICK_ACTION_PATH,
    MAX_RENDER_HTML_BYTES,
    MAX_RENDER_PDF_BYTES,
    FileRuleError,
    looks_like_pdf,
    render_pdf_rest_config,
    render_pdf_rest_url,
    validate_render_html,
)
from kaas_common.files.render_pdf import RENDERER_NOT_CONFIGURED_DETAIL

from app.api import files as files_api

pytestmark = pytest.mark.unit

ACCOUNT_ID = "766f8d7eb5a7d20e272673073ec8c3fd"
TOKEN = "cf-token-example"

# 渲染器 `render.ts` 真实产出的形状：自包含 HTML、样式内联、图片是 data URI。
GOOD_HTML = (
    '<!DOCTYPE html><html><head><meta charset="utf-8">'
    "<style>body{font-family:Arial;margin:12mm}</style></head><body>"
    "<h1>PROFORMA INVOICE</h1>"
    '<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" alt="Company Stamp">'
    "<p>E-mail: sales@example.com</p>"
    '<p>Remarks: onload= 只是正文文字，不是事件属性</p>'
    "</body></html>"
)

PDF_BYTES = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n"

_ENV_KEYS = (
    "BROWSER_RENDERING_ACCOUNT_ID", "CLOUDFLARE_ACCOUNT_ID",
    "BROWSER_RENDERING_TOKEN", "CLOUDFLARE_API_TOKEN",
)


@pytest.fixture(autouse=True)
def _no_ambient_renderer_env(monkeypatch):
    """本机/CI 环境里可能就躺着 CLOUDFLARE_* 或 BROWSER_RENDERING_*；
    「未配置」的用例必须真的未配置，否则测试从此不确定。"""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


# ── 共享内核：入参 HTML 安全校验 ─────────────────────────────────────────────

class TestValidateRenderHtml:
    def test_accepts_renderer_shaped_html(self):
        validate_render_html(GOOD_HTML)  # 不抛 = 通过

    def test_rejects_non_string_and_blank(self):
        for value in (None, 123, b"<html></html>", "", "   \n  "):
            with pytest.raises(FileRuleError) as ei:
                validate_render_html(value)
            assert ei.value.code == "HTML_REQUIRED"

    def test_rejects_oversized_html(self):
        with pytest.raises(FileRuleError) as ei:
            validate_render_html("x" * (MAX_RENDER_HTML_BYTES + 1))
        assert ei.value.code == "HTML_TOO_LARGE"

    @pytest.mark.parametrize("injection", [
        "<script>fetch('http://evil.example')</script>",
        "<SCRIPT SRC=x></SCRIPT>",
        '<iframe src="https://evil.example"></iframe>',
        "<object data=x></object>",
        "<embed src=x>",
        '<link rel="stylesheet" href="https://evil.example/a.css">',
        "<base href=\"https://evil.example/\">",
        "<form action=\"https://evil.example\"></form>",
        '<img src="x" onerror="alert(1)">',
        '<body onload="alert(1)">',
        '<a href="javascript:alert(1)">x</a>',
        '<meta http-equiv="refresh" content="0;url=https://evil.example">',
        "<style>@import url(https://evil.example/a.css);</style>",
    ])
    def test_rejects_script_like_markup(self, injection):
        with pytest.raises(FileRuleError) as ei:
            validate_render_html(f'<!DOCTYPE html><html><body>{injection}</body></html>')
        assert ei.value.code == "HTML_UNSAFE_MARKUP"

    @pytest.mark.parametrize("external", [
        '<img src="https://example.com/a.png">',
        '<img src="http://example.com/a.png">',
        '<img src="//example.com/a.png">',
        '<img srcset="https://example.com/a.png 1x">',
        '<div style="background: url(https://example.com/a.png)">x</div>',
        '<table background="https://example.com/a.png"><tr><td>x</td></tr></table>',
        "<style>body{background-image:url('https://example.com/a.png')}</style>",
    ])
    def test_rejects_external_resources(self, external):
        with pytest.raises(FileRuleError) as ei:
            validate_render_html(f'<!DOCTYPE html><html><body>{external}</body></html>')
        assert ei.value.code == "HTML_EXTERNAL_RESOURCE"

    def test_data_uri_and_anchor_are_allowed(self):
        validate_render_html(
            '<!DOCTYPE html><html><body>'
            '<img src="data:image/webp;base64,UklGRg==" alt="photo">'
            "<a href=\"#section-1\">anchor</a>"
            "</body></html>"
        )

    def test_plain_text_is_not_mistaken_for_markup(self):
        """正文里出现 `onload=` / `src=` / `https://` 是**用户文案**，不能误杀。"""
        validate_render_html(
            "<!DOCTYPE html><html><body><p>"
            "Remarks: onload=1 src=http://example.com 见 https://example.com 说明"
            "</p></body></html>"
        )


GOLDEN_HTML_DIR = (
    Path(__file__).resolve().parents[3]
    / "frontend" / "src" / "lib" / "trade-doc" / "__fixtures__" / "html"
)


class TestRealRendererOutputPassesSecurityGate:
    """18 份渲染基线必须**全部**通过安全校验。

    为什么这条重要：自动出 PDF 的安全边界（拒脚本 / 拒外链）如果误伤了自家渲染器的产出，
    功能就是"永远 422"；反过来，如果哪天渲染器开始产外链/脚本，这里会立刻红
    —— 正好拦住"把渲染器变成出网工具"。基线是渲染器的真实产物（
    `scripts/verify-trade-doc-fixtures.py` 逐字节对账），不是手写的样例。
    """

    def test_all_golden_fixtures_accepted(self):
        files = sorted(GOLDEN_HTML_DIR.glob("*.html"))
        assert len(files) == 18, f"渲染基线数量变了：{len(files)}（预期 18 类单据）"
        for path in files:
            validate_render_html(path.read_text(encoding="utf-8"))


class TestLooksLikePdf:
    def test_magic_bytes_only(self):
        assert looks_like_pdf(b"%PDF-1.7\n...") is True
        assert looks_like_pdf(bytearray(b"%PDF-")) is True
        assert looks_like_pdf(b'{"success":false}') is False
        assert looks_like_pdf(b"") is False
        assert looks_like_pdf("(not bytes)") is False
        assert looks_like_pdf(None) is False


class TestRendererConfig:
    def test_configured_from_env(self):
        env = {"BROWSER_RENDERING_ACCOUNT_ID": ACCOUNT_ID,
               "BROWSER_RENDERING_TOKEN": TOKEN}
        cfg = render_pdf_rest_config(env.get)
        assert cfg is not None
        assert cfg["account_id"] == ACCOUNT_ID
        assert cfg["token"] == TOKEN
        assert cfg["url"].endswith(
            BROWSER_RENDERING_QUICK_ACTION_PATH.format(account_id=ACCOUNT_ID))

    def test_falls_back_to_cloudflare_env_names(self):
        env = {"CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID, "CLOUDFLARE_API_TOKEN": TOKEN}
        assert render_pdf_rest_config(env.get)["token"] == TOKEN

    @pytest.mark.parametrize("env", [
        {},
        {"BROWSER_RENDERING_ACCOUNT_ID": ACCOUNT_ID},          # 缺 token
        {"BROWSER_RENDERING_TOKEN": TOKEN},                    # 缺账号
        {"BROWSER_RENDERING_ACCOUNT_ID": "not-an-account-id",  # 形状不对（防拼 URL 注入）
         "BROWSER_RENDERING_TOKEN": TOKEN},
        {"BROWSER_RENDERING_ACCOUNT_ID": "  ", "BROWSER_RENDERING_TOKEN": "  "},
    ])
    def test_not_configured(self, env):
        assert render_pdf_rest_config(env.get) is None

    def test_url_rejects_bad_account_id(self):
        with pytest.raises(ValueError):
            render_pdf_rest_url("../etc/passwd")


# ── orchestrator：调用上游 ───────────────────────────────────────────────────

class _FakeResponse:
    def __init__(self, status_code: int, content: bytes = b""):
        self.status_code = status_code
        self.content = content


class _FakeAsyncClient:
    def __init__(self, response, recorder):
        self._response = response
        self._recorder = recorder

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, json=None):
        self._recorder.update({"url": url, "headers": headers, "json": json})
        return self._response


def _patch_httpx(monkeypatch, response):
    recorder: dict = {}
    monkeypatch.setattr(
        files_api.httpx, "AsyncClient",
        lambda **kwargs: _FakeAsyncClient(response, recorder))
    return recorder


class TestRenderPdfViaRest:
    async def test_posts_html_and_returns_bytes(self, monkeypatch):
        rec = _patch_httpx(monkeypatch, _FakeResponse(200, PDF_BYTES))
        cfg = {"url": "https://api.cloudflare.com/client/v4/accounts/x/browser-rendering/pdf",
               "token": TOKEN}
        data = await files_api._render_pdf_via_rest(cfg, GOOD_HTML)
        assert data == PDF_BYTES
        assert rec["json"] == {"html": GOOD_HTML}
        assert rec["headers"]["Authorization"] == f"Bearer {TOKEN}"
        assert rec["headers"]["Content-Type"] == "application/json"

    async def test_upstream_error_is_502_not_silent_fallback(self, monkeypatch):
        _patch_httpx(monkeypatch, _FakeResponse(500, b"boom"))
        with pytest.raises(HTTPException) as ei:
            await files_api._render_pdf_via_rest({"url": "https://x/pdf", "token": TOKEN},
                                                 GOOD_HTML)
        assert ei.value.status_code == 502
        assert ei.value.detail["code"] == "PDF_RENDER_FAILED"


# ── orchestrator：端点行为（直调路由函数，不经过 DB） ────────────────────────

def _auth():
    return types.SimpleNamespace(tenant_id="default", team_id=None, user_id=1)


def _body(html=GOOD_HTML, name=None):
    return files_api.RenderPdfIn(html=html, name=name)


class _CreatedFiles:
    """假 `_create_file` / `attach_doc_file`：记录调用参数，不碰 DB/存储。"""

    def __init__(self):
        self.creates: list[dict] = []
        self.links: list[dict] = []

    async def create(self, db, **kwargs):
        self.creates.append(kwargs)
        return {"id": 77, "storage": "s3", "kind": kwargs["kind"], "name": kwargs["name"]}

    async def attach(self, doc_id, body, auth, db):
        self.links.append({"doc_id": doc_id, "file_id": body.file_id, "role": body.role})
        return {"id": 9, "role": body.role, "caption": None, "sort_order": 0}


@pytest.fixture
def archived(monkeypatch):
    fake = _CreatedFiles()
    monkeypatch.setattr(files_api, "_create_file", fake.create)
    monkeypatch.setattr(files_api, "attach_doc_file", fake.attach)
    return fake


class TestRenderDocPdfEndpoint:
    async def test_unsafe_html_is_rejected_before_renderer_check(self, archived):
        """安全校验必须**先于**渲染器检查（未配渲染器也不能放过脚本）。"""
        with pytest.raises(HTTPException) as ei:
            await files_api.render_doc_pdf(
                5, _body('<html><body><script>alert(1)</script></body></html>'),
                _auth(), object())
        assert ei.value.status_code == 422
        assert ei.value.detail["code"] == "HTML_UNSAFE_MARKUP"
        assert archived.creates == []

    async def test_not_configured_is_503_with_actionable_detail(self, archived):
        with pytest.raises(HTTPException) as ei:
            await files_api.render_doc_pdf(5, _body(), _auth(), object())
        assert ei.value.status_code == 503
        assert ei.value.detail["code"] == "PDF_RENDERER_NOT_CONFIGURED"
        assert ei.value.detail["detail"] == RENDERER_NOT_CONFIGURED_DETAIL
        assert "wrangler.jsonc" in ei.value.detail["detail"]
        assert archived.creates == []

    async def test_non_pdf_response_is_502(self, archived, monkeypatch):
        monkeypatch.setenv("BROWSER_RENDERING_ACCOUNT_ID", ACCOUNT_ID)
        monkeypatch.setenv("BROWSER_RENDERING_TOKEN", TOKEN)

        async def _fake(cfg, html):
            return b'{"success":false,"errors":[{"message":"nope"}]}'

        monkeypatch.setattr(files_api, "_render_pdf_via_rest", _fake)
        with pytest.raises(HTTPException) as ei:
            await files_api.render_doc_pdf(5, _body(), _auth(), object())
        assert ei.value.status_code == 502
        assert ei.value.detail["code"] == "PDF_RENDER_FAILED"
        assert archived.creates == []

    async def test_oversized_pdf_is_422(self, archived, monkeypatch):
        monkeypatch.setenv("BROWSER_RENDERING_ACCOUNT_ID", ACCOUNT_ID)
        monkeypatch.setenv("BROWSER_RENDERING_TOKEN", TOKEN)

        async def _fake(cfg, html):
            return b"%PDF-" + b"0" * MAX_RENDER_PDF_BYTES

        monkeypatch.setattr(files_api, "_render_pdf_via_rest", _fake)
        with pytest.raises(HTTPException) as ei:
            await files_api.render_doc_pdf(5, _body(), _auth(), object())
        assert ei.value.status_code == 422
        assert ei.value.detail["code"] == "FILE_TOO_LARGE"
        assert archived.creates == []

    async def test_happy_path_archives_as_render_pdf_with_supersede(self, archived, monkeypatch):
        monkeypatch.setenv("BROWSER_RENDERING_ACCOUNT_ID", ACCOUNT_ID)
        monkeypatch.setenv("BROWSER_RENDERING_TOKEN", TOKEN)

        async def _fake(cfg, html):
            assert html == GOOD_HTML          # 送出去的必须是"预览同源"的那份
            return PDF_BYTES

        monkeypatch.setattr(files_api, "_render_pdf_via_rest", _fake)
        out = await files_api.render_doc_pdf(5, _body(name="PI-2026-001 系统版"),
                                             _auth(), object())

        assert out["renderer"] == "rest"
        assert out["bytes"] == len(PDF_BYTES)
        assert out["storage"] == "s3"
        # 落档口径：kind=render_pdf + supersede=True（新版本上位、旧版留档）+ 只收 pdf
        assert len(archived.creates) == 1
        create = archived.creates[0]
        assert create["kind"] == "render_pdf"
        assert create["supersede"] is True
        assert create["content_type"] == "application/pdf"
        assert create["content"] == PDF_BYTES
        assert create["owner_type"] == "trade_doc"
        assert create["owner_id"] == "5"
        assert create["name"] == "PI-2026-001 系统版"
        # 挂到单证上时 role 必须也是 render_pdf（attach_doc_file 靠它做版本让位）
        assert archived.links == [{"doc_id": 5, "file_id": 77, "role": "render_pdf"}]

    async def test_default_name_used_when_blank(self, archived, monkeypatch):
        monkeypatch.setenv("BROWSER_RENDERING_ACCOUNT_ID", ACCOUNT_ID)
        monkeypatch.setenv("BROWSER_RENDERING_TOKEN", TOKEN)

        async def _fake(cfg, html):
            return PDF_BYTES

        monkeypatch.setattr(files_api, "_render_pdf_via_rest", _fake)
        await files_api.render_doc_pdf(5, _body(name="   "), _auth(), object())
        assert archived.creates[0]["name"] == "单证 5 系统 PDF"
