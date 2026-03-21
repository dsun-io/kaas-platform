from typing import Any

import httpx

from app.config import settings

_FALLBACK_REPLY = "稍等，我帮您转接人工客服"


def _extract_message_content(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    msg = (choices[0] or {}).get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                t = item.get("text") or {}
                if isinstance(t, dict) and t.get("content"):
                    parts.append(str(t["content"]))
                elif item.get("content"):
                    parts.append(str(item["content"]))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p).strip()
    return ""


async def chat_completion(
    *,
    user_message: str,
    chat_id: str,
) -> tuple[str, bool]:
    """
    调用 FastGPT OpenAPI。
    返回 (reply_text, api_error)。
    """
    base = settings.fastgpt_api_base.rstrip("/")
    url = f"{base}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {settings.fastgpt_api_key}",
        "Content-Type": "application/json",
    }
    payload: dict[str, Any] = {
        "chatId": chat_id,
        "stream": False,
        "detail": False,
        "messages": [{"role": "user", "content": user_message}],
        "variables": {},
    }
    timeout = httpx.Timeout(settings.fastgpt_timeout_seconds)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except httpx.HTTPError:
        return _FALLBACK_REPLY, True

    try:
        data = resp.json()
    except ValueError:
        return _FALLBACK_REPLY, True

    if resp.status_code >= 400:
        return _FALLBACK_REPLY, True

    err = data.get("error")
    if err:
        return _FALLBACK_REPLY, True

    text = _extract_message_content(data)
    if not text:
        return _FALLBACK_REPLY, True
    return text, False
