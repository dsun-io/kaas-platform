from __future__ import annotations

import random
import re
import time
from typing import Callable, Iterator

import numpy as np
import uiautomation as auto

from app.chat_bounds import ChatPanelScreen, rect_center_in_panel, rect_overlap_panel
from app.config import settings
from app.message_parser import (
    extract_time_token,
    has_substantive_buyer_text,
    is_non_message_ui_text,
    is_system_message,
)

from app.ui_selectors import get_selectors
from app.vision_markers import session_row_visual_unread, vision_available
from app.window_capture import grab_screen_bgr

Control = auto.Control

# 聊天主输入区几何：中间会话区 + 输入条；右侧「足迹/推荐」里的「发送链接」必须排除
_COMPOSE_EDIT_MIN_WIDTH_PX = 120
_COMPOSE_MAX_CENTER_X_RATIO = 0.52  # 输入框中心须在主聊天列，勿落到右侧推荐栏
_SEND_BAND_ABOVE_EDIT_PX = 52
_SEND_BAND_BELOW_EDIT_PX = 128
# 发送键相对输入框：允许略靠右，但不可跳到右侧栏（发送链接）
_SEND_BTN_MAX_RIGHT_OF_EDIT_PX = 200
# 主窗口底部输入条：底缘贴窗体底边，且整块不能太高（居中「商品搜索」弹窗排除）
_COMPOSE_MAX_GAP_FROM_WINDOW_BOTTOM_PX = 88
_COMPOSE_MAX_HEIGHT_RATIO = 0.42
_COMPOSE_EDIT_MAX_HEIGHT_PX = 260
# 宽松策略：底栏略高、仍排除中层搜索弹窗
_RELAX_COMPOSE_MAX_GAP_FROM_BOTTOM_PX = 120
_RELAX_COMPOSE_MAX_HEIGHT_RATIO = 0.52
_RELAX_EDIT_MAX_HEIGHT_PX = 280
# 输入框/气泡中心勿落入窗口最右 1/3（商品/推荐侧栏）
_RIGHT_PANEL_EXCLUDE_RATIO = 1.0 / 3.0


def _edit_in_bottom_compose_zone(r: auto.Rect, wr: auto.Rect) -> bool:
    """聊天输入条：紧贴主窗底缘，且竖直范围落在窗体下半的一条窄带（排除中层商品搜索弹窗）。"""
    wh = max(1.0, float(wr.bottom - wr.top))
    gap = float(wr.bottom - r.bottom)
    if gap < -10.0 or gap > float(_COMPOSE_MAX_GAP_FROM_WINDOW_BOTTOM_PX):
        return False
    min_top = wr.bottom - min(360.0, max(200.0, wh * _COMPOSE_MAX_HEIGHT_RATIO))
    if float(r.top) < min_top:
        return False
    eh = float(r.bottom - r.top)
    if eh > float(_COMPOSE_EDIT_MAX_HEIGHT_PX):
        return False
    return True


def _edit_in_bottom_compose_zone_relaxed(r: auto.Rect, wr: auto.Rect) -> bool:
    """策略 A 宽松：窗口底部约 20% 竖带内、仍排除过高的中层 Edit。"""
    wh = max(1.0, float(wr.bottom - wr.top))
    gap = float(wr.bottom - r.bottom)
    if gap < -12.0 or gap > float(_RELAX_COMPOSE_MAX_GAP_FROM_BOTTOM_PX):
        return False
    min_top = wr.bottom - min(420.0, max(220.0, wh * _RELAX_COMPOSE_MAX_HEIGHT_RATIO))
    if float(r.top) < min_top:
        return False
    eh = float(r.bottom - r.top)
    if eh > float(_RELAX_EDIT_MAX_HEIGHT_PX):
        return False
    return True


def _compose_edit_max_center_x(wr: auto.Rect, edge: float, ratio: float) -> float:
    span = max(1.0, float(wr.right - edge))
    return edge + span * ratio


def _edit_center_excludes_right_third(r: auto.Rect, wr: auto.Rect) -> bool:
    cx = (float(r.left) + float(r.right)) / 2.0
    limit = float(wr.left) + (float(wr.right) - float(wr.left)) * (1.0 - _RIGHT_PANEL_EXCLUDE_RATIO)
    return cx < limit - 4.0


