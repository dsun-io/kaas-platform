"""纯视觉流水线调试截图：debug/{timestamp}_{step}.png（受 RPA_DEBUG_LEVEL 控制）。"""

from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import settings
from app.debug_manager import should_save

_LAST_DEBUG_STEP_MONO: dict[str, float] = {}

_STEP_TO_EVENT: dict[str, str] = {
    "vision_full_window": "routine",
    "unread_left_crop": "unread_detected",
    "vision_after_click_session": "ocr_extract",
    "vision_before_send": "routine",
    "message_area_ocr": "ocr_extract",
    "input_area_ocr": "ocr_extract",
    "vision_after_send": "send_success",
}


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]


def save_debug_bgr(
    bgr: np.ndarray | None,
    step: str,
    *,
    min_interval_sec: float | None = None,
    event_type: str | None = None,
) -> Path | None:
    if bgr is None or bgr.size == 0:
        return None
    ev = event_type or _STEP_TO_EVENT.get(step, "routine")
    if not should_save(ev):
        return None
    iv = float(min_interval_sec) if min_interval_sec is not None else 0.0
    if iv > 0:
        now = time.monotonic()
        last = _LAST_DEBUG_STEP_MONO.get(step, 0.0)
        if now - last < iv:
            return None
        _LAST_DEBUG_STEP_MONO[step] = now
    root = Path(settings.vision_debug_dir)
    try:
        root.mkdir(parents=True, exist_ok=True)
    except Exception:
        return None
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in step)[:80]
    p = root / f"{_ts()}_{safe}.png"
    try:
        cv2.imwrite(str(p), bgr)
        return p
    except Exception:
        return None


def sleep_after_capture() -> None:
    time.sleep(max(0.05, float(settings.vision_capture_settle_sec)))
