"""A4 渲染资源令牌（`kaas_common.files.token`）的纯函数单测。

为什么单独测
------------
该令牌是「渲染图片直链」的唯一授权手段：`<img>` 带不了 Authorization 头，只能靠
查询串令牌。它就是这层的信任边界 —— 过期、篡改、跨用途/跨资源重放都必须被拒。
纯标准库 + 注入 `now` ⇒ 快、确定、无网络。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()  # 装好 workers stub 并把 `src/` 放进 sys.path（与其它 worker 测试同口径）

from kaas_common.files import make_asset_token, verify_asset_token  # noqa: E402

SECRET = "unit-test-secret"


def test_roundtrip_and_reuse_for_same_purpose_and_ref():
    token = make_asset_token(SECRET, "file", 7, ttl=900, now=1_000_000)
    assert verify_asset_token(SECRET, "file", 7, token, now=1_000_000)
    assert verify_asset_token(SECRET, "file", 7, token, now=1_000_899)


def test_expires_after_ttl():
    token = make_asset_token(SECRET, "file", 7, ttl=900, now=1_000_000)
    assert not verify_asset_token(SECRET, "file", 7, token, now=1_000_901)


def test_rejects_tampered_expiry_and_signature():
    token = make_asset_token(SECRET, "file", 7, ttl=900, now=1_000_000)
    exp, sig = token.split(".", 1)
    assert not verify_asset_token(SECRET, "file", 7, f"{int(exp) + 86400}.{sig}", now=1_000_000)
    assert not verify_asset_token(SECRET, "file", 7, f"{exp}.{'0' * 64}", now=1_000_000)


def test_binds_purpose_and_ref_id():
    token = make_asset_token(SECRET, "file", 7, ttl=900, now=1_000_000)
    assert not verify_asset_token(SECRET, "file", 8, token, now=1_000_000)
    assert not verify_asset_token(SECRET, "seal", 7, token, now=1_000_000)


def test_rejects_wrong_secret_and_malformed_tokens():
    token = make_asset_token(SECRET, "file", 7, ttl=900, now=1_000_000)
    assert not verify_asset_token("other-secret", "file", 7, token, now=1_000_000)
    for bad in ("", "nodot", "abc.def", "1700000000.", ".abc"):
        assert not verify_asset_token(SECRET, "file", 7, bad, now=1_000_000)


def test_empty_secret_cannot_sign():
    with pytest.raises(ValueError):
        make_asset_token("", "file", 7)