def _bubble_max_right_x(win: Control) -> float:
    """聊天气泡右缘上限：聊天列左段，减少扫到右侧商品/订单条。"""
    wr = _win_rect(win)
    edge = _session_list_right_edge(win)
    span = max(1.0, float(wr.right - edge))
    return edge + span * 0.68


def _button_near_bottom_toolbar(r: auto.Rect, wr: auto.Rect) -> bool:
    """发送键与输入条同一底栏，排除对话框中部按钮。"""
    gap = float(wr.bottom - r.bottom)
    return -20.0 <= gap <= 170.0


def _is_product_or_sidebar_send_button(name: str) -> bool:
    """名称含「发送」但实为发商品/发链接（右侧推荐区），不是聊天文字发送。"""
    n = (name or "").strip()
    if not n:
        return False
    if n == "发送":
        return False
    block = ("链接", "卡片", "宝贝", "商品", "足迹", "优惠券", "红包", "邀请下单", "下单")
    return any(b in n for b in block)


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


def _window_title_score(name: str) -> int:
    """多窗口同时存在时，优先「接待中心」独立窗，其次旺旺/消息，最后才是千牛工作台。"""
    n = name or ""
    s = 0
    if "接待中心" in n:
        s += 50
    if "旺旺" in n:
        s += 40
    if "接待" in n:
        s += 35
    if "聊天" in n or "对话" in n:
        s += 30
    if "消息" in n:
        s += 18
    if "工作台" in n:
        s += 8
    if "千牛" in n:
        s += 5
    return s


def locate_window_title_hint() -> str:
    """定位失败时在终端打印的说明（标题匹配规则）。"""
    sel = get_selectors()
    subs = [s.strip() for s in sel.window_title_substrings if s and str(s).strip()]
    joined = "、".join(subs) if subs else "(未配置)"
    return (
        f"当前要求：顶层窗口「标题」中至少包含以下关键字之一：{joined}。\n"
        f"  修改方式：编辑 config/selectors.json 的 window_title_substrings，"
        f"或 .env 的 QIANNIU_WINDOW_SUBSTRING（会合并进列表）。\n"
        f"  请确认已打开千牛「接待中心」，并在任务栏点开该窗口后重试。\n"
        f"  若仍失败可设 WINDOW_LOCATE_SKIP_ENABLED_FILTER=true 再试（部分环境后台窗 IsEnabled 为 false）。"
    )


def locate_main_window_once() -> Control | None:
    sel = get_selectors()
    subs = [s.strip() for s in sel.window_title_substrings if s and str(s).strip()]
    if not subs:
        return None
    try:
        root = auto.GetRootControl()
    except Exception:
        return None
    matches: list[Control] = []
    for w in _iter_top_level_windows(root):
        try:
            name = w.Name or ""
            if not any(s in name for s in subs):
                continue
            if not settings.window_locate_skip_enabled_filter and not w.IsEnabled:
                continue
            matches.append(w)
        except Exception:
            continue
    if not matches:
        return None
    best: Control | None = None
    best_sc = -1
    for w in matches:
        try:
            sc = _window_title_score(w.Name or "")
            if sc > best_sc:
                best_sc = sc
                best = w
        except Exception:
            continue
    return best if best is not None else matches[-1]


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


_SESSION_ROW_TYPES = (
    auto.ControlType.ListItemControl,
    auto.ControlType.DataItemControl,
    auto.ControlType.TreeItemControl,
)


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
            if c.ControlType not in _SESSION_ROW_TYPES:
                continue
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


def capture_window_frame_bgr(win: Control) -> np.ndarray | None:
    """整窗截图 BGR，与视觉未读检测共用（每轮主循环只截一次）。"""
    try:
        wr = _win_rect(win)
        return grab_screen_bgr(int(wr.left), int(wr.top), int(wr.right), int(wr.bottom))
    except Exception:
        return None


_UNREAD_AUTOMATION_HINTS = (
    "unread",
    "badge",
    "count",
    "dot",
    "msgcount",
    "newmsg",
    "newmessage",
    "tip",
    "remind",
    "hongdian",
)


