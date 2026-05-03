from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from app.domain.tenant_config import load_tenant_config

_VALID_VERSIONS = frozenset({"v1", "v2"})


class RouteVersionMiddleware(BaseHTTPMiddleware):
    """
    路由版本中间件。
    根据 X-Route-Version header 决定路由版本，缺失时从租户 feature_flags.use_v2 回退。
    X-Route-Version 不识别 → 400。
    """

    async def dispatch(self, request: Request, call_next):
        header_version = request.headers.get("X-Route-Version")

        if header_version is not None:
            if header_version not in _VALID_VERSIONS:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "invalid_route_version",
                        "message": f"X-Route-Version must be 'v1' or 'v2', got '{header_version}'",
                    },
                )
            request.state.route_version = header_version
        else:
            # 回退：从租户配置读取 use_v2 标志
            tenant_id = request.headers.get("X-Tenant-Id")
            use_v2 = False
            if tenant_id:
                tenant_config = load_tenant_config(tenant_id)
                if tenant_config:
                    use_v2 = tenant_config.get("feature_flags", {}).get("use_v2", False)
            request.state.route_version = "v2" if use_v2 else "v1"

        response = await call_next(request)
        response.headers["X-Route-Version"] = request.state.route_version
        return response
