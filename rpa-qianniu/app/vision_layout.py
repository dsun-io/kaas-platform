"""
千牛接待中心：仅用窗口矩形 + 比例划分左/中/右与消息区、输入区（CEF 内无 UIA 时使用）。
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

import numpy as np
import uiautomation as auto

from app.config import settings


@dataclass(frozen=True)
class ScreenRect:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def w(self) -> int:
        return max(0, int(self.right - self.left))

    @property
    def h(self) -> int:
        return max(0, int(self.bottom - self.top))


@dataclass(frozen=True)
class VisionLayout:
    """各区域均为屏幕坐标。"""

    window: ScreenRect
    # 最左侧图标导航（消息/进店等），未读检测不用此条，仅标定图展示
    left_nav_strip: ScreenRect
    left_panel: ScreenRect
    chat_panel: ScreenRect
    right_panel: ScreenRect
    message_area: ScreenRect
    input_area: ScreenRect
    # 校准得到的「发送」中心（屏幕坐标）；无则回复流程需 OCR 找「发送」
    send_button_center_screen: tuple[int, int] | None = None
    cal_source: str = "ratio"


def rect_from_window(win: auto.Control) -> ScreenRect:
    """获取窗口精确边界（优先DWM，解决UIA 9px偏移）"""
    from app.window_rect import get_precise_rect_for_control
    
    # 优先使用 DWM 精确边界（不含不可见边框）
    precise = get_precise_rect_for_control(win)
    if precise:
        return ScreenRect(
            left=precise.left,
            top=precise.top,
            right=precise.right,
            bottom=precise.bottom,
        )
    
    # fallback 到 UIA 边界（可能含偏移）
    r = win.BoundingRectangle
    return ScreenRect(
        left=int(r.left),
        top=int(r.top),
        right=int(r.right),
        bottom=int(r.bottom),
    )


def layout_from_rect(window: ScreenRect) -> VisionLayout:
    """
    水平方向：
    - [0, left_start)：左侧图标导航（角标易误判未读，红点检测排除）
    - [left_start, left_end)：会话列表（left_panel，未读红点只在此裁剪）
    - [left_end, chat_end)：聊天列（含标题+气泡+输入）
    - [chat_end, 1]：右侧商品/订单

    聊天列内垂直：message_area 去掉顶/底 strip。
    """
    wl, wt = window.left, window.top
    ww, wh = max(1, window.w), max(1, window.h)

    ls = float(settings.vision_left_start_ratio)
    le = float(settings.vision_left_end_ratio)
    ce = float(settings.vision_chat_end_ratio)
    ls = max(0.0, min(0.25, ls))
    le = max(ls + 0.04, min(0.48, le))
    ce = max(le + 0.12, min(0.92, ce))

    x_nav1 = wl + int(ww * ls)
    x_left1 = wl + int(ww * le)
    x_chat1 = wl + int(ww * ce)
    x_right = wl + ww

    left_nav_strip = ScreenRect(wl, wt, x_nav1, window.bottom)
    left_panel = ScreenRect(x_nav1, wt, x_left1, window.bottom)
    chat_panel = ScreenRect(x_left1, wt, x_chat1, window.bottom)
    right_panel = ScreenRect(x_chat1, wt, x_right, window.bottom)

    # 聊天列：消息区 = 去掉顶 strip、底 input strip
    ct, cb = chat_panel.top, chat_panel.bottom
    ch = max(1, cb - ct)
    top_skip = int(ch * float(settings.vision_message_top_ratio))
    bot_inp = int(ch * float(settings.vision_input_bottom_ratio))
    msg_top = ct + top_skip
    msg_bottom = max(msg_top + 1, cb - bot_inp)
    message_area = ScreenRect(chat_panel.left, msg_top, chat_panel.right, msg_bottom)
    input_area = ScreenRect(chat_panel.left, msg_bottom, chat_panel.right, cb)

    return VisionLayout(
        window=window,
        left_nav_strip=left_nav_strip,
        left_panel=left_panel,
        chat_panel=chat_panel,
        right_panel=right_panel,
        message_area=message_area,
        input_area=input_area,
        send_button_center_screen=None,
        cal_source="ratio",
    )


def _screen_rect_from_cal_window(window: ScreenRect, r: dict[str, Any]) -> ScreenRect:
    wl, wt = window.left, window.top
    return ScreenRect(
        wl + int(r["x1"]),
        wt + int(r["y1"]),
        wl + int(r["x2"]),
        wt + int(r["y2"]),
    )


def layout_from_calibration_dict(
    window: ScreenRect,
    cal: dict[str, Any],
    *,
    cal_source: str = "calibration",
) -> VisionLayout:
    """将 auto_calibrate 返回的窗口内坐标转为屏幕矩形。"""
    nav = cal["left_nav_strip"]
    left_panel = cal["left_panel"]
    chat = cal["chat_panel"]
    right = cal["right_panel"]
    msg = cal["message_area"]
    inp = cal["input_area"]
    sb = cal.get("send_button")
    send_xy: tuple[int, int] | None = None
    if isinstance(sb, dict):
        try:
            send_xy = (
                window.left + int(sb["x"]),
                window.top + int(sb["y"]),
            )
        except (KeyError, TypeError, ValueError):
            send_xy = None
    return VisionLayout(
        window=window,
        left_nav_strip=_screen_rect_from_cal_window(window, nav),
        left_panel=_screen_rect_from_cal_window(window, left_panel),
        chat_panel=_screen_rect_from_cal_window(window, chat),
        right_panel=_screen_rect_from_cal_window(window, right),
        message_area=_screen_rect_from_cal_window(window, msg),
        input_area=_screen_rect_from_cal_window(window, inp),
        send_button_center_screen=send_xy,
        cal_source=cal_source,
    )


def find_right_panel_boundary(win: auto.Control, max_depth: int = 6) -> int | None:
    """
    查找右侧面板(Pane"千牛工作台")的左边界作为 chat/right 分界
    
    基于阶段一探测: 右侧面板 Pane 的 bounding_rectangle 精确可用
    可作为 chat_panel/right_panel 分界的锚点
    
    Args:
        win: 千牛窗口 Control
        max_depth: 遍历深度（6层足够，避免过度遍历）
    
    Returns:
        右侧面板左边界 x 坐标，或 None（未找到）
    """
    try:
        wr = win.BoundingRectangle
        window_width = wr.right - wr.left
        window_center_x = wr.left + window_width / 2
        
        def _walk_right_panel(ctrl: auto.Control, depth: int) -> int | None:
            if depth > max_depth:
                return None
            
            try:
                # 查找 PaneControl 且 Name 含"千牛工作台"
                if (ctrl.ControlType == auto.ControlType.PaneControl and
                    "千牛工作台" in (ctrl.Name or "")):
                    r = ctrl.BoundingRectangle
                    # 确认在窗口右半部分
                    if r.left > window_center_x:
                        return int(r.left)
            except Exception:
                pass
            
            # 递归遍历子控件
            try:
                children = ctrl.GetChildren()
                for child in children:
                    result = _walk_right_panel(child, depth + 1)
                    if result:
                        return result
            except Exception:
                pass
            
            return None
        
        return _walk_right_panel(win, 0)
        
    except Exception as e:
        return None


def layout_from_uia_anchors(
    win: auto.Control,
    window_rect: ScreenRect
) -> VisionLayout | None:
    """
    使用 UIA 右侧面板锚点构建布局（减少 OCR 校准依赖）
    
    保持左侧面板用 .env 比例（会话列表不在 UIA 树中）
    垂直划分(message_area/input_area)仍用比例
    
    Args:
        win: 千牛窗口 Control
        window_rect: 窗口矩形（来自 DWM 精确边界）
    
    Returns:
        VisionLayout 或 None（UIA 锚定失败）
    """
    # 获取右侧面板左边界（作为 chat/right 分界）
    right_panel_left = find_right_panel_boundary(win)
    if right_panel_left is None:
        return None
    
    wl, wt = window_rect.left, window_rect.top
    ww = max(1, window_rect.w)
    wh = max(1, window_rect.h)
    
    # 左侧面板仍用 .env 比例（会话列表不在 UIA 树中）
    ls = float(settings.vision_left_start_ratio)
    le = float(settings.vision_left_end_ratio)
    ls = max(0.0, min(0.25, ls))
    le = max(ls + 0.04, min(0.48, le))
    
    x_nav1 = wl + int(ww * ls)
    x_left1 = wl + int(ww * le)
    x_chat1 = right_panel_left  # 使用 UIA 锚定值替代比例
    x_right = wl + ww
    
    left_nav_strip = ScreenRect(wl, wt, x_nav1, window_rect.bottom)
    left_panel = ScreenRect(x_nav1, wt, x_left1, window_rect.bottom)
    chat_panel = ScreenRect(x_left1, wt, x_chat1, window_rect.bottom)
    right_panel = ScreenRect(x_chat1, wt, x_right, window_rect.bottom)
    
    # 垂直划分仍用比例（UIA 无法提供垂直分界）
    ct, cb = chat_panel.top, chat_panel.bottom
    ch = max(1, cb - ct)
    top_skip = int(ch * float(settings.vision_message_top_ratio))
    bot_inp = int(ch * float(settings.vision_input_bottom_ratio))
    msg_top = ct + top_skip
    msg_bottom = max(msg_top + 1, cb - bot_inp)
    message_area = ScreenRect(chat_panel.left, msg_top, chat_panel.right, msg_bottom)
    input_area = ScreenRect(chat_panel.left, msg_bottom, chat_panel.right, cb)
    
    return VisionLayout(
        window=window_rect,
        left_nav_strip=left_nav_strip,
        left_panel=left_panel,
        chat_panel=chat_panel,
        right_panel=right_panel,
        message_area=message_area,
        input_area=input_area,
        send_button_center_screen=None,
        cal_source="uia_anchor",
    )


def build_vision_layout(
    window: ScreenRect,
    bgr: np.ndarray | None,
    win: auto.Control | None = None
) -> VisionLayout:
    """
    优先读 vision_calibration.json（window_size 与截图一致）
    → 否则 UIA 锚定（Task 2C）
    → 否则 OCR 校准
    → 失败则 .env 比例。
    """
    from app.logger import get_logger
    from app.vision_calibrate import (
        auto_calibrate,
        save_calibration_cache,
        try_load_calibration_cache,
    )

    log = get_logger("vision_layout")

    if not settings.vision_auto_calibrate:
        return layout_from_rect(window)

    wh: tuple[int, int] | None = None
    if bgr is not None and bgr.size > 0:
        wh = (int(bgr.shape[1]), int(bgr.shape[0]))

    # 1. 优先复用缓存
    if wh is not None:
        cached = try_load_calibration_cache(wh)
        if cached:
            log.debug("[校准] 复用缓存 window_size=%sx%s", wh[0], wh[1])
            return layout_from_calibration_dict(window, cached, cal_source="cache")

    # 2. Task 2C: UIA 锚定（如果提供了 win Control）
    if win is not None:
        try:
            uia_layout = layout_from_uia_anchors(win, window)
            if uia_layout:
                log.info("[校准] UIA 锚定成功，跳过 OCR 校准")
                return uia_layout
        except Exception as e:
            log.debug("[校准] UIA 锚定失败: %s", e)

    # 3. OCR 校准
    if bgr is None or bgr.size == 0:
        log.warning("[校准] 无有效截图，使用 .env 比例")
        return layout_from_rect(window)

    cal = auto_calibrate(bgr)
    if cal:
        save_calibration_cache(cal)
        log.info("[校准] 自动校准成功（调试图已由 auto_calibrate 写出）")
        return layout_from_calibration_dict(window, cal, cal_source="calibration")

    log.warning("[WARNING] 自动校准失败，使用默认比例")
    return replace(layout_from_rect(window), cal_source="ratio_fallback")
