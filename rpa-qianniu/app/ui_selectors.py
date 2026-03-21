from __future__ import annotations

import json
import logging
from dataclasses import dataclass, fields, replace
from pathlib import Path
from typing import Any

from app.config import settings

log = logging.getLogger("ui_selectors")


@dataclass
class UISelectors:
    """UI 定位参数：可由 config/selectors.json 覆盖，减少改 Python 的频率。"""

    window_title_substrings: list[str]
    session_left_panel_ratio: float
    unread_markers: list[str]
    buyer_bubble_offset_px: float
    input_bottom_margin_px: int
    input_pool_bottom_margin_px: int
    tree_walk_max_depth: int
    send_button_include_substrings: list[str]
    send_button_exclude_substrings: list[str]


def _builtin_defaults() -> UISelectors:
    return UISelectors(
        window_title_substrings=[],
        session_left_panel_ratio=0.48,
        unread_markers=["未读"],
        buyer_bubble_offset_px=24.0,
        input_bottom_margin_px=220,
        input_pool_bottom_margin_px=260,
        tree_walk_max_depth=28,
        send_button_include_substrings=["发送"],
        send_button_exclude_substrings=["图片", "表情"],
    )


def _merge_dict(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in overlay.items():
        if k not in out:
            continue
        if type(out[k]) is type(v) or v is None:
            out[k] = v
            continue
        if isinstance(out[k], list) and isinstance(v, list):
            out[k] = v
    return out


_cached: UISelectors | None = None


def load_selectors() -> UISelectors:
    """从磁盘加载并与内置默认值合并；window_title_substrings 为空时用 .env 单字符串。"""
    builtin = _builtin_defaults()
    base = {f.name: getattr(builtin, f.name) for f in fields(UISelectors)}
    path = Path(settings.selectors_path)
    if path.exists():
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                base = _merge_dict(base, raw)
        except Exception as exc:
            log.warning("选择器文件解析失败，使用内置默认: %s | %s", path, exc)
    try:
        sel = UISelectors(**base)
    except Exception as exc:
        log.warning("选择器字段类型异常，回退内置默认: %s", exc)
        sel = _builtin_defaults()
    ratio = float(sel.session_left_panel_ratio)
    ratio = max(0.05, min(0.95, ratio))
    sel = replace(sel, session_left_panel_ratio=ratio)
    depth = int(sel.tree_walk_max_depth)
    depth = max(6, min(60, depth))
    sel = replace(sel, tree_walk_max_depth=depth)
    if not sel.window_title_substrings:
        sub = settings.qianniu_window_substring.strip()
        if sub:
            sel = replace(sel, window_title_substrings=[sub])
    if not sel.unread_markers:
        sel = replace(sel, unread_markers=["未读"])
    if not sel.send_button_include_substrings:
        sel = replace(sel, send_button_include_substrings=["发送"])
    return sel


def get_selectors() -> UISelectors:
    global _cached
    if _cached is None:
        _cached = load_selectors()
        log.info("已加载 UI 选择器: %s", settings.selectors_path)
    return _cached


def reload_selectors() -> None:
    global _cached
    _cached = None
