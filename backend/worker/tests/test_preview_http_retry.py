"""TODO D7：preview ensure 对 Neon 423/429 的有限重试（`scripts/preview/preview_lib.py`）。

背景（2026-10-20 PR #5 实测）：Neon 分支刚创建时立刻建 endpoint / 取连接串，会收到
`HTTP 423 project already has running conflicting operations`；旧实现直接失败，
靠 CI rerun 到 attempt 3 才绿。修复口径（TODO D7）：
- 只重试 **423/429**（请求被拒/未执行，重试安全）；5xx 不重试（可能已生效）；
- 有限次 + 指数退避（可被 `PREVIEW_HTTP_BACKOFF` 覆盖为 0 秒方便测试）。

本测试只覆盖纯逻辑与重试路径，不发真实网络请求。
"""
from __future__ import annotations

import importlib.util
import io
import sys
import urllib.error
from email.message import Message
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

_REPO = Path(__file__).resolve().parents[3]
_MODULE_PATH = _REPO / "scripts" / "preview" / "preview_lib.py"


def _load_preview_lib():
    spec = importlib.util.spec_from_file_location("kaas_preview_lib", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    sys.modules["kaas_preview_lib"] = module
    spec.loader.exec_module(module)
    return module


preview_lib = _load_preview_lib()


class _FakeResponse:
    def __init__(self, status: int, body: bytes):
        self.status = status
        self._body = body

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def _http_error(url: str, code: int, body: bytes = b'{"error":"locked"}',
                retry_after: str | None = None) -> urllib.error.HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError(url, code, "err", headers, io.BytesIO(body))


def test_retry_plan_defaults_and_clamping(monkeypatch):
    monkeypatch.delenv("PREVIEW_HTTP_RETRIES", raising=False)
    monkeypatch.delenv("PREVIEW_HTTP_BACKOFF", raising=False)
    assert preview_lib.retry_plan() == (4, 2.0)

    monkeypatch.setenv("PREVIEW_HTTP_RETRIES", "99")
    monkeypatch.setenv("PREVIEW_HTTP_BACKOFF", "999")
    assert preview_lib.retry_plan() == (10, 30.0)

    monkeypatch.setenv("PREVIEW_HTTP_RETRIES", "-3")
    monkeypatch.setenv("PREVIEW_HTTP_BACKOFF", "-1")
    assert preview_lib.retry_plan() == (0, 0.0)


def test_retry_delay_prefers_retry_after_and_caps(monkeypatch):
    exc = _http_error("https://example.test", 423, retry_after="7")
    assert preview_lib.retry_delay(0, 2.0, exc) == 7.0
    exc_huge = _http_error("https://example.test", 429, retry_after="600")
    assert preview_lib.retry_delay(0, 2.0, exc_huge) == 20.0
    # 无 Retry-After ⇒ 指数退避 2/4/8/16，封顶 20
    assert [preview_lib.retry_delay(i, 2.0) for i in range(5)] == [2.0, 4.0, 8.0, 16.0, 20.0]


def test_http_json_retries_423_then_succeeds(monkeypatch):
    monkeypatch.setenv("PREVIEW_HTTP_RETRIES", "3")
    monkeypatch.setenv("PREVIEW_HTTP_BACKOFF", "0")
    calls = {"n": 0}

    def fake_urlopen(req, timeout=60):
        calls["n"] += 1
        if calls["n"] <= 2:
            raise _http_error(req.full_url, 423)
        return _FakeResponse(200, b'{"ok": true}')

    monkeypatch.setattr(preview_lib.urllib.request, "urlopen", fake_urlopen)
    status, body = preview_lib.http_json("POST", "https://example.test/endpoints")
    assert (status, body) == (200, {"ok": True})
    assert calls["n"] == 3  # 两次 423 + 一次成功


def test_http_json_gives_up_after_retry_budget(monkeypatch):
    monkeypatch.setenv("PREVIEW_HTTP_RETRIES", "2")
    monkeypatch.setenv("PREVIEW_HTTP_BACKOFF", "0")
    calls = {"n": 0}

    def fake_urlopen(req, timeout=60):
        calls["n"] += 1
        raise _http_error(req.full_url, 429, body=b'{"error":"rate limited"}')

    monkeypatch.setattr(preview_lib.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(preview_lib.PreviewError) as excinfo:
        preview_lib.http_json("GET", "https://example.test/branches")
    assert "HTTP 429" in str(excinfo.value)
    assert calls["n"] == 3  # 首次 + 2 次重试后放弃


def test_http_json_does_not_retry_non_retryable(monkeypatch):
    monkeypatch.setenv("PREVIEW_HTTP_RETRIES", "5")
    monkeypatch.setenv("PREVIEW_HTTP_BACKOFF", "0")
    calls = {"n": 0}

    def fake_urlopen(req, timeout=60):
        calls["n"] += 1
        raise _http_error(req.full_url, 400, body=b'{"error":"bad request"}')

    monkeypatch.setattr(preview_lib.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(preview_lib.PreviewError):
        preview_lib.http_json("POST", "https://example.test/bad")
    assert calls["n"] == 1  # 400 立即失败
