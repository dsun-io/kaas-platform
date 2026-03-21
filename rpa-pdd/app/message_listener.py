from __future__ import annotations

import json
import re
import threading
from collections import deque
from typing import Any

from playwright.sync_api import Page

from app.logger import get_logger

log = get_logger("message_listener")

_MAX_QUEUE = 200
_TIME_RE = re.compile(r"\b\d{1,2}:\d{2}(?::\d{2})?\b")


def _walk_json_for_texts(obj: Any, out: list[str]) -> None:
    if isinstance(obj, dict):
        for k, v in obj.items():
            lk = str(k).lower()
            if isinstance(v, str) and v.strip():
                if any(x in lk for x in ("content", "message", "text", "body", "msg")):
                    if len(v.strip()) >= 2:
                        out.append(v.strip())
            _walk_json_for_texts(v, out)
    elif isinstance(obj, list):
        for x in obj:
            _walk_json_for_texts(x, out)
    elif isinstance(obj, str):
        s = obj.strip()
        if len(s) >= 2 and (s.startswith("{") or s.startswith("[")):
            try:
                _walk_json_for_texts(json.loads(s), out)
            except Exception:
                pass


def parse_ws_payload(data: str | bytes) -> list[str]:
    if data is None:
        return []
    if isinstance(data, (bytes, bytearray)):
        text = bytes(data).decode("utf-8", errors="ignore")
    else:
        text = str(data)
    text = text.strip()
    if not text:
        return []
    out: list[str] = []
    try:
        parsed = json.loads(text)
        _walk_json_for_texts(parsed, out)
    except Exception:
        if len(text) >= 2:
            out.append(text)
    seen: set[str] = set()
    uniq: list[str] = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def extract_time_token(text: str) -> str | None:
    m = _TIME_RE.search(text or "")
    return m.group(0) if m else None


class MessageListener:
    """方案 A：监听 WebSocket 帧，解析疑似聊天 JSON；方案 B 由 main 轮询 DOM。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queue: deque[dict[str, Any]] = deque(maxlen=_MAX_QUEUE)
        self._attached_page_id: int | None = None

    def attach(self, page: Page) -> None:
        # 同一 Page 重复 page.on("websocket") 会叠加监听器，导致帧重复入队
        try:
            pid = id(page)
        except Exception:
            pid = None
        if pid is not None and self._attached_page_id == pid:
            return
        self._attached_page_id = pid

        def on_ws(ws) -> None:
            try:
                ws.on("framereceived", self._on_frame)
            except Exception as exc:
                log.debug("ws attach failed: %s", exc)

        page.on("websocket", on_ws)
        log.info("已注册 WebSocket 监听（framereceived）")

    def _normalize_frame_payload(self, frame: Any) -> str | None:
        if isinstance(frame, str):
            return frame
        if isinstance(frame, (bytes, bytearray)):
            return bytes(frame).decode("utf-8", errors="ignore")
        t = getattr(frame, "text", None)
        if isinstance(t, str) and t.strip():
            return t
        try:
            fn = getattr(frame, "binary", None)
            bb = fn() if callable(fn) else fn
            if bb:
                return bytes(bb).decode("utf-8", errors="ignore")
        except Exception:
            pass
        return None

    def _on_frame(self, payload: Any) -> None:
        try:
            raw = self._normalize_frame_payload(payload)
            if not raw:
                return
            texts = parse_ws_payload(raw)
            if not texts:
                return
            with self._lock:
                for t in texts:
                    self._queue.append(
                        {
                            "source": "websocket",
                            "text": t,
                            "time_token": extract_time_token(t),
                        }
                    )
        except Exception as exc:
            log.debug("frame handler: %s", exc)

    def drain(self) -> list[dict[str, Any]]:
        with self._lock:
            out = list(self._queue)
            self._queue.clear()
            return out
