import time
from typing import Any

import httpx

from app.config import settings

_FALLBACK = "稍等，我帮您转接人工客服"


def chat(
    *,
    buyer_id: str,
    message: str,
    conversation_id: str | None,
) -> tuple[str, str | None, int]:
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
    except httpx.HTTPError:
        elapsed = int((time.perf_counter() - t0) * 1000)
        return _FALLBACK, conversation_id, elapsed

    elapsed = int((time.perf_counter() - t0) * 1000)
    if r.status_code >= 400:
        return _FALLBACK, conversation_id, elapsed

    try:
        data = r.json()
    except ValueError:
        return _FALLBACK, conversation_id, elapsed

    reply = (data.get("reply") or "").strip() or _FALLBACK
    new_conv = data.get("conversation_id")
    conv_out = new_conv if isinstance(new_conv, str) and new_conv.strip() else conversation_id
    return reply, conv_out, elapsed
