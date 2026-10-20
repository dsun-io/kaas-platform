"""A4：默认公章与产品图在装配层改成「短期签名直链」的回归测试。

覆盖
----
1. `main._apply_default_seal`：有 JWT_SECRET 时写 URL（不再 data URI）；无密钥时回退内核
   data URI；单据显式给 `company_stamp` 时**不查库、不覆盖**。
2. 用同一令牌调用 `ws_seals.get_seal_render_content` 能取回 PNG 字节（真回环，
   不是只看字符串前缀）。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

main = load_main()

import ws_files  # noqa: E402
import ws_seals  # noqa: E402
from fastapi import HTTPException  # noqa: E402
from kaas_common.files import verify_asset_token  # noqa: E402

PNG = b"\x89PNG-default-seal"


def _run(coro):
    return asyncio.run(coro)


class _Env:
    def __init__(self, bindings):
        self.__dict__.update(bindings)


class _Url:
    def __init__(self, scheme):
        self.scheme = scheme


class _Req:
    def __init__(self, bindings, host="kaas.example.com", scheme="https"):
        self.scope = {"env": _Env(bindings)}
        self.headers = {"host": host}
        self.url = _Url(scheme)


class _DB:
    def __init__(self, row):
        self.row = row
        self.calls = 0

    async def fetchrow(self, request, sql, *params, table=None):
        self.calls += 1
        return self.row


@pytest.fixture
def seal_db(monkeypatch):
    db = _DB({"id": 3, "png_bytes": PNG, "mime": "image/png"})
    monkeypatch.setattr(main, "db", db)
    return db


def test_default_seal_uses_signed_url_when_secret_present(seal_db):
    req = _Req({"JWT_SECRET": "s3cret"})
    data = {}
    out = _run(main._apply_default_seal(req, {"tenant_id": "default"}, data, {}))

    url = out["company_stamp"]
    assert url.startswith("https://kaas.example.com/api/v1/tenant/company-seals/3/render-content?t=")
    token = url.split("t=", 1)[1]
    assert verify_asset_token("s3cret", "seal", 3, token)
    assert not url.startswith("data:")


def test_default_seal_falls_back_to_data_uri_without_secret(seal_db, monkeypatch):
    monkeypatch.delenv("JWT_SECRET", raising=False)
    req = _Req({"JWT_SECRET": ""})
    out = _run(main._apply_default_seal(req, {"tenant_id": "default"}, {}, {}))

    assert out["company_stamp"].startswith("data:image/png;base64,")


def test_seal_signed_url_roundtrips_bytes(monkeypatch):
    row = {"id": 3, "png_bytes": PNG, "mime": "image/png"}

    class _Conn:
        async def fetchrow(self, sql, *params):
            return row

    class _Acquire:
        def __init__(self):
            pass

        async def __aenter__(self):
            return _Conn()

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(ws_seals, "_acquire", lambda request: _Acquire())
    req = _Req({"JWT_SECRET": "s3cret"})
    url = ws_files._asset_url(req, "seal", 3)
    token = url.split("t=", 1)[1]

    resp = _run(ws_seals.get_seal_render_content(req, 3, t=token))
    assert resp.status_code == 200
    assert resp.body == PNG


def test_seal_render_content_rejects_wrong_id(monkeypatch):
    req = _Req({"JWT_SECRET": "s3cret"})
    token = ws_files._asset_url(req, "seal", 3).split("t=", 1)[1]
    with pytest.raises(HTTPException) as exc:
        _run(ws_seals.get_seal_render_content(req, 4, t=token))
    assert exc.value.status_code == 401