def _item_has_unread_uia(item: Control) -> bool:
    sel = get_selectors()
    try:
        for c in _walk(item, max_depth=8):
            n = c.Name or ""
            for marker in sel.unread_markers:
                if marker and str(marker) in n:
                    return True
            try:
                aid = (getattr(c, "AutomationId", None) or "").strip()
                al = aid.lower()
                for h in _UNREAD_AUTOMATION_HINTS:
                    if h in al:
                        return True
            except Exception:
                pass
        if sel.unread_badge_numeric:

            def _numeric_badge(ctrl: Control, depth: int) -> bool:
                if depth > 6:
                    return False
                try:
                    nn = (ctrl.Name or "").strip()
                    if nn.isdigit():
                        v = int(nn)
                        if 1 <= v <= 99:
                            return True
                except Exception:
                    pass
                ch = ctrl.GetFirstChildControl()
                while ch:
                    if _numeric_badge(ch, depth + 1):
                        return True
                    ch = ch.GetNextSiblingControl()
                return False

            return _numeric_badge(item, 0)
    except Exception:
        return False
    return False


def item_has_unread(
    win: Control,
    item: Control,
    frame_bgr: np.ndarray | None = None,
) -> bool:
    """
    未读判定：先 UIA（文案角标 / 数字），再可选地对会话行截图识别红点与「N秒」红条。
    frame_bgr 由主循环传入同一张整窗图，避免每个会话重复截图。
    """
    if _item_has_unread_uia(item):
        return True
    if not settings.vision_unread_enabled or not vision_available():
        return False
    img = frame_bgr
    if img is None:
        img = capture_window_frame_bgr(win)
    if img is None or img.size == 0:
        return False
    try:
        wr = _win_rect(win)
        ir = item.BoundingRectangle
        x0 = max(0, int(ir.left - wr.left))
        y0 = max(0, int(ir.top - wr.top))
        x1 = min(int(img.shape[1]), int(ir.right - wr.left))
        y1 = min(int(img.shape[0]), int(ir.bottom - wr.top))
        if x1 <= x0 + 2 or y1 <= y0 + 2:
            return False
        crop = img[y0:y1, x0:x1]
        return session_row_visual_unread(crop)
    except Exception:
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


def _session_list_right_edge(win: Control) -> float:
    """左侧会话列表与中间聊天列的分界 X（与 session_left_panel_ratio 一致）。"""
    sel = get_selectors()
    wr = _win_rect(win)
    ratio = min(0.95, max(0.05, float(sel.session_left_panel_ratio)))
    return wr.left + (wr.right - wr.left) * ratio


def _is_in_chat_message_area(rect: auto.Rect, win: Control) -> bool:
    """排除左侧列表、部分顶栏工具（分享/库存）所在区域，只认会话列表以右的聊天主列。"""
    edge = _session_list_right_edge(win)
    return rect.left >= edge - 12


def _chat_column_mid_x(win: Control) -> float:
    wr = _win_rect(win)
    edge = _session_list_right_edge(win)
    return (edge + wr.right) / 2.0


def _is_likely_buyer_bubble(rect: auto.Rect, win: Control) -> bool:
    """买家气泡在「中间聊天列」里靠左，而不是整窗中线（整窗中线会把左侧工具条误当气泡）。"""
    sel = get_selectors()
    off = float(sel.buyer_bubble_offset_px)
    mid = _chat_column_mid_x(win)
    return _center_x(rect) < mid - off


def _is_buyer_side_of_chat_column(rect: auto.Rect, win: Control) -> bool:
    """放宽：只要在聊天列左半边，仍排除会话列表（由 _is_in_chat_message_area 保证）。"""
    mid = _chat_column_mid_x(win)
    return _center_x(rect) < mid - 2.0


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


def _edit_under_blocked_subtree(edit: Control, max_up: int = 22) -> bool:
    """排除「商品搜索」等浮层/侧栏里的 Edit，避免打字打进搜索框。"""
    cur: Control | None = edit
    for _ in range(max_up):
        if cur is None:
            break
        try:
            n = (cur.Name or "").strip()
            try:
                cn = (getattr(cur, "ClassName", None) or "") or ""
                if isinstance(cn, str) and cn.strip():
                    cnl = cn.lower()
                    if "search" in cnl or "sousuo" in cnl:
                        return True
            except Exception:
                pass
            try:
                aid = (getattr(cur, "AutomationId", None) or "") or ""
                if isinstance(aid, str) and aid.strip():
                    al = aid.lower()
                    if "search" in al or "sousuo" in al or "productsearch" in al:
                        return True
            except Exception:
                pass
            if n:
                if n.strip() in ("搜索", "搜商品", "商品搜索"):
                    return True
                for bad in (
                    "商品搜索",
                    "搜索商品",
                    "搜商品",
                    "宝贝搜索",
                    "找宝贝",
                    "全局搜索",
                    "店内搜索",
                    "搜索宝贝",
                ):
                    if bad in n:
                        return True
                try:
                    if cur.ControlType == auto.ControlType.WindowControl and "搜索" in n and len(n) <= 22:
                        return True
                except Exception:
                    pass
            cur = cur.GetParentControl()
        except Exception:
            break
    return False


