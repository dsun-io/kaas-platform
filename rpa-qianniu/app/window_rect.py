"""
DWM 精确窗口边界获取模块

解决 UIA BoundingRectangle 含不可见窗口边框导致的坐标偏移问题（约9px）
使用 DwmGetWindowAttribute 获取不含边框的精确窗口边界
"""

from __future__ import annotations

import ctypes
import logging
from ctypes import wintypes
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import uiautomation as auto

log = logging.getLogger(__name__)

# DWM API 常量
dwmapi = ctypes.windll.dwmapi
DWMWA_EXTENDED_FRAME_BOUNDS = 9


@dataclass
class ScreenRect:
    """屏幕坐标矩形，与 uiautomation.Rect 兼容但使用整数"""
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return self.right - self.left

    @property
    def height(self) -> int:
        return self.bottom - self.top

    def to_tuple(self) -> tuple[int, int, int, int]:
        """返回 (left, top, right, bottom) 元组"""
        return (self.left, self.top, self.right, self.bottom)


def get_dwm_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """
    使用 DwmGetWindowAttribute 获取窗口精确边界（不含不可见边框）

    Args:
        hwnd: 窗口句柄

    Returns:
        (left, top, right, bottom) 或 None（如果调用失败）
    """
    rect = wintypes.RECT()
    try:
        result = dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            ctypes.byref(rect),
            ctypes.sizeof(rect)
        )
        if result == 0:  # S_OK
            return (rect.left, rect.top, rect.right, rect.bottom)
    except Exception as e:
        log.debug("DwmGetWindowAttribute 调用失败: %s", e)
    return None


def get_win32_window_rect(hwnd: int) -> tuple[int, int, int, int] | None:
    """
    使用 GetWindowRect 获取窗口边界（含边框，fallback用）

    Args:
        hwnd: 窗口句柄

    Returns:
        (left, top, right, bottom) 或 None
    """
    try:
        user32 = ctypes.windll.user32
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return (rect.left, rect.top, rect.right, rect.bottom)
    except Exception as e:
        log.debug("GetWindowRect 调用失败: %s", e)
    return None


def get_precise_window_rect(hwnd: int) -> ScreenRect | None:
    """
    获取窗口精确边界（优先DWM，失败则用Win32）

    Args:
        hwnd: 窗口句柄

    Returns:
        ScreenRect 或 None
    """
    # 优先尝试 DWM（不含不可见边框）
    dwm_rect = get_dwm_window_rect(hwnd)
    if dwm_rect:
        left, top, right, bottom = dwm_rect
        log.debug("使用 DWM 窗口边界: (%d,%d,%d,%d)", left, top, right, bottom)
        return ScreenRect(left, top, right, bottom)

    # fallback 到 Win32（含边框）
    win32_rect = get_win32_window_rect(hwnd)
    if win32_rect:
        left, top, right, bottom = win32_rect
        log.debug("使用 Win32 窗口边界: (%d,%d,%d,%d)", left, top, right, bottom)
        return ScreenRect(left, top, right, bottom)

    log.warning("无法获取窗口 %d 的边界", hwnd)
    return None


def get_precise_rect_for_control(control: "auto.Control") -> ScreenRect | None:
    """
    从 uiautomation Control 获取精确窗口边界

    Args:
        control: uiautomation Control 对象

    Returns:
        ScreenRect 或 None
    """
    try:
        # 获取 NativeWindowHandle
        hwnd = control.NativeWindowHandle
        if hwnd and hwnd > 0:
            return get_precise_window_rect(hwnd)
    except Exception as e:
        log.debug("获取控件窗口句柄失败: %s", e)

    # fallback 到 UIA 的 BoundingRectangle
    try:
        uia_rect = control.BoundingRectangle
        if uia_rect:
            log.debug("使用 UIA 边界（可能含偏移）: %s", uia_rect)
            return ScreenRect(
                int(uia_rect.left),
                int(uia_rect.top),
                int(uia_rect.right),
                int(uia_rect.bottom)
            )
    except Exception as e:
        log.debug("获取 UIA 边界失败: %s", e)

    return None


def rect_to_auto_rect(screen_rect: ScreenRect) -> "auto.Rect":
    """
    将 ScreenRect 转换回 uiautomation.Rect（用于兼容性）

    Args:
        screen_rect: ScreenRect 对象

    Returns:
        uiautomation.Rect
    """
    import uiautomation as auto
    return auto.Rect(
        screen_rect.left,
        screen_rect.top,
        screen_rect.right,
        screen_rect.bottom
    )
