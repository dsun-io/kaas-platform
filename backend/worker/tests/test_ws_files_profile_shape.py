"""`ws_files.get_profile` 的**形状防御**单测。

背景（2026-10-12）
------------------
`product_profiles.info` 是 jsonb。登记进 dbjson 之后，`db.fetchrow(..., table="product_profiles")`
会把它解码成 dict；但**漏登记 / 未来新增的读取点**可能拿到 **JSON 字符串** —— 那时
`dict(row["info"])` 会抛 `ValueError` ⇒ 一个只读探针把整个产品页打成 500。
根因已由 dbjson 登记修复；本文件钉住的是**防御**：两种形状都收，坏值回落 `{}` 而不是 500。

判定很窄，但回归代价高：`get_profile` 是 `/products` 页首屏的必调接口，
它 500 会让整页白掉，而"info 是字符串"这种形状只会在特定数据/路径下出现 —— 没有测试就没人会发现。
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

load_main()

import ws_files  # noqa: E402


TEAM = 11


class _FakeDb:
    def __init__(self, row):
        self._row = row

    async def fetchrow(self, request, sql, *args, table=None):
        row = self._row
        # 读路径自 task-24 起要判团队（Q6）⇒ 假行也补上 team_id；
        # 这些用例考的是 `info` 的形状（dict / JSON 字符串 / 坏值），不是权限。
        if row is not None and "team_id" not in row:
            row = {**row, "team_id": TEAM}
        return row


def _get_profile(row):
    return asyncio.run(ws_files.get_profile(
        "field_fence", object(), {"id": 1, "role": "user", "team_id": TEAM}))


def _with_row(monkeypatch, row):
    monkeypatch.setattr(ws_files, "db", _FakeDb(row))


def test_dict_shape_passes_through(monkeypatch):
    _with_row(monkeypatch, {"info": {"material": "Q235"}, "updated_at": None})
    out = _get_profile(None)
    assert out["info"] == {"material": "Q235"}


def test_json_string_shape_is_parsed_not_500(monkeypatch):
    """**这就是那个 500**：`dict('{"material": "Q235"}')` 会抛 ValueError。"""
    _with_row(monkeypatch, {"info": json.dumps({"material": "Q235"}), "updated_at": None})
    out = _get_profile(None)
    assert out["info"] == {"material": "Q235"}


def test_corrupt_string_falls_back_to_empty_dict(monkeypatch):
    _with_row(monkeypatch, {"info": "{not json", "updated_at": None})
    out = _get_profile(None)
    assert out["info"] == {}


def test_non_dict_json_falls_back_to_empty_dict(monkeypatch):
    for value in ('["a", "b"]', '"just a string"', "42"):
        _with_row(monkeypatch, {"info": value, "updated_at": None})
        assert _get_profile(None)["info"] == {}


def test_missing_row_and_missing_key(monkeypatch):
    _with_row(monkeypatch, None)
    assert _get_profile(None)["info"] == {}
    _with_row(monkeypatch, {"updated_at": None})
    assert _get_profile(None)["info"] == {}