def is_blocked_non_chat_edit(edit: Control) -> bool:
    """True 表示该 Edit 在商品搜索等禁忌子树内，不可当聊天输入框。"""
    return _edit_under_blocked_subtree(edit)


def read_edit_value(ctrl: Control) -> str:
    """读取 Edit 当前文本（用于写入/发送校验）；读不到则返回空串。"""
    try:
        vp = ctrl.GetValuePattern()
        if vp is not None:
            v = vp.Value
            if v is not None and str(v).strip():
                return str(v).strip()
    except Exception:
        pass
    try:
        la = ctrl.GetLegacyIAccessiblePattern()
        if la is not None:
            v = la.Value
            if v is not None and str(v).strip():
                return str(v).strip()
    except Exception:
        pass
    try:
        n = (ctrl.Name or "").strip()
        return n
    except Exception:
        return ""


def _edit_is_readonly(ctrl: Control) -> bool:
    try:
        vp = ctrl.GetValuePattern()
        if vp is not None:
            return bool(vp.IsReadOnly)
    except Exception:
        pass
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


def guess_active_buyer_title(win: Control) -> str:
    """
    当前已打开会话标题（用于左侧列表无未读 UIA 时的兜底 buyer_id）。
    取窗口上部带状区域内的 TextControl，排除店铺/卖家昵称与常见 chrome。
    """
    sel = get_selectors()
    seller_hint = ""
    try:
        wn = (win.Name or "").strip()
        if "-" in wn:
            seller_hint = wn.split("-", 1)[0].strip()
    except Exception:
        pass
    chrome = (
        "千牛",
        "工作台",
        "接待",
        "消息",
        "店铺",
        "首页",
        "数据",
        "营销",
        "交易",
        "商品",
        "搜索",
        "发送",
        "推荐回复",
        "对方正在输入",
        "对方输入中",
        "在线",
        "离线",
        "已读",
        "未读",
        "待回复",
        "仓库",
        "库存",
        "分享",
    )
    try:
        wr = _win_rect(win)
        edge = _session_list_right_edge(win)
        band_bottom = wr.top + max(100.0, (wr.bottom - wr.top) * 0.28)
        best = ""
        best_score = -1
        for c in _walk(win, max_depth=min(sel.tree_walk_max_depth, 22)):
            try:
                if c.ControlType != auto.ControlType.TextControl:
                    continue
                t = _text_from(c).strip()
                if len(t) < 2 or len(t) > 64:
                    continue
                r = c.BoundingRectangle
                if r.left < edge - 24:
                    continue
                if r.top > band_bottom or r.bottom < wr.top + 20:
                    continue
                if seller_hint and (t == seller_hint or t.startswith(seller_hint + " ")):
                    continue
                if any(x in t for x in chrome):
                    continue
                # 右侧数据条：成交率、百分比等，不是买家名
                if "%" in t:
                    continue
                if re.fullmatch(r"\d+(?:\.\d+)?%?", t.replace(" ", "")):
                    continue
                if "成交" in t and re.search(r"\d", t):
                    continue
                if t.replace(".", "").replace(":", "").isdigit():
                    continue
                score = len(t)
                if "访客" in t or "用户" in t:
                    score += 220
                if "买家" in t:
                    score += 90
                if re.search(r"[￥¥]\s*\d", t):
                    continue
                if re.fullmatch(r"[\d.,\s]+", t):
                    continue
                if score > best_score:
                    best_score = score
                    best = t
            except Exception:
                continue
        return best if best else "active_chat"
    except Exception:
        return "active_chat"


