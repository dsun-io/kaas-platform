from __future__ import annotations

import random
import time
from typing import Callable, Iterator

import uiautomation as auto

from app.config import settings
from app.message_parser import extract_time_token, is_system_message
from app.ui_selectors import get_selectors

Control = auto.Control


def human_delay() -> None:
    low = max(0, settings.action_delay_ms_min)
    high = max(low, settings.action_delay_ms_max)
    time.sleep(random.uniform(low, high) / 1000.0)


def _walk(ctrl: Control, depth: int = 0, max_depth: int | None = None) -> Iterator[Control]:
    if max_depth is None:
        max_depth = get_selectors().tree_walk_max_depth
    if depth > max_depth:
        return
    yield ctrl
    child = ctrl.GetFirstChildControl()
    while child:
        yield from _walk(child, depth + 1, max_depth)
        child = child.GetNextSiblingControl()


def _iter_top_level_windows(root: Control) -> Iterator[Control]:
    for c in root.GetChildren():
        try:
            if c.ControlType == auto.ControlType.WindowControl:
                yield c
        except Exception:
            continue


def locate_main_window_once() -> Control | None:
    sel = get_selectors()
    subs = [s.strip() for s in sel.window_title_substrings if s and str(s).strip()]
    if not subs:
        return None
    try:
        root = auto.GetRootControl()
    except Exception:
        return None
    best: Control | None = None
    for w in _iter_top_level_windows(root):
        try:
            name = w.Name or ""
            if not any(s in name for s in subs):
                continue
            if not w.IsEnabled:
                continue
            best = w
        except Exception:
            continue
    return best


def locate_main_window_with_retry(
    *,
    on_attempt: Callable[[int, Control | None], None] | None = None,
) -> Control | None:
    retries = max(1, settings.window_locate_retries)
    interval = max(0.5, settings.window_locate_interval_sec)
    last: Control | None = None
    for i in range(retries):
        last = locate_main_window_once()
        if on_attempt:
            try:
                on_attempt(i + 1, last)
            except Exception:
                pass
        if last is not None:
            return last
        time.sleep(interval)
    return None


def window_alive(win: Control | None) -> bool:
    if win is None:
        return False
    try:
        _ = win.BoundingRectangle
        if not win.Exists(0.2, 0.05):
            return False
        return True
    except Exception:
        return False


def list_session_list_items(win: Control) -> list[Control]:
    sel = get_selectors()
    items: list[Control] = []
    try:
        wr = _win_rect(win)
        ratio = min(0.95, max(0.05, float(sel.session_left_panel_ratio)))
        left_cut = wr.left + (wr.right - wr.left) * ratio
    except Exception:
        left_cut = None
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if c.ControlType == auto.ControlType.ListItemControl:
                name = (c.Name or "").strip()
                if name:
                    if left_cut is not None:
                        r = c.BoundingRectangle
                        if r.left > left_cut:
                            continue
                    items.append(c)
        except Exception:
            continue
    dedup: dict[int, Control] = {}
    for it in items:
        try:
            dedup[id(it)] = it
        except Exception:
            continue
    return list(dedup.values())


def item_has_unread(item: Control) -> bool:
    sel = get_selectors()
    try:
        for c in _walk(item, max_depth=8):
            n = c.Name or ""
            for marker in sel.unread_markers:
                if marker and str(marker) in n:
                    return True
    except Exception:
        return False
    return False


def session_display_name(item: Control) -> str:
    try:
        return (item.Name or "").strip()
    except Exception:
        return ""


def select_session(item: Control) -> None:
    human_delay()
    try:
        item.SetFocus()
    except Exception:
        pass
    human_delay()
    try:
        item.Click(simulateMove=False)
    except Exception:
        try:
            item.Invoke()
        except Exception:
            pass
    human_delay()


def _win_rect(win: Control) -> auto.Rect:
    return win.BoundingRectangle


def _center_x(rect: auto.Rect) -> float:
    return (rect.left + rect.right) / 2.0


def _is_likely_buyer_bubble(rect: auto.Rect, win: Control) -> bool:
    sel = get_selectors()
    wr = _win_rect(win)
    mid = (wr.left + wr.right) / 2.0
    off = float(sel.buyer_bubble_offset_px)
    return _center_x(rect) < mid - off


def _is_probably_input(ctrl: Control, win: Control) -> bool:
    try:
        sel = get_selectors()
        if ctrl.ControlType != auto.ControlType.EditControl:
            return False
        r = ctrl.BoundingRectangle
        wr = _win_rect(win)
        margin = int(sel.input_bottom_margin_px)
        return r.bottom > wr.bottom - margin
    except Exception:
        return False


def _text_from(ctrl: Control) -> str:
    try:
        la = ctrl.GetLegacyIAccessiblePattern()
        if la:
            v = la.Value
            if v and str(v).strip():
                return str(v).strip()
    except Exception:
        pass
    try:
        n = (ctrl.Name or "").strip()
        return n
    except Exception:
        return ""


def read_latest_buyer_message(win: Control) -> tuple[str | None, str | None]:
    """
    从当前会话区域读取「最近一条」疑似买家（左侧气泡）文本。
    千牛版本差异大：若取不到，返回 (None, None)，由上层跳过。
    """
    sel = get_selectors()
    human_delay()
    candidates: list[tuple[float, str]] = []
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if _is_probably_input(c, win):
                continue
            if c.ControlType not in (
                auto.ControlType.TextControl,
                auto.ControlType.DocumentControl,
            ):
                continue
            t = _text_from(c)
            if not t or len(t) < 1:
                continue
            r = c.BoundingRectangle
            if not _is_likely_buyer_bubble(r, win):
                continue
            candidates.append((float(r.bottom), t))
        except Exception:
            continue

    if not candidates:
        for c in _walk(win, max_depth=sel.tree_walk_max_depth):
            try:
                if _is_probably_input(c, win):
                    continue
                if c.ControlType != auto.ControlType.TextControl:
                    continue
                t = _text_from(c)
                if not t:
                    continue
                r = c.BoundingRectangle
                candidates.append((float(r.bottom), t))
            except Exception:
                continue

    if not candidates:
        return None, None

    candidates.sort(key=lambda x: x[0])

    for _, text in reversed(candidates):
        if is_system_message(text):
            continue
        return text, extract_time_token(text)
    return None, None


def find_input_control(win: Control) -> Control | None:
    sel = get_selectors()
    edits: list[Control] = []
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if c.ControlType == auto.ControlType.EditControl:
                edits.append(c)
        except Exception:
            continue
    if not edits:
        return None
    wr = _win_rect(win)
    pool_margin = int(sel.input_pool_bottom_margin_px)

    def bottom_score(e: Control) -> float:
        try:
            return float(e.BoundingRectangle.bottom)
        except Exception:
            return 0.0

    near_bottom = [e for e in edits if e.BoundingRectangle.bottom > wr.bottom - pool_margin]
    pool = near_bottom or edits
    return max(pool, key=bottom_score)


def find_send_button(win: Control) -> Control | None:
    sel = get_selectors()
    best: Control | None = None
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if c.ControlType != auto.ControlType.ButtonControl:
                continue
            n = (c.Name or "").strip()
            incs = [x for x in sel.send_button_include_substrings if x]
            excs = [x for x in sel.send_button_exclude_substrings if x]
            if incs and not any(x in n for x in incs):
                continue
            if any(x in n for x in excs):
                continue
            if best is None:
                best = c
                continue
            if c.BoundingRectangle.bottom > best.BoundingRectangle.bottom:
                best = c
        except Exception:
            continue
    return best
