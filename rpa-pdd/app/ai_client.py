import time
from typing import Any

import httpx

from app.config import settings
from app.logger import get_logger

_FALLBACK = "稍等，我帮您转接人工客服"
log = get_logger("ai_client")


def chat(
    *,
    buyer_id: str,
    message: str,
    conversation_id: str | None,
) -> tuple[str, str | None, int, str | None]:
    if settings.ai_stub_mode:
        elapsed = 0
        reply = (settings.ai_stub_reply or "").strip() or "回复测试~"
        return reply, conversation_id, elapsed, None

    payload: dict[str, Any] = {
        "platform": "pdd",
        "buyer_id": buyer_id,
        "message": message,
    }
    if conversation_id:
        payload["conversation_id"] = conversation_id

    headers: dict[str, str] = {"Content-Type": "application/json"}
    key = settings.msg_router_api_key.strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"

    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=settings.ai_http_timeout_sec) as client:
            r = client.post(settings.chat_endpoint, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        elapsed = int((time.perf_counter() - t0) * 1000)
        log.warning("chat http error buyer=%s err=%s", buyer_id, exc)
        return _FALLBACK, conversation_id, elapsed, "http_error"

    elapsed = int((time.perf_counter() - t0) * 1000)
    if r.status_code >= 400:
        log.warning(
            "chat bad status buyer=%s status=%s body=%s",
            buyer_id,
            r.status_code,
            (r.text or "")[:500],
        )
        return _FALLBACK, conversation_id, elapsed, "bad_status"

    try:
        data = r.json()
    except ValueError:
        log.warning("chat json decode failed buyer=%s", buyer_id)
        return _FALLBACK, conversation_id, elapsed, "json_decode"

    reply = (data.get("reply") or "").strip() or _FALLBACK
    new_conv = data.get("conversation_id")
    conv_out = new_conv if isinstance(new_conv, str) and new_conv.strip() else conversation_id
    return reply, conv_out, elapsed, None