def read_latest_buyer_message(
    win: Control,
    panel: ChatPanelScreen | None = None,
) -> tuple[str | None, str | None, float | None]:
    """
    从当前会话区域读取「最近一条」疑似买家（左侧气泡）文本。
    返回 (正文, 尾缀时间 token, 气泡底边 Y)；Y 用于与正文+时间一起区分同文新条。
    若提供 panel（OCR 锚定的聊天列），则忽略落在包围盒外的控件，减少订单/右侧栏误扫。
    """
    sel = get_selectors()
    human_delay()
    candidates: list[tuple[float, str]] = []
    _bubble_types = (
        auto.ControlType.TextControl,
        auto.ControlType.DocumentControl,
        auto.ControlType.CustomControl,
        auto.ControlType.GroupControl,
    )
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if _is_probably_input(c, win):
                continue
            if c.ControlType not in _bubble_types:
                continue
            t = _text_from(c).strip()
            if not t:
                continue
            if is_non_message_ui_text(t):
                continue
            if is_system_message(t):
                continue
            if c.ControlType in (
                auto.ControlType.CustomControl,
                auto.ControlType.GroupControl,
            ) and len(t) < 2:
                continue
            r = c.BoundingRectangle
            if not _is_in_chat_message_area(r, win):
                continue
            if float(r.right) > _bubble_max_right_x(win) + 6.0:
                continue
            if panel is not None and not rect_overlap_panel(r, panel):
                continue
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
                if c.ControlType not in _bubble_types:
                    continue
                t = _text_from(c).strip()
                if not t:
                    continue
                if is_non_message_ui_text(t):
                    continue
                if is_system_message(t):
                    continue
                r = c.BoundingRectangle
                if not _is_in_chat_message_area(r, win):
                    continue
                if float(r.right) > _bubble_max_right_x(win) + 6.0:
                    continue
                if panel is not None and not rect_overlap_panel(r, panel):
                    continue
                if not _is_buyer_side_of_chat_column(r, win):
                    continue
                candidates.append((float(r.bottom), t))
            except Exception:
                continue

    if not candidates:
        return None, None, None

    candidates.sort(key=lambda x: x[0])

    for bottom, raw_text in reversed(candidates):
        tt = (raw_text or "").strip()
        if not tt or is_non_message_ui_text(tt):
            continue
        if not has_substantive_buyer_text(tt):
            continue
        if is_system_message(tt):
            continue
        return tt, extract_time_token(tt), float(bottom)
    return None, None, None


def find_input_control(
    win: Control,
    panel: ChatPanelScreen | None = None,
) -> Control | None:
    """
    聊天主输入框：须同时满足贴主窗底缘的几何带 + 主列 + 非商品搜索子树。
    无合格候选时返回 None（不再回退到中层弹窗里的 Edit）。
    panel 有值时：几何中心须在 OCR 锚定的聊天列内，避免商品搜索等中层 Edit。
    """
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
    edge = _session_list_right_edge(win)
    span = max(1.0, float(wr.right - edge))
    max_cx = edge + span * _COMPOSE_MAX_CENTER_X_RATIO

    def in_compose_strip(e: Control) -> bool:
        try:
            if _edit_under_blocked_subtree(e):
                return False
            if _edit_is_readonly(e):
                return False
            r = e.BoundingRectangle
            if not _edit_in_bottom_compose_zone(r, wr):
                return False
            if r.left < edge - 6:
                return False
            w = float(r.right - r.left)
            if w < _COMPOSE_EDIT_MIN_WIDTH_PX:
                return False
            cx = (r.left + r.right) / 2.0
            if cx > max_cx:
                return False
            if panel is not None and not rect_center_in_panel(r, panel, margin=10):
                return False
            return True
        except Exception:
            return False

    primary = [e for e in edits if in_compose_strip(e)]
    unblocked = [e for e in edits if not _edit_under_blocked_subtree(e)]

    def _rect_bottom_ok(ctrl: Control) -> bool:
        try:
            return _edit_in_bottom_compose_zone(ctrl.BoundingRectangle, wr)
        except Exception:
            return False

    bottom_fallback = [e for e in unblocked if _rect_bottom_ok(e) and not _edit_under_blocked_subtree(e)]
    # 绝不回退到「仅 unblocked」或全体 edits：中层商品搜索会误选
    pool = primary if primary else bottom_fallback
    if not pool:
        return None

    def rank(e: Control) -> tuple[float, float, float]:
        try:
            r = e.BoundingRectangle
            w = max(0.0, float(r.right - r.left))
            bot = float(r.bottom)
            pri = 1e9 if e in primary else 0.0
            # 主聊天输入条一般贴窗口底边；浮层「商品搜索」常在中间或略高
            dist_bottom = abs(float(wr.bottom) - bot)
            bottom_bonus = max(0.0, 500.0 - min(dist_bottom, 500.0))
            return (pri + bottom_bonus * 1200.0 + w * 800.0 + bot, -dist_bottom, bot)
        except Exception:
            return (-1.0, 0.0, 0.0)

    return max(pool, key=rank)


