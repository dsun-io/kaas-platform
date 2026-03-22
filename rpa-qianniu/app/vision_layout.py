"""
千牛接待中心：仅用窗口矩形 + 比例划分左/中/右与消息区、输入区（CEF 内无 UIA 时使用）。
"""

from __future__ import annotations

from dataclasses import dataclass

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
    left_panel: ScreenRect
    chat_panel: ScreenRect
    right_panel: ScreenRect
    message_area: ScreenRect
    input_area: ScreenRect


def rect_from_window(win: auto.Control) -> ScreenRect:
    r = win.BoundingRectangle
    return ScreenRect(
        left=int(r.left),
        top=int(r.top),
        right=int(r.right),
        bottom=int(r.bottom),
    )


def layout_from_rect(window: ScreenRect) -> VisionLayout:
    """
    默认三栏：左 [0, left_end) | 聊天 [left_end, chat_end) | 右 [chat_end, 1]；
    聊天列内：顶部 strip 为标题等，底部 strip 为输入+发送。
    """
    wl, wt = window.left, window.top
    ww, wh = max(1, window.w), max(1, window.h)

    le = float(settings.vision_left_end_ratio)
    ce = float(settings.vision_chat_end_ratio)
    le = max(0.05, min(0.45, le))
    ce = max(le + 0.15, min(0.92, ce))

    x_left1 = wl + int(ww * le)
    x_chat1 = wl + int(ww * ce)
    x_right = wl + ww

    left_panel = ScreenRect(wl, wt, x_left1, window.bottom)
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
        left_panel=left_panel,
        chat_panel=chat_panel,
        right_panel=right_panel,
        message_area=message_area,
        input_area=input_area,
    )
