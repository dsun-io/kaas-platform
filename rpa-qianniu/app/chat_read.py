from __future__ import annotations

import re

from app.chat_bounds import ChatPanelScreen
from app.message_parser import (
    extract_time_token,
    has_substantive_buyer_text,
    is_non_message_ui_text,
    is_ocr_noise_message,
    is_system_message,
)
from app.ocr_paddle import OcrTextBox


def _ocr_box_in_panel(b: OcrTextBox, panel: ChatPanelScreen) -> bool:
    cy = (b.top + b.bottom) / 2.0
    cx = (b.left + b.right) / 2.0
    return (
        panel.left <= cx <= panel.right
        and panel.top <= cy <= panel.bottom - 40
    )


def latest_buyer_message_from_ocr(
    boxes: list[OcrTextBox],
    panel: ChatPanelScreen,
) -> tuple[str | None, str | None, float | None]:
    """
    在聊天面板内按 OCR 行提取「最靠下」的左侧客户消息。
    规则：中心在面板左半区、置信度足够、通过系统/价格噪声过滤。
    """
    mid_x = (panel.left + panel.right) / 2.0
    candidates: list[tuple[float, str]] = []

    for b in boxes:
        if b.confidence < 0.45:
            continue
        if not _ocr_box_in_panel(b, panel):
            continue
        cx = (b.left + b.right) / 2.0
        if cx > mid_x - 6:
            continue
        tt = (b.text or "").strip()
        if not tt or len(tt) > 800:
            continue
        if is_non_message_ui_text(tt):
            continue
        if is_ocr_noise_message(tt):
            continue
        if not has_substantive_buyer_text(tt):
            continue
        if is_system_message(tt):
            continue
        # 单行过长且像 URL/单号
        if re.fullmatch(r"[A-Za-z0-9_\-:/.?=&%+]{12,}", tt.replace(" ", "")):
            continue
        bottom = float(b.bottom)
        candidates.append((bottom, tt))

    if not candidates:
        return None, None, None

    candidates.sort(key=lambda x: x[0])
    bottom, tt = candidates[-1]
    return tt, extract_time_token(tt), bottom
