"""
Kaas v2 · AUTH-WX-R1: 账号注册/登录/登出/me
──────────────────────────────────────────
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me

规则:
- internal 账号只能通过种子数据/后台创建（register 拒绝 internal）
- customer 账号注册后需绑定 customer（admin 操作或注册时指定）
- /auth/me 返回当前用户 + 绑定 customer 信息
"""
import structlog
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.session import get_db_session
from app.db.models import User, Customer, UserCustomer
from app.core.auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_auth_context,
    AuthContext,
)
from app.schemas.auth import RegisterRequest, LoginRequest

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register")
async def register(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """注册新用户。

    规则:
    - internal 注册被拒绝（仅能通过种子/后台创建）
    - customer 注册允许，但注册后不自动绑定 customer（需 admin 绑定）
    """
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")
    display_name = body.get("display_name", "").strip()
    account_type = body.get("account_type", "customer")

    # 校验
    if not email or not password or not display_name:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "email, password, display_name are required"},
        )

    if account_type not in ("internal", "customer"):
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "account_type must be 'internal' or 'customer'"},
        )

    # 禁止公网注册 internal
    if account_type == "internal":
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "Internal accounts cannot be created via public registration"},
        )

    if len(password) < 6:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "Password must be at least 6 characters"},
        )

    # 检查是否已存在
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        return JSONResponse(
            status_code=409,
            content={"error": "conflict", "message": "Email already registered"},
        )

    # 创建用户
    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
        account_type=account_type,
        status="active",
    )
    db.add(user)
    await db.flush()

    # 签发 token
    token = create_access_token(user.id, account_type)

    logger.info("user_registered", user_id=user.id, email=email, account_type=account_type)

    return JSONResponse(
        status_code=201,
        content={
            "user_id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "account_type": account_type,
            "customer_id": None,
            "customer_name": None,
            "tenant_id": None,
            "access_token": token,
            "token_type": "bearer",
        },
    )


@router.post("/login")
async def login(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """登录。"""
    body = await request.json()
    email = body.get("email", "").strip().lower()
    password = body.get("password", "")

    if not email or not password:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "email and password are required"},
        )

    # 查用户
    stmt = select(User).where(User.email == email)
    result = await db.execute(stmt)
    user = result.scalar_one_or_none()

    if user is None or not verify_password(password, user.password_hash):
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Invalid email or password"},
        )

    if user.status != "active":
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "Account is disabled"},
        )

    # 查绑定 customer
    customer_id = None
    customer_code = None
    customer_name = None
    tenant_id = None
    uc_stmt = select(UserCustomer).where(UserCustomer.user_id == user.id)
    uc_result = await db.execute(uc_stmt)
    uc = uc_result.scalar_one_or_none()
    if uc:
        customer_id = uc.customer_id
        c_stmt = select(Customer).where(Customer.id == customer_id)
        c_result = await db.execute(c_stmt)
        customer = c_result.scalar_one_or_none()
        if customer:
            customer_code = customer.code
            customer_name = customer.name
            tenant_id = customer.tenant_id

    # 签发 token
    token = create_access_token(user.id, user.account_type)

    logger.info("user_login", user_id=user.id, account_type=user.account_type)

    return JSONResponse(
        status_code=200,
        content={
            "user_id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "account_type": user.account_type,
            "customer_id": customer_id,
            "customer_code": customer_code,
            "customer_name": customer_name,
            "tenant_id": tenant_id,
            "access_token": token,
            "token_type": "bearer",
        },
    )


@router.post("/logout")
async def logout(request: Request):
    """登出（stateless JWT — 客户端丢弃 token 即可）。"""
    return JSONResponse(
        status_code=200,
        content={"message": "Logged out (client should discard token)"},
    )


@router.get("/me")
async def me(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """获取当前用户信息。"""
    # 查用户完整信息
    user_stmt = select(User).where(User.id == auth.user_id)
    user_result = await db.execute(user_stmt)
    user = user_result.scalar_one_or_none()

    customer_id = auth.customer_id
    customer_name = auth.customer_name
    tenant_id = auth.tenant_id

    if customer_id is None and auth.is_customer():
        uc_stmt = select(UserCustomer).where(UserCustomer.user_id == auth.user_id)
        uc_result = await db.execute(uc_stmt)
        uc = uc_result.scalar_one_or_none()
        if uc:
            customer_id = uc.customer_id
            c_stmt = select(Customer).where(Customer.id == customer_id)
            c_result = await db.execute(c_stmt)
            customer = c_result.scalar_one_or_none()
            if customer:
                customer_name = customer.name
                tenant_id = customer.tenant_id

    return JSONResponse(
        status_code=200,
        content={
            "user_id": auth.user_id,
            "email": user.email if user else "",
            "display_name": user.display_name if user else "",
            "account_type": auth.account_type,
            "customer_id": customer_id,
            "customer_name": customer_name,
            "tenant_id": tenant_id,
        },
    )
