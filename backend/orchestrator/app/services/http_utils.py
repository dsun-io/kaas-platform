"""Kaas v2 · HTTP 工具封装 (§13.3)

带重试+超时+错误处理的 httpx 请求工具。
"""
import os
import asyncio
import httpx

RETRY_MAX = int(os.getenv("EXTERNAL_API_RETRY_MAX", "2"))
RETRY_BACKOFF = [1, 3]  # seconds


async def retry_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    retries: int = RETRY_MAX,
    **kwargs,
) -> httpx.Response:
    """带重试的 httpx 请求。

    重试条件: 5xx / httpx.TimeoutException / httpx.ConnectError
    不重试: 4xx（业务错误）
    """
    last_exc = None
    for attempt in range(retries + 1):
        try:
            resp = await client.request(method, url, **kwargs)
            if resp.status_code < 500:
                return resp
            last_exc = httpx.HTTPStatusError(
                f"Server error {resp.status_code}",
                request=resp.request,
                response=resp,
            )
        except (httpx.TimeoutException, httpx.ConnectError) as e:
            last_exc = e
        if attempt < retries:
            await asyncio.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
    raise last_exc
