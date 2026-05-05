"""
Kaas v2 · AUTH-WX-R1: JWT 鉴权中间件
────────────────────────────────────
从 Authorization: Bearer <token> 验证 JWT，注入 AuthContext 到 request.state。

公共路径豁免列表与 TenantContextMiddleware 一致。
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from app.core.auth import decode_access_token, AuthContext
from app.db.models import User, UserCustomer, Customer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# 不需要鉴权的路径前缀
_PUBLIC_PATHS = frozenset([
    "/health",
    "/docs",
    "/openapi.json",
    "/redoc",
    "/metrics",
    "/api/v1/auth/register",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
])


class AuthContextMiddleware(BaseHTTPMiddleware):
    """JWT 鉴权中间件。

    从 Authorization header 提取 Bearer token，
    验证 JWT，查询用户和 customer 绑定，
    注入 request.state.auth (AuthContext)。

    公共路径（/health, /auth/login, /auth/register 等）跳过鉴权。
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # 公共路径豁免
        if any(path.startswith(p) for p in _PUBLIC_PATHS):
            return await call_next(request)

        # 提取 token
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return JSONResponse(
                status_code=401,
                content={
                    "error": "unauthorized",
                    "message": "Authorization: Bearer <token> required",
                },
            )

        token = auth_header[7:]

        # 验证 JWT
        try:
            payload = decode_access_token(token)
        except Exception:
            return JSONResponse(
                status_code=401,
                content={
                    "error": "unauthorized",
                    "message": "Invalid or expired token",
                },
            )

        user_id = int(payload["sub"])
        account_type = payload.get("account_type", "customer")

        # 查询用户和 customer 绑定
        from app.db.session import async_session_factory

        async with async_session_factory() as db:
            try:
                stmt = select(User).where(User.id == user_id, User.status == "active")
                result = await db.execute(stmt)
                user = result.scalar_one_or_none()

                if user is None:
                    return JSONResponse(
                        status_code=401,
                        content={
                            "error": "unauthorized",
                            "message": "User not found or disabled",
                        },
                    )

                customer_id = None
                customer_code = None
                customer_name = None
                tenant_id = None

                if account_type == "customer":
                    uc_stmt = select(UserCustomer).where(UserCustomer.user_id == user_id)
                    uc_result = await db.execute(uc_stmt)
                    uc = uc_result.scalar_one_or_none()
                    if uc is None:
                        return JSONResponse(
                            status_code=403,
                            content={
                                "error": "forbidden",
                                "message": "Customer account must be bound to a customer",
                            },
                        )
                    customer_id = uc.customer_id

                if customer_id:
                    c_stmt = select(Customer).where(Customer.id == customer_id)
                    c_result = await db.execute(c_stmt)
                    customer = c_result.scalar_one_or_none()
                    if customer:
                        customer_code = customer.code
                        customer_name = customer.name
                        tenant_id = customer.tenant_id

                # 注入 auth context
                request.state.auth = AuthContext(
                    user_id=user_id,
                    account_type=account_type,
                    customer_id=customer_id,
                    customer_code=customer_code,
                    customer_name=customer_name,
                    tenant_id=tenant_id,
                )

                response = await call_next(request)
                return response

            except Exception as e:
                return JSONResponse(
                    status_code=500,
                    content={
                        "error": "internal_error",
                        "message": "Auth middleware error",
                    },
                )
