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
from app.db.models import Customer, Team, User, UserCustomer
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

# 平台默认租户。**业务逻辑不以租户做鉴权边界**（2026-10-11 业务确认）：
# 授权靠"账号/团队开通了哪些工位"（订阅），数据隔离靠团队（team_id）。
# 与 Worker（单租户部署，硬编码该值）保持同一口径。
DEFAULT_TENANT = "default"


class AuthContext:
    """统一鉴权上下文，注入到 request.state.auth。

    2026-10-11 拆分「团队 / 用户(账号) / 业务客户」后的语义：
    - `team_id` / `team_name`：账号归属的**团队**（真源 = `users.team_id`，不是绑定）；
    - `console_access`：官网数据后台权限，由团队管理员授予；
    - `customer_id` / `customer_code` / `customer_name`：账号被授权的**业务客户**
      （来自 `user_customers`，有就填、没有就是 None）。**它只是"当前视角"，
      不再是鉴权前提** —— 以前"没绑定就 403"，而绑定指向的公司行已被删除，
      那会把所有 customer 账号锁在门外。
    - `tenant_id`：固定 `"default"`，不参与业务鉴权（见模块顶部注释）。
    """
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
        team_id: Optional[int] = None,
        team_name: Optional[str] = None,
        console_access: bool = False,
    ):
        self.user_id = user_id
        self.account_type = account_type
        self.role = role
        self.plan = plan
        self.customer_id = customer_id
        self.customer_code = customer_code
        self.customer_name = customer_name
        self.tenant_id = tenant_id or DEFAULT_TENANT
        # 三层组织：所属团队。可见性判定用（成员创建的数据本团队可见），
        # 规则真源 = kaas_common/workstation/scope.py
        self.team_id = team_id
        self.team_name = team_name
        self.console_access = bool(console_access)

    def is_internal(self) -> bool:
        return self.account_type == "internal"

    def is_customer(self) -> bool:
        return self.account_type == "customer"

    def is_admin(self) -> bool:
        return self.effective_role == "system_admin"

    @property
    def effective_role(self) -> str:
        """应用层角色映射：旧角色 → 新三层角色体系。"""
        ROLE_MAP = {
            "system_admin": "system_admin",
            "admin": "system_admin",
            "owner": "customer_owner",
            "customer_owner": "customer_owner",
            "user": "customer_member",
            "customer_member": "customer_member",
        }
        return ROLE_MAP.get(self.role, "customer_member")

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
            "team_id": self.team_id,
            "team_name": self.team_name,
            "console_access": self.console_access,
        }


async def load_team_and_console(db: AsyncSession, user: User) -> dict:
    """取「账号 → 团队名 / 业务客户绑定 / 官网数据后台权限」。

    为什么要单独一个函数：**中间件**与**`get_auth_context` 的 header 兜底路径**
    是同一件事的两个入口，各写一份必然漂移（历史上就是一处改、另一处忘）。
    两边都调这一个，判定与取值只有一份实现。

    注意这里**不做任何否决**：绑定查不到就返回 None，绝不再抛 403 ——
    绑定指向的是"业务客户"，与账号能不能登录**无关**。
    """
    binding = {"customer_id": None, "customer_code": None, "customer_name": None}
    if user is None:
        return {"team_name": None, "console_access": False, "binding": binding}

    # 业务客户绑定（0 或 1 条；`user_customers` 无唯一约束，这里取第一条即可）
    uc = (await db.execute(
        select(UserCustomer).where(UserCustomer.user_id == user.id)
        .order_by(UserCustomer.id)
    )).scalars().first()
    if uc is not None:
        binding["customer_id"] = uc.customer_id
        customer = (await db.execute(
            select(Customer).where(Customer.id == uc.customer_id)
        )).scalar_one_or_none()
        if customer is not None:
            binding["customer_code"] = customer.code
            binding["customer_name"] = customer.name

    team_name = None
    if getattr(user, "team_id", None) is not None:
        team_name = (await db.execute(
            select(Team.name).where(Team.id == user.team_id)
        )).scalar_one_or_none()

    return {
        "team_name": team_name,
        "console_access": bool(getattr(user, "console_access", False)),
        "binding": binding,
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

            # 团队名 / 业务客户绑定 / 后台权限：**只取值，不做鉴权否决**
            extra = await load_team_and_console(db, user)

            return AuthContext(
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
