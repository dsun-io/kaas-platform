"""纯视觉流水线调试截图：debug/{timestamp}_{step}.png"""

from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from app.config import settings


def _ts() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]


def save_debug_bgr(bgr: np.ndarray | None, step: str) -> Path | None:
    if bgr is None or bgr.size == 0:
        return None
    if not settings.vision_debug_screenshots:
        return None
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
