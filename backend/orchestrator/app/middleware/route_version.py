"""
Kaas v2 · 路由版本中间件 (§3.7.17)
──────────────────────────────────
读 X-Use-V2 Header → 确定路由版本。
  - true/1/yes → True
  - false/0/no → False
  - 缺失/非法 → 读 tenants.yaml feature_flags.use_v2 兜底
输出 request.state.use_v2: bool
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from app.domain.tenant_config import load_tenant_config

_V2_TRUTHY = frozenset({"true", "1", "yes"})
_V2_FALSY = frozenset({"false", "0", "no"})


class RouteVersionMiddleware(BaseHTTPMiddleware):
    """路由版本中间件。"""

    async def dispatch(self, request: Request, call_next):
        header_val = request.headers.get("X-Use-V2", "").strip().lower()

        if header_val in _V2_TRUTHY:
            request.state.use_v2 = True
        elif header_val in _V2_FALSY:
            request.state.use_v2 = False
        else:
            # 回退：从租户配置读取
            use_v2 = False
            tenant_id = request.headers.get("X-Tenant-Id")
            if tenant_id:
                tenant_config = load_tenant_config(tenant_id)
                if tenant_config:
                    use_v2 = tenant_config.get("feature_flags", {}).get("use_v2", False)
            request.state.use_v2 = use_v2

        response = await call_next(request)
        response.headers["X-Route-Version"] = "v2" if request.state.use_v2 else "v1"
        return response
