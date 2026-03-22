"""
左侧列表：红点（HSV）+ 连通域 + 可选 OCR 昵称（纯视觉）。
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from app.config import settings
from app.ocr_paddle import ocr_bgr_to_boxes, paddle_available
from app.vision_debug import save_debug_bgr
from app.vision_layout import ScreenRect


def _crop_window(bgr: np.ndarray, win: ScreenRect, region: ScreenRect) -> np.ndarray:
    x0 = max(0, region.left - win.left)
    y0 = max(0, region.top - win.top)
    x1 = min(bgr.shape[1], region.right - win.left)
    y1 = min(bgr.shape[0], region.bottom - win.top)
    if x1 <= x0 + 1 or y1 <= y0 + 1:
        return np.array([])
    return bgr[y0:y1, x0:x1].copy()


def _red_mask(bgr: np.ndarray) -> np.ndarray | None:
    if bgr.size == 0 or bgr.ndim != 3:
        return None
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, (0, 120, 120), (10, 255, 255))
    m2 = cv2.inRange(hsv, (170, 120, 120), (180, 255, 255))
    return cv2.bitwise_or(m1, m2)


@dataclass
class UnreadDot:
    """屏幕坐标系下的红点中心；buyer 为 OCR 昵称（可能为空）。"""

    cx_screen: int
    cy_screen: int
    buyer: str


def detect_unread_dots(
    bgr: np.ndarray,
    win: ScreenRect,
    left: ScreenRect,
) -> list[UnreadDot]:
    """
    在左侧列表区域检测未读红点，返回按 y 排序的列表（靠上优先）。
    """
    crop = _crop_window(bgr, win, left)
    save_debug_bgr(crop, "unread_left_crop")
    if crop.size == 0:
        return []

    mask = _red_mask(crop)
    if mask is None or mask.size == 0:
        return []
    # 去噪
    k = max(1, min(5, crop.shape[0] // 120))
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k * 2 + 1, k * 2 + 1))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    amin = int(settings.vision_unread_dot_area_min)
    amax = int(settings.vision_unread_dot_area_max)
    dots: list[tuple[float, float, float]] = []
    for cnt in contours:
        a = float(cv2.contourArea(cnt))
        if not (amin <= a <= amax):
            continue
        x, y, bw, bh = cv2.boundingRect(cnt)
        if min(bw, bh) < 2:
            continue
        rmax = max(bw, bh) / max(1.0, min(bw, bh))
        if rmax > 4.5:
            continue
        m = cv2.moments(cnt)
        if m["m00"] <= 1e-6:
            continue
        cx = float(m["m10"] / m["m00"])
        cy = float(m["m01"] / m["m00"])
        dots.append((cy, cx, a))

    dots.sort(key=lambda t: t[0])
    out: list[UnreadDot] = []
    for cy, cx, _ in dots:
        # crop 相对 left 面板左上角 → 屏幕坐标
        cx_s = int(left.left + cx)
        cy_s = int(left.top + cy)
        buyer = ""
        if paddle_available():
            # 红点右侧至左栏中部：会话昵称常见区域
            h, w = crop.shape[:2]
            ix = int(min(w - 2, max(0, cx + 4)))
            row_t = max(0, int(cy - 14))
            row_b = min(h, int(cy + 28))
            name_roi = crop[row_t:row_b, ix : min(w, ix + max(120, w // 2))]
            if name_roi.size > 0:
                save_debug_bgr(name_roi, "unread_name_roi")
                boxes = ocr_bgr_to_boxes(
                    name_roi,
                    win_left=left.left + ix,
                    win_top=left.top + row_t,
                    cache_ttl_sec=0.0,
                )
                parts = sorted(
                    [b.text.strip() for b in boxes if b.text and len(b.text.strip()) >= 2],
                    key=len,
                    reverse=True,
                )
                if parts:
                    buyer = parts[0][:64]
        out.append(UnreadDot(cx_screen=cx_s, cy_screen=cy_s, buyer=buyer))
    return out
