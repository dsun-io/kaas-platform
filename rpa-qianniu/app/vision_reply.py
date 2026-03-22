"""
输入区：OCR 找「发送」→ 点击输入条 → 剪贴板粘贴 → 点击发送（纯视觉）。
"""

from __future__ import annotations

import re
import time

import numpy as np
import pyautogui
import pyperclip

from app.config import settings
from app.logger import get_logger
from app.ocr_paddle import ocr_bgr_to_boxes, paddle_available
from app.qianniu_driver import human_delay
from app.vision_debug import save_debug_bgr
from app.vision_layout import ScreenRect

log = get_logger("vision_reply")

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.04


def _crop_window(bgr: np.ndarray, win: ScreenRect, region: ScreenRect) -> np.ndarray:
    x0 = max(0, region.left - win.left)
    y0 = max(0, region.top - win.top)
    x1 = min(bgr.shape[1], region.right - win.left)
    y1 = min(bgr.shape[0], region.bottom - win.top)
    if x1 <= x0 + 1 or y1 <= y0 + 1:
        return np.array([])
    return bgr[y0:y1, x0:x1]


def send_reply_vision(
    bgr: np.ndarray,
    win: ScreenRect,
    input_area: ScreenRect,
    text: str,
) -> bool:
    if not paddle_available():
        log.error("PaddleOCR 不可用，无法 OCR「发送」按钮")
        return False
    body = (text or "").strip()
    if not body:
        return False

    crop = _crop_window(bgr, win, input_area)
    save_debug_bgr(crop, "input_area_ocr")
    if crop.size == 0:
        return False

    boxes = ocr_bgr_to_boxes(
        crop,
        win_left=input_area.left,
        win_top=input_area.top,
        cache_ttl_sec=0.0,
    )
    send_box = None
    for b in boxes:
        if "发送" in (b.text or ""):
            send_box = b
            break
    if send_box is None:
        # 有时识别为「发 送」或带空格
        for b in boxes:
            t = re.sub(r"\s+", "", (b.text or ""))
            if "发送" in t:
                send_box = b
                break
    if send_box is None:
        log.warning("输入区内未 OCR 到「发送」")
        return False

    scx = int((send_box.left + send_box.right) / 2)
    scy = int((send_box.top + send_box.bottom) / 2)
    # 输入框在发送钮左侧
    inp_x = max(
        input_area.left + 40,
        min(input_area.right - 80, send_box.left - int(input_area.w * 0.35)),
    )
    inp_y = scy

    try:
        pyautogui.click(inp_x, inp_y)
        time.sleep(0.12)
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.05)
        pyautogui.press("delete")
        time.sleep(0.06)
        pyperclip.copy(body)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(max(0.2, float(settings.vision_capture_settle_sec)))
        human_delay()
        pyautogui.click(scx, scy)
        time.sleep(0.35)
        return True
    except Exception as exc:
        log.exception("vision 发送异常: %s", exc)
        return False
