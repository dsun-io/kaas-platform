"""S5 预览 PR_SLUG 前缀：Worker 侧行为单测。

测的是「ws_files 的三个 key 生成点共用 `_prefixed_key`」与「/health 回显预览探针」
两条链路；_binding 一律 monkeypatch（与 test_ws_files_storage.py 同路数，不碰网络/库）。

生产零影响口径：PR_SLUG 未注入（_binding 返回 ""）⇒ 前缀为空、/health 无 preview 字段。
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

main = load_main()

import ws_files as wsf  # noqa: E402  load_main 之后再 import，路由挂在同一 app 上

pytestmark = pytest.mark.unit

KEY = "t/default/product/7/product_photo/size/ab12cd34ef56.jpg"


@pytest.fixture
def fake_binding(monkeypatch):
    """把 main._binding 换成可控假实现（只认 PR_SLUG，其余照旧走空串）。"""
    state = {"PR_SLUG": ""}

    def _fake(key: str, request=None):
        return state.get(key, "")

    monkeypatch.setattr(wsf._main, "_binding", _fake)
    return state


class TestPrefixedKey:
    def test_production_no_prefix(self, fake_binding):
        fake_binding["PR_SLUG"] = ""
        assert wsf._prefixed_key(KEY, None) == KEY

    def test_unset_means_production(self, fake_binding):
        fake_binding.pop("PR_SLUG")
        assert wsf._prefixed_key(KEY, None) == KEY

    def test_preview_prefix(self, fake_binding):
        fake_binding["PR_SLUG"] = "42"
        assert wsf._prefixed_key(KEY, None) == "pr-42/" + KEY

    def test_dirty_slug_degrades_to_production(self, fake_binding):
        # 脏值宁可退回无前缀（防写错前缀污染桶）
        fake_binding["PR_SLUG"] = "../../etc"
        assert wsf._prefixed_key(KEY, None) == KEY


class TestHealthPreviewProbe:
    def test_no_slug_no_preview_field(self, fake_binding):
        fake_binding["PR_SLUG"] = ""
        import asyncio
        body = asyncio.run(main.health())
        assert "preview" not in body
        assert body["status"] == "ok"

    def test_slug_reported(self, fake_binding):
        fake_binding["PR_SLUG"] = "42"
        import asyncio
        body = asyncio.run(main.health())
        assert body.get("preview") == {"pr_slug": "42"}
