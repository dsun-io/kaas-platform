"""RPA_DEBUG_LEVEL：控制 debug/ 下 PNG 写入策略（0=生产按需，1=关键事件，2=全量）。"""

from __future__ import annotations

from app.config import settings

DebugEvent = str  # 'routine' | 'unread_detected' | 'ocr_extract' | 'send_success' | 'error'


def effective_debug_level() -> int:
    lv = int(settings.rpa_debug_level or 0)
    if lv < 0:
        lv = 0
    if lv > 2:
        lv = 2
    if settings.vision_debug_screenshots:
        return max(lv, 2)
    return lv


def should_save(event_type: DebugEvent) -> bool:
    level = effective_debug_level()
    if level >= 2:
        return True
    if event_type == "error":
        return True
    if level >= 1 and event_type in (
        "unread_detected",
        "ocr_extract",
        "send_success",
    ):
        return True
    return False