def find_input_control_relaxed(
    win: Control,
    panel: ChatPanelScreen | None = None,
) -> Control | None:
    """
    策略 A 宽松：底部条 Edit + 中心点在主列且排除最右 1/3；仍禁止商品搜索子树。
    """
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
    edge = _session_list_right_edge(win)
    max_cx = min(
        _compose_edit_max_center_x(wr, edge, _COMPOSE_MAX_CENTER_X_RATIO + 0.06),
        float(wr.left) + (float(wr.right) - float(wr.left)) * (1.0 - _RIGHT_PANEL_EXCLUDE_RATIO) - 8.0,
    )

    def in_relaxed_strip(e: Control) -> bool:
        try:
            if _edit_under_blocked_subtree(e):
                return False
            if _edit_is_readonly(e):
                return False
            r = e.BoundingRectangle
            if not _edit_in_bottom_compose_zone_relaxed(r, wr):
                return False
            if not _edit_center_excludes_right_third(r, wr):
                return False
            if r.left < edge - 6:
                return False
            w = float(r.right - r.left)
            if w < _COMPOSE_EDIT_MIN_WIDTH_PX:
                return False
            cx = (float(r.left) + float(r.right)) / 2.0
            if cx > max_cx:
                return False
            if panel is not None and not rect_center_in_panel(r, panel, margin=14):
                return False
            return True
        except Exception:
            return False

    pool = [e for e in edits if in_relaxed_strip(e)]
    if not pool:
        return None

    def rank(e: Control) -> tuple[float, float]:
        try:
            r = e.BoundingRectangle
            w = max(0.0, float(r.right - r.left))
            bot = float(r.bottom)
            dist_bottom = abs(float(wr.bottom) - bot)
            return (w * 900.0 + bot, -dist_bottom)
        except Exception:
            return (0.0, 0.0)

    return max(pool, key=rank)


def find_input_left_of_send(
    win: Control,
    send_btn: Control,
    panel: ChatPanelScreen | None = None,
) -> Control | None:
    """策略 B：在「发送」按钮左侧、纵向相交的宽 Edit。"""
    try:
        sr = send_btn.BoundingRectangle
    except Exception:
        return None
    wr = _win_rect(win)
    edge = _session_list_right_edge(win)
    send_left = float(sr.left)
    max_cx = float(wr.left) + (float(wr.right) - float(wr.left)) * (1.0 - _RIGHT_PANEL_EXCLUDE_RATIO)
    candidates: list[tuple[Control, float]] = []
    for c in _walk(win, max_depth=get_selectors().tree_walk_max_depth):
        try:
            if c.ControlType != auto.ControlType.EditControl:
                continue
            if _edit_under_blocked_subtree(c):
                continue
            if _edit_is_readonly(c):
                continue
            r = c.BoundingRectangle
            if r.left < edge - 10:
                continue
            if float(r.right) > min(send_left + 48.0, max_cx):
                continue
            if r.bottom < float(sr.top) - 110.0 or r.top > float(sr.bottom) + 110.0:
                continue
            w = float(r.right - r.left)
            if w < max(_COMPOSE_EDIT_MIN_WIDTH_PX, 80.0):
                continue
            if panel is not None and not rect_center_in_panel(r, panel, margin=22):
                continue
            score = w * 12.0 + float(r.bottom)
            candidates.append((c, score))
        except Exception:
            continue
    if not candidates:
        return None
    return max(candidates, key=lambda x: x[1])[0]


