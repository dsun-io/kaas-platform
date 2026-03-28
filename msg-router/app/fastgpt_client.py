import json
import logging
from typing import Any

import httpx

from app.config import settings

log = logging.getLogger("fastgpt_client")

_FALLBACK_REPLY = "稍等，我帮您转接人工客服"
_CLIENT: httpx.AsyncClient | None = None


async def _get_client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None:
        timeout = httpx.Timeout(settings.fastgpt_timeout_seconds)
        _CLIENT = httpx.AsyncClient(timeout=timeout)
    return _CLIENT


async def close_client() -> None:
    global _CLIENT
    if _CLIENT is not None:
        await _CLIENT.aclose()
        _CLIENT = None


def _extract_from_response_data(obj: Any, depth: int = 0) -> str:
    """从 detail=true 时的 responseData（嵌套列表/字典）中尽力提取可读文本。"""
    if depth > 12:
        return ""
    if isinstance(obj, str) and obj.strip():
        return obj.strip()
    if isinstance(obj, list):
        for item in obj:
            t = _extract_from_response_data(item, depth + 1)
            if t:
                return t
    if isinstance(obj, dict):
        for k in (
            "text",
            "content",
            "value",
            "message",
            "answer",
            "result",
            "output",
            "response",
            "pluginOutput",
            "toolOutput",
        ):
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
            if isinstance(v, (dict, list)):
                t = _extract_from_response_data(v, depth + 1)
                if t:
                    return t
        for v in obj.values():
            t = _extract_from_response_data(v, depth + 1)
            if t:
                return t
    return ""


def _extract_message_content(data: dict[str, Any]) -> str:
    choices = data.get("choices") or []
    if not choices:
        return ""
    msg = (choices[0] or {}).get("message") or {}
    content = msg.get("content")
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, dict):
        t = _extract_from_response_data(content)
        if t:
            return t
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
    rc = msg.get("reasoning_content")
    if isinstance(rc, str) and rc.strip():
        return rc.strip()
    return ""


def _extract_any_reply(data: dict[str, Any]) -> str:
    inner = data.get("data")
    if isinstance(inner, dict):
        text = _extract_any_reply(inner)
        if text:
            return text

    for k in ("answer", "text", "result", "output"):
        v = data.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()

    text = _extract_message_content(data)
    if text:
        return text
    rd = data.get("responseData")
    if rd is not None:
        text = _extract_from_response_data(rd)
        if text:
            return text
    return ""


def _log_failure(reason: str, *, status: int | None = None, body: str | None = None) -> None:
    if not settings.fastgpt_log_failures:
        return
    snippet = ""
    if body:
        snippet = body[:1200].replace("\n", " ")
        if len(body) > 1200:
            snippet += "..."
    log.warning("FastGPT %s status=%s snippet=%s", reason, status, snippet or "(no body)")


async def chat_completion(
    *,
    user_message: str,
    chat_id: str,
    variables: dict[str, Any] | None = None,
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
        "detail": settings.fastgpt_chat_detail,
        "messages": [{"role": "user", "content": user_message}],
        "variables": dict(variables) if variables else {},
    }
    try:
        client = await _get_client()
        resp = await client.post(url, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        _log_failure(f"http_error {exc!r}", status=None, body=None)
        return _FALLBACK_REPLY, True

    body_text = resp.text
    try:
        data = resp.json()
    except ValueError:
        _log_failure("json_decode", status=resp.status_code, body=body_text)
        return _FALLBACK_REPLY, True

    if resp.status_code >= 400:
        _log_failure("http_status", status=resp.status_code, body=body_text)
        return _FALLBACK_REPLY, True

    err = data.get("error")
    if err:
        try:
            err_s = json.dumps(err, ensure_ascii=False)[:800]
        except Exception:
            err_s = str(err)[:800]
        _log_failure(f"api_error {err_s}", status=resp.status_code, body=body_text)
        return _FALLBACK_REPLY, True

    text = _extract_any_reply(data)
    if not text:
        _log_failure("empty_content", status=resp.status_code, body=body_text)
        return _FALLBACK_REPLY, True
    return text, False
