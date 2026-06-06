from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
import uiautomation as auto

from app.chat_bounds import ChatPanelScreen, compute_chat_panel_screen
from app.config import settings
from app.logger import get_logger
from app.ocr_paddle import OcrTextBox, invalidate_ocr_cache, ocr_bgr_to_boxes, paddle_available
from app.ui_selectors import get_selectors
from app.window_capture import grab_screen_bgr

log = get_logger("chat_ocr_flow")


@dataclass
class ChatOcrContext:
    panel: ChatPanelScreen
    bgr: np.ndarray
    boxes: list[OcrTextBox]


_CACHE_BUYER: str = ""
_CACHE_TS: float = 0.0
_CACHE_CTX: ChatOcrContext | None = None


def _session_right_x(win: auto.Control) -> float:
    wr = win.BoundingRectangle
    ratio = min(0.95, max(0.05, float(get_selectors().session_left_panel_ratio)))
    return float(wr.left) + float(wr.right - wr.left) * ratio


def invalidate_chat_ocr_context() -> None:
    """切换会话后调用：丢弃面板与 OCR 缓存。"""
    global _CACHE_BUYER, _CACHE_TS, _CACHE_CTX
    _CACHE_BUYER = ""
    _CACHE_TS = 0.0
    _CACHE_CTX = None
    invalidate_ocr_cache()


def get_chat_ocr_context(
    win: auto.Control,
    buyer_key: str,
    *,
    force_new: bool,
) -> ChatOcrContext | None:
    """
    截窗 → OCR → 计算聊天列包围盒；3s 内同 buyer 复用（除非 force_new）。
    """
    if not settings.chat_ocr_enabled or not paddle_available():
        return None

    global _CACHE_BUYER, _CACHE_TS, _CACHE_CTX
    now = time.time()
    if (
        not force_new
        and buyer_key
        and _CACHE_BUYER == buyer_key
        and _CACHE_CTX is not None
        and (now - _CACHE_TS) < settings.chat_ocr_cache_sec
    ):
        return _CACHE_CTX

    if force_new:
        invalidate_ocr_cache()

    try:
        wr = win.BoundingRectangle
    except Exception:
        return None

    bgr = grab_screen_bgr(int(wr.left), int(wr.top), int(wr.right), int(wr.bottom))
    if bgr is None or getattr(bgr, "size", 0) == 0:
        log.warning("聊天 OCR：窗口截图失败")
        return None

    if settings.chat_debug_screenshots:
        dbg = Path(settings.chat_debug_dir)
        dbg.mkdir(parents=True, exist_ok=True)
        p = dbg / f"chat_win_{int(now * 1000)}.png"
        try:
            cv2.imwrite(str(p), bgr)
        except Exception as exc:
            log.debug("debug 截图写入失败: %s", exc)

    srx = _session_right_x(win)
    boxes = ocr_bgr_to_boxes(
        bgr,
        win_left=int(wr.left),
        win_top=int(wr.top),
        cache_ttl_sec=settings.chat_ocr_cache_sec,
    )
    panel = compute_chat_panel_screen(wr, srx, boxes)
    ctx = ChatOcrContext(panel=panel, bgr=bgr, boxes=boxes)
    _CACHE_BUYER = buyer_key or ""
    _CACHE_TS = now
    _CACHE_CTX = ctx
    log.debug(
        "聊天面板锚定 left=%s top=%s right=%s bottom=%s send@(%s,%s)",
        panel.left,
        panel.top,
        panel.right,
        panel.bottom,
        panel.send_left,
        panel.send_cy,
    )
    return ctx
