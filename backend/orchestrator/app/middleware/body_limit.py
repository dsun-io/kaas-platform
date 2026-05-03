"""Kaas v2 · 请求体大小限制中间件 (§15.2)

检查 Content-Length header，超过 MAX_BODY_SIZE_BYTES 返回 413。
"""
import os
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

MAX_BODY_SIZE = int(os.getenv("MAX_BODY_SIZE_BYTES", str(1024 * 1024)))


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_BODY_SIZE:
            return JSONResponse(
                status_code=413,
                content={
                    "error_code": "PAYLOAD_TOO_LARGE",
                    "message": f"Body exceeds {MAX_BODY_SIZE} bytes",
                },
            )
        return await call_next(request)
