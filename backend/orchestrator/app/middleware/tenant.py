"""
Kaas v2 · 多租户中间件
────────────────────
从 X-Tenant-Id header 提取租户标识，注入到请求 state。
所有 /api/v1/* 路由必须经过此中间件。

设计约束:
- 无默认 tenant_id（必须显式传入）
- 未知租户返回 403
- 健康检查等公共路径豁免
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from app.domain.tenant_config import load_tenant_config

# 不需要租户鉴权的路径前缀
_PUBLIC_PATHS = frozenset([
    "/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/metrics",
])


class TenantContextMiddleware(BaseHTTPMiddleware):
    """
    多租户上下文中间件。

    从请求 header 中提取 X-Tenant-Id，验证租户存在且启用，
    然后将 tenant_id 和 tenant_config 注入 request.state。

    Production 代码中所有 repository 方法必须显式使用
    request.state.tenant_id（不允许 optional/default）。
    """

    async def dispatch(self, request: Request, call_next):
        # 公共路径豁免
        path = request.url.path
        if any(path.startswith(p) for p in _PUBLIC_PATHS):
            return await call_next(request)

        # 提取 tenant_id
        tenant_id = request.headers.get("X-Tenant-Id")

        if not tenant_id:
            return JSONResponse(
                status_code=401,
                content={
                    "error": "tenant_unauthorized",
                    "message": "X-Tenant-Id header is required",
                },
            )

        # 验证租户
        tenant_config = load_tenant_config(tenant_id)
        if tenant_config is None:
            return JSONResponse(
                status_code=403,
                content={
                    "error": "invalid_tenant",
                    "message": f"Tenant '{tenant_id}' not found or disabled",
                },
            )

        # 注入到 request state
        request.state.tenant_id = tenant_id
        request.state.tenant_config = tenant_config

        response = await call_next(request)
        return response
