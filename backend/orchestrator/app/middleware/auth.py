"""
Kaas v2 · AUTH-WX-R1: JWT 鉴权中间件
────────────────────────────────────
从 Authorization: Bearer <token> 验证 JWT，注入 AuthContext 到 request.state。

公共路径豁免列表与 TenantContextMiddleware 一致。

2026-10-11 拆分「团队 / 用户(账号) / 业务客户」
----------------------------------------------
本中间件**不再要求 customer 账号有 `user_customers` 绑定**。
原先的判定是"账号必须绑定一个 customer，否则 403"，而那个绑定指向的是
**公司身份行**（`customers.code='lianjia'`）—— 该行已被迁移 202610110008 删除。
若保留旧判定，绑定一删、`customer_id` 变 NULL，**所有 customer 账号都会被锁在门外**。
现在：
- 团队归属看 `users.team_id`（真源），据此取 `team_name`；
- 业务客户绑定只用于填 `customer_id/customer_code/customer_name`（有就填、没有就 None）；
- `tenant_id` 固定 `"default"`（业务不以租户鉴权）。
取值逻辑与 `app.core.auth.get_auth_context` 共用 `load_team_and_console`，避免两处漂移。
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from app.core.auth import DEFAULT_TENANT, decode_access_token, load_team_and_console, AuthContext
from app.db.models import User
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
    "/api/v1/auth/bootstrap-admin",
    "/api/v1/auth/forgot-password",
])


class AuthContextMiddleware(BaseHTTPMiddleware):
    """JWT 鉴权中间件。

    从 Authorization header 提取 Bearer token，
    验证 JWT，查询用户、团队与业务客户绑定，
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

        # 查询用户、团队与业务客户绑定
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

                # 团队名 / 业务客户绑定 / 官网数据后台权限 —— 只取值，不做鉴权否决
                extra = await load_team_and_console(db, user)

                # 租户固定 default（业务不以租户做鉴权边界，与 Worker 同口径）。
                # 同时注入 request.state.tenant_id：下游 TenantContextMiddleware
                # 见到它就不再要求 X-Tenant-Id header。
                request.state.tenant_id = DEFAULT_TENANT

                # 注入 auth context
                request.state.auth = AuthContext(
                    user_id=user_id,
                    account_type=account_type,
                    role=getattr(user, "role", "user"),
                    plan=getattr(user, "plan", "free"),
                    tenant_id=DEFAULT_TENANT,
                    team_id=getattr(user, "team_id", None),
                    team_name=extra["team_name"],
                    console_access=extra["console_access"],
                    **extra["binding"],
                )

                response = await call_next(request)
                return response

            except Exception as e:
                # 记录真实 traceback，避免下游异常被静默吞掉（排查全靠它）
                import structlog
                structlog.get_logger(__name__).exception(
                    "auth.middleware.downstream_error",
                    path=path,
                    error=str(e),
                )
                return JSONResponse(
                    status_code=500,
                    content={
                        "error": "internal_error",
                        "message": "Auth middleware error",
                    },
                )