def find_send_button(
    win: Control,
    input_edit: Control | None = None,
    panel: ChatPanelScreen | None = None,
) -> Control | None:
    """仅聊天输入条上的「发送」：排除「发送链接」等；水平位置须靠近已选中的输入框。"""
    sel = get_selectors()
    wr = _win_rect(win)
    edge = _session_list_right_edge(win)
    span = max(1.0, float(wr.right - edge))
    zone_hi = edge + span * 0.56  # 无输入框时的保守上界

    edit_top: float | None = None
    edit_bottom: float | None = None
    edit_cx: float | None = None
    try:
        if input_edit is not None:
            er = input_edit.BoundingRectangle
            edit_top = float(er.top)
            edit_bottom = float(er.bottom)
            edit_cx = float(er.left + er.right) / 2.0
    except Exception:
        edit_top = edit_bottom = edit_cx = None

    if edit_cx is not None:
        max_btn_cx = min(zone_hi, edit_cx + _SEND_BTN_MAX_RIGHT_OF_EDIT_PX)
    else:
        max_btn_cx = zone_hi

    band_lo = (edit_top - _SEND_BAND_ABOVE_EDIT_PX) if edit_top is not None else None
    band_hi = (edit_bottom + _SEND_BAND_BELOW_EDIT_PX) if edit_bottom is not None else None

    def _button_ok(n: str) -> bool:
        incs = [x for x in sel.send_button_include_substrings if x]
        excs = [x for x in sel.send_button_exclude_substrings if x]
        if incs and not any(x in n for x in incs):
            return False
        if any(x in n for x in excs):
            return False
        if _is_product_or_sidebar_send_button(n):
            return False
        return True

    candidates: list[Control] = []
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if c.ControlType != auto.ControlType.ButtonControl:
                continue
            n = (c.Name or "").strip()
            if not _button_ok(n):
                continue
            r = c.BoundingRectangle
            if not _button_near_bottom_toolbar(r, wr):
                continue
            if panel is not None:
                if not rect_overlap_panel(r, panel, margin=4):
                    continue
                if float(r.bottom) < float(panel.bottom) - 155:
                    continue
            if r.left < edge - 8:
                continue
            rcx = (r.left + r.right) / 2.0
            if rcx > max_btn_cx:
                continue
            if band_lo is not None and band_hi is not None:
                cb = float(r.bottom)
                ct = float(r.top)
                if cb < band_lo - 20 or ct > band_hi + 30:
                    continue
            candidates.append(c)
        except Exception:
            continue

    def sort_key(c: Control) -> tuple[float, int, int, float]:
        try:
            nn = (c.Name or "").strip()
            r = c.BoundingRectangle
            bot = float(r.bottom)
            rcx = (r.left + r.right) / 2.0
            name_pri = 0 if nn == "发送" else (1 if nn.startswith("发送") and len(nn) <= 4 else 2)
            if edit_cx is None or edit_bottom is None:
                return (0.0, name_pri, len(nn), bot)
            h = abs(rcx - edit_cx)
            v = abs(bot - edit_bottom)
            return (h + v * 1.5, name_pri, len(nn), bot)
        except Exception:
            return (999999.0, 99, 99, 0.0)

    if candidates:
        return min(candidates, key=sort_key)

    # 兜底：仍禁止「发送链接」与右侧过远按钮
    best: Control | None = None
    best_key: tuple[float, int, int, float] | None = None
    for c in _walk(win, max_depth=sel.tree_walk_max_depth):
        try:
            if c.ControlType != auto.ControlType.ButtonControl:
                continue
            n = (c.Name or "").strip()
            if not _button_ok(n):
                continue
            r = c.BoundingRectangle
            if not _button_near_bottom_toolbar(r, wr):
                continue
            if panel is not None:
                if not rect_overlap_panel(r, panel, margin=4):
                    continue
                if float(r.bottom) < float(panel.bottom) - 155:
                    continue
            if r.left < edge - 8:
                continue
            rcx = (r.left + r.right) / 2.0
            if rcx > zone_hi:
                continue
            k = sort_key(c)
            if best is None:
                best = c
                best_key = k
            elif best_key is not None and k < best_key:
                best = c
                best_key = k
        except Exception:
            continue
    return best


def read_latest_buyer_message_hybrid(
    win: Control,
    ctx: object | None,
) -> tuple[str | None, str | None, float | None]:
    """
    优先用 OCR 在聊天面板内取最底部左侧客户句；若无则 UIA，且 UIA 受同一 panel 过滤。
    ctx 为 chat_ocr_flow.ChatOcrContext 或 None（未启用 OCR 时）。
    """
    from app.chat_read import latest_buyer_message_from_ocr

    panel = getattr(ctx, "panel", None) if ctx is not None else None
    if ctx is not None and panel is not None:
        boxes = getattr(ctx, "boxes", None) or []
        if boxes:
            msg, ts, y = latest_buyer_message_from_ocr(boxes, panel)
            if msg:
                return msg, ts, y
    return read_latest_buyer_message(win, panel=panel)
