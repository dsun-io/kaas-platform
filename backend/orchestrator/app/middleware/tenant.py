"""
Kaas v2 · 多租户中间件
────────────────────
从 X-Tenant-Id header 提取租户标识，注入到请求 state。
所有 /api/v1/* 路由必须经过此中间件。

设计约束:
- 无默认 tenant_id（必须显式传入）
- 未知租户返回 403
- 健康检查等公共路径豁免
- 先查 tenants.yaml，回退查 customers 表（支持自注册 UUID 租户）
"""

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from app.domain.tenant_config import load_tenant_config
from sqlalchemy import select
from app.db.models import Customer

# 不需要租户鉴权的路径前缀
_PUBLIC_PATHS = frozenset([
    "/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/metrics",
    "/api/v1/auth/",          # 所有 auth 路径统一豁免
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
        path = request.url.path
        if any(path.startswith(p) for p in _PUBLIC_PATHS):
            return await call_next(request)

        # 如果 AuthContextMiddleware 已为 customer/free 用户注入了真实的 tenant_id，
        # 则跳过 header 验证（避免覆盖 DB 查询结果）
        if hasattr(request.state, "tenant_id") and request.state.tenant_id:
            return await call_next(request)

        # internal 用户无需租户隔离，AuthContextMiddleware 已认证则跳过
        if hasattr(request.state, "auth") and request.state.auth.is_internal():
            return await call_next(request)

        # 提取 tenant_id（忽略空字符串）
        tenant_id = (request.headers.get("X-Tenant-Id") or "").strip()

        if not tenant_id:
            return JSONResponse(
                status_code=401,
                content={
                    "error": "tenant_unauthorized",
                    "message": "X-Tenant-Id header is required",
                },
            )

        # 验证租户: 先查 YAML，回退查 customers 表（自注册 UUID 租户）
        tenant_config = load_tenant_config(tenant_id)
        if tenant_config is None:
            # 回退: 查询 customers 表，支持注册时自动生成的 UUID 租户
            from app.db.session import async_session_factory
            async with async_session_factory() as db:
                try:
                    stmt = select(Customer.id).where(
                        Customer.tenant_id == tenant_id,
                    )
                    result = await db.execute(stmt)
                    customer_id = result.scalar_one_or_none()
                    if customer_id is None:
                        return JSONResponse(
                            status_code=403,
                            content={
                                "error": "invalid_tenant",
                                "message": f"Tenant '{tenant_id}' not found or disabled",
                            },
                        )
                except Exception:
                    return JSONResponse(
                        status_code=403,
                        content={
                            "error": "invalid_tenant",
                            "message": f"Tenant '{tenant_id}' not found or disabled",
                        },
                    )
            # 自注册租户使用默认配置
            tenant_config = {"db_schema": "public", "source": "customer"}

        # 注入到 request state
        request.state.tenant_id = tenant_id
        request.state.tenant_config = tenant_config

        response = await call_next(request)
        return response
