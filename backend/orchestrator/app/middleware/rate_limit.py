"""Kaas v2 · Rate Limiter (§15.1)

基于 slowapi 的每租户限流中间件。
key = "{tenant_id}:{ip}" 确保不同租户独立限流。
"""
import os
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded


def get_rate_limit_key(request):
    tenant_id = request.headers.get("X-Tenant-Id", "unknown")
    ip = get_remote_address(request)
    return f"{tenant_id}:{ip}"


limiter = Limiter(
    key_func=get_rate_limit_key,
    default_limits=[os.getenv("RATE_LIMIT_DEFAULT", "100/minute")],
    storage_uri=os.getenv("RATE_LIMIT_STORAGE", "memory://"),
)


def setup_rate_limiter(app):
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


async def _rate_limit_exceeded_handler(request, exc):
    from fastapi.responses import JSONResponse
    return JSONResponse(
        status_code=429,
        content={
            "error_code": "RATE_LIMIT_EXCEEDED",
            "message": str(exc),
            "retry_after_seconds": getattr(exc, "retry_after", 60),
        },
    )
