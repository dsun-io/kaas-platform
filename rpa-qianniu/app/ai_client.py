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
) -> tuple[str, str | None, int, str | None]:
    """
    调用消息路由 POST /v1/chat。
    返回 (reply, conversation_id, elapsed_ms, error)。
    error 非 None 表示未拿到正常模型回复（HTTP/JSON 等），reply 可能为兜底话术。
    ai_stub_mode 为 true 时不发起 HTTP，用于只测千牛发送链路。
    """
    if settings.ai_stub_mode:
        t0 = time.perf_counter()
        text = (settings.ai_stub_reply or "回复测试~").strip() or "回复测试~"
        elapsed = int((time.perf_counter() - t0) * 1000)
        return text, conversation_id, elapsed, None

    payload: dict[str, Any] = {
        "platform": "qianniu",
        "buyer_id": buyer_id,
        "message": message,
    }
    if conversation_id:
        payload["conversation_id"] = conversation_id

    headers: dict[str, str] = {"Content-Type": "application/json"}
    key = settings.msg_router_api_key.strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"

    url = settings.chat_endpoint
    t0 = time.perf_counter()
    try:
        with httpx.Client(timeout=settings.ai_http_timeout_sec) as client:
            r = client.post(url, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        elapsed = int((time.perf_counter() - t0) * 1000)
        return _FALLBACK, conversation_id, elapsed, f"http_error:{exc!s}"

    elapsed = int((time.perf_counter() - t0) * 1000)
    if r.status_code >= 400:
        return _FALLBACK, conversation_id, elapsed, f"http_status:{r.status_code}"

    try:
        data = r.json()
    except ValueError:
        return _FALLBACK, conversation_id, elapsed, "json_error"

    reply = (data.get("reply") or "").strip() or _FALLBACK
    new_conv = data.get("conversation_id")
    conv_out = new_conv if isinstance(new_conv, str) and new_conv.strip() else conversation_id
    return reply, conv_out, elapsed, None
