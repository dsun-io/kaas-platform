"""
整窗 BGR 截图与 UIA BoundingRectangle 尺寸可能不一致（HiDPI 等）时，
将「屏幕语义」的矩形与 BGR 像素、点击坐标互转。
"""

from __future__ import annotations

import numpy as np

from app.vision_layout import ScreenRect


def crop_window_bgr(
    bgr: np.ndarray,
    win: ScreenRect,
    region: ScreenRect,
) -> tuple[np.ndarray, int, int]:
    """
    按 win 与 bgr 的宽高比，把 region（屏幕坐标）映射到 bgr 下标并裁剪。
    返回 (crop, x0, y0)，(x0,y0) 为 crop 在 bgr 中的左上角索引。
    """
    if bgr.size == 0 or bgr.ndim != 3:
        return np.array([]), 0, 0
    ww = max(1, win.right - win.left)
    wh = max(1, win.bottom - win.top)
    bw, bh = int(bgr.shape[1]), int(bgr.shape[0])
    x0 = int(max(0, round((region.left - win.left) * bw / ww)))
    y0 = int(max(0, round((region.top - win.top) * bh / wh)))
    x1 = int(min(bw, max(x0 + 1, round((region.right - win.left) * bw / ww))))
    y1 = int(min(bh, max(y0 + 1, round((region.bottom - win.top) * bh / wh))))
    if x1 <= x0 + 1 or y1 <= y0 + 1:
        return np.array([]), 0, 0
    return bgr[y0:y1, x0:x1].copy(), x0, y0


def bgr_point_to_screen(
    win: ScreenRect,
    bgr: np.ndarray,
    bx: float,
    by: float,
) -> tuple[int, int]:
    """BGR 全图上的像素坐标 → 屏幕像素坐标。"""
    bw = max(1, int(bgr.shape[1]))
    bh = max(1, int(bgr.shape[0]))
    ww = max(1, win.right - win.left)
    wh = max(1, win.bottom - win.top)
    return (
        int(round(win.left + bx * ww / bw)),
        int(round(win.top + by * wh / bh)),
    )


def bgr_crop_origin_to_screen(
    win: ScreenRect,
    bgr: np.ndarray,
    x0: int,
    y0: int,
) -> tuple[int, int]:
    """crop 左上角在 bgr 中的索引 → 该 crop[0,0] 对应屏幕上的点。"""
    return bgr_point_to_screen(win, bgr, float(x0), float(y0))


def screen_point_to_bgr_xy(
    win: ScreenRect,
    bgr: np.ndarray,
    sx: int,
    sy: int,
) -> tuple[int, int]:
    """屏幕坐标 → 整窗 BGR 下标（用于在截图上标注）。"""
    bw = max(1, int(bgr.shape[1]))
    bh = max(1, int(bgr.shape[0]))
    ww = max(1, win.right - win.left)
    wh = max(1, win.bottom - win.top)
    bx = (sx - win.left) * bw / ww
    by = (sy - win.top) * bh / wh
    return int(round(bx)), int(round(by))
