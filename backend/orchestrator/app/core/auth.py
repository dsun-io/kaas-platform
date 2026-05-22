"""
Kaas v2 · AUTH-WX-R1: JWT 鉴权 + 密码哈希 + Auth Context
────────────────────────────────────────────────────────
JWT 签发/验证、密码哈希、Auth Context 提取。
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

import bcrypt
import jwt
from fastapi import Request, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.session import get_db_session
from app.db.models import User, UserCustomer
from app.config.settings import settings

# ── JWT 配置 ──
JWT_SECRET = settings.jwt_secret
JWT_ALGORITHM = settings.jwt_algorithm
JWT_EXPIRE_MINUTES = settings.jwt_expire_minutes


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def create_access_token(user_id: int, account_type: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MINUTES)
    payload = {
        "sub": str(user_id),
        "account_type": account_type,
        "iat": datetime.now(timezone.utc),
        "exp": expire,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    """验证并解码 JWT，失败时抛出异常。"""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


# ── Auth Context ──

class AuthContext:
    """统一鉴权上下文，注入到 request.state.auth"""
    def __init__(
        self,
        user_id: int,
        account_type: str,
        role: str = "user",
        plan: str = "free",
        customer_id: Optional[int] = None,
        customer_code: Optional[str] = None,
        customer_name: Optional[str] = None,
        tenant_id: Optional[str] = None,
    ):
        self.user_id = user_id
        self.account_type = account_type
        self.role = role
        self.plan = plan
        self.customer_id = customer_id
        self.customer_code = customer_code
        self.customer_name = customer_name
        self.tenant_id = tenant_id

    def is_internal(self) -> bool:
        return self.account_type == "internal"

    def is_customer(self) -> bool:
        return self.account_type == "customer"

    def is_admin(self) -> bool:
        return self.role in ("system_admin", "admin")

    @property
    def customer_id_str(self) -> str:
        return self.customer_code or str(self.customer_id) if self.customer_id else ""

    def to_dict(self) -> dict:
        return {
            "user_id": self.user_id,
            "account_type": self.account_type,
            "role": self.role,
            "plan": self.plan,
            "customer_id": self.customer_id,
            "customer_code": self.customer_code,
            "customer_name": self.customer_name,
            "tenant_id": self.tenant_id,
        }


async def get_auth_context(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
) -> AuthContext:
    """FastAPI 依赖：从请求中提取 Auth Context。

    优先从 request.state.auth 获取（由 AuthMiddleware 注入），
    兼容开发阶段 header fallback。
    """
    # 优先从 middleware 注入的 auth context 获取
    auth = getattr(request.state, "auth", None)
    if auth is not None:
        return auth

    # 兼容：从 Authorization header 直接解析
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        try:
            payload = decode_access_token(token)
            user_id = int(payload["sub"])
            account_type = payload.get("account_type", "customer")

            # 查用户
            stmt = select(User).where(User.id == user_id, User.status == "active")
            result = await db.execute(stmt)
            user = result.scalar_one_or_none()

            if user is None:
                raise HTTPException(status_code=401, detail={"error": "unauthorized", "message": "User not found or disabled"})

            # 查绑定 customer
            customer_id = None
            customer_code = None
            customer_name = None
            if account_type == "customer":
                uc_stmt = select(UserCustomer).where(UserCustomer.user_id == user_id)
                uc_result = await db.execute(uc_stmt)
                uc = uc_result.scalar_one_or_none()
                if uc is None:
                    raise HTTPException(status_code=403, detail={"error": "forbidden", "message": "Customer account not bound to any customer"})
                customer_id = uc.customer_id

                from app.db.models import Customer
                c_stmt = select(Customer).where(Customer.id == customer_id)
                c_result = await db.execute(c_stmt)
                customer = c_result.scalar_one_or_none()
                if customer:
                    customer_code = customer.code
                    customer_name = customer.name

            tenant_id = customer.tenant_id if customer else getattr(request.state, "tenant_id", None)

            return AuthContext(
                user_id=user_id,
                account_type=account_type,
                role=getattr(user, "role", "user"),
                plan=getattr(user, "plan", "free"),
                customer_id=customer_id,
                customer_code=customer_code,
                customer_name=customer_name,
                tenant_id=tenant_id,
            )
        except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
            raise HTTPException(status_code=401, detail={"error": "unauthorized", "message": "Invalid or expired token"})

    raise HTTPException(status_code=401, detail={"error": "unauthorized", "message": "Authentication required"})


async def get_optional_auth_context(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
) -> Optional[AuthContext]:
    """可选鉴权 — 用于公共/混合接口。无 token 时返回 None 而非 401。"""
    auth = getattr(request.state, "auth", None)
    if auth is not None:
        return auth

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    try:
        return await get_auth_context(request, db)
    except HTTPException:
        return None


def require_customer_access(auth: AuthContext, target_customer_id: int) -> bool:
    """校验 auth context 是否有权访问指定 customer 的数据。

    - internal 账号：可访问所有 customer
    - customer 账号：只能访问自己绑定的 customer
    """
    if auth.is_internal():
        return True
    return auth.customer_id == target_customer_id
