"""Kaas v2 · Rate Limiter (§15.1)

基于 slowapi 的限流中间件。key = ``"{tenant_id}:{ip}"``。

**关于 key 里的 tenant_id（2026-10-11 说明）**
`tenant_id` 已全量统一为 ``"default"``（迁移 `202610110005` unify_tenant），
**租户不再是隔离边界，团队（team_id）才是**。所以 key 里的 tenant 部分
实际上恒为同一个值，真正起区分作用的是 **IP**。

前端也**不再发** `X-Tenant-Id` 了（那个值是从 localStorage 里过期的
`kaas_user` 反推的，可能早已失效）。因此这里读不到头时会落到
``"unknown"`` —— 与原先"所有人都发同一个 default"是**同一种分桶**，
限流效果不变。

保留这个前缀而不是改成 team_id，是因为**限流应当在鉴权之前就能判定**
（中间件先于 AuthContext 生效，那时拿不到可靠的 team_id）。
真要做"按团队限流"，得先在中间件层拿到团队身份 —— 那是另一件事。
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
