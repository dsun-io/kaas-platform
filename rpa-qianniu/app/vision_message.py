"""
聊天消息区：OCR 取最下方买家侧文本（纯视觉）。
"""

from __future__ import annotations

import numpy as np

from app.message_parser import (
    has_substantive_buyer_text,
    is_non_message_ui_text,
    is_system_message,
)
from app.ocr_paddle import OcrTextBox, ocr_bgr_to_boxes
from app.vision_layout import ScreenRect


def _crop_window(bgr: np.ndarray, win: ScreenRect, region: ScreenRect) -> np.ndarray:
    x0 = max(0, region.left - win.left)
    y0 = max(0, region.top - win.top)
    x1 = min(bgr.shape[1], region.right - win.left)
    y1 = min(bgr.shape[0], region.bottom - win.top)
    if x1 <= x0 + 1 or y1 <= y0 + 1:
        return np.array([])
    return bgr[y0:y1, x0:x1]


def latest_buyer_message_ocr(
    bgr: np.ndarray,
    win: ScreenRect,
    message_area: ScreenRect,
    *,
    buyer_x_ratio_max: float = 0.52,
) -> str | None:
    """
    在消息区内 OCR，取「靠左」且「最靠下」的一条有效买家句。
    """
    crop = _crop_window(bgr, win, message_area)
    if crop.size == 0:
        return None
    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=message_area.left,
        win_top=message_area.top,
        cache_ttl_sec=0.0,
    )
    if not boxes:
        return None

    mw = max(1, message_area.w)

    def _cx(b: OcrTextBox) -> float:
        return ((b.left + b.right) / 2.0 - float(message_area.left)) / float(mw)

    def _by(b: OcrTextBox) -> float:
        return float(b.bottom)

    candidates: list[OcrTextBox] = []
    for b in boxes:
        t = (b.text or "").strip()
        if not t:
            continue
        if _cx(b) > buyer_x_ratio_max:
            continue
        if not has_substantive_buyer_text(t):
            continue
        if is_non_message_ui_text(t) or is_system_message(t):
            continue
        candidates.append(b)

    if not candidates:
        return None
    # 同一条会话：最下方一条（最大 bottom）优先
    candidates.sort(key=_by, reverse=True)
    return (candidates[0].text or "").strip() or None
