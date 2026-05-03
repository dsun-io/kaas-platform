import random
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from app.domain.tenant_config import load_tenant_config


class SamplingMiddleware(BaseHTTPMiddleware):
    """
    采样中间件（最外层）。
    通过 X-Tenant-Id header 直接查找租户 sampling_rate（不依赖 TenantContext 注入）。
    管理 API 和错误响应强制 100% 采样。
    """

    async def dispatch(self, request: Request, call_next):
        sampling_rate = 0.1

        tenant_id = request.headers.get("X-Tenant-Id")
        if tenant_id:
            tenant_config = load_tenant_config(tenant_id)
            if tenant_config:
                sampling_rate = tenant_config.get("feature_flags", {}).get(
                    "sampling_rate", 0.1
                )

        request.state.sampled = random.random() < sampling_rate

        if request.url.path.startswith("/api/v1/admin"):
            request.state.sampled = True

        response = await call_next(request)

        if response.status_code >= 400:
            request.state.sampled = True

        response.headers["X-Sampled"] = str(request.state.sampled).lower()
        return response
