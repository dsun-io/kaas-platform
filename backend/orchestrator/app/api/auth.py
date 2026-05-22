"""
Kaas v2 · AUTH-WX-R1: 账号注册/登录/登出/me/bootstrap-admin
──────────────────────────────────────────────────────────
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/bootstrap-admin

规则:
- 注册强制 customer + owner + free，忽略 body 中的 account_type/role/plan（反伪造）
- internal 账号只能通过 bootstrap-admin 或种子数据创建
- bootstrap-admin 仅当 ADMIN_SETUP_TOKEN 已配置且无 system_admin 时可用（一次性）
"""
import uuid
import secrets
import hmac
import re
from typing import Optional

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
from app.config.settings import settings

logger = structlog.get_logger(__name__)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])

_CATEGORIES = frozenset([
    "fencing",
    "mesh_panel_roll",
    "woven_mesh",
    "welded_mesh",
    "perforated_mesh",
    "wire_rope",
    "filter_mesh",
    "gabion_protection",
    "custom_wire_mesh",
    "other",
])

_SLUG_RE = re.compile(r"[^a-z0-9_]")


def _slugify(name: str) -> str:
    """将公司名转为 slug，用于生成 customer code。"""
    slug = name.strip().lower()
    slug = _SLUG_RE.sub("_", slug)
    slug = re.sub(r"_+", "_", slug).strip("_")
    return slug[:24] if slug else "cust"


def _constant_time_compare(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


async def _find_user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def _get_customer_binding(db: AsyncSession, user: User) -> dict:
    """查询用户的 customer 绑定信息。"""
    uc_result = await db.execute(
        select(UserCustomer).where(UserCustomer.user_id == user.id)
    )
    uc = uc_result.scalar_one_or_none()
    if uc is None:
        return {"customer_id": None, "customer_code": None, "customer_name": None, "tenant_id": None}

    c_result = await db.execute(select(Customer).where(Customer.id == uc.customer_id))
    customer = c_result.scalar_one_or_none()
    if customer is None:
        return {"customer_id": uc.customer_id, "customer_code": None, "customer_name": None, "tenant_id": None}

    return {
        "customer_id": customer.id,
        "customer_code": customer.code,
        "customer_name": customer.name,
        "tenant_id": customer.tenant_id,
    }


def _auth_response(user: User, binding: dict, token: str) -> dict:
    return {
        "user_id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "account_type": user.account_type,
        "role": user.role,
        "plan": user.plan,
        "customer_id": binding["customer_id"],
        "customer_code": binding["customer_code"],
        "customer_name": binding["customer_name"],
        "tenant_id": binding["tenant_id"],
        "access_token": token,
        "token_type": "bearer",
    }


@router.post("/register")
async def register(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """注册新用户（仅限 customer 账号）。

    安全规则（反伪造）:
    - 忽略 body 中的 account_type / role / plan
    - 强制: account_type='customer', role='owner', plan='free'
    - 自动创建 Customer + UserCustomer 绑定
    """
    body = await request.json()

    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()
    company_name = (body.get("company_name") or "").strip()
    product_category = (body.get("product_category") or "").strip().lower()
    contact = (body.get("contact") or "").strip() or None

    # ── 校验 ──
    if not email or not password or not display_name:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "email, password, display_name are required"},
        )

    if not company_name:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "company_name is required"},
        )

    if not product_category or product_category not in _CATEGORIES:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "product_category is required and must be one of: " + ", ".join(sorted(_CATEGORIES))},
        )

    if len(password) < 8:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "Password must be at least 8 characters"},
        )

    if "@" not in email or "." not in email.split("@")[-1]:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "Invalid email format"},
        )

    # ── 检查邮箱唯一 ──
    existing = await _find_user_by_email(db, email)
    if existing is not None:
        return JSONResponse(
            status_code=409,
            content={"error": "conflict", "message": "Email already registered"},
        )

    # ── 创建 User（强制 customer + owner + free） ──
    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
        account_type="customer",
        role="owner",
        plan="free",
        status="active",
    )
    db.add(user)
    await db.flush()

    # ── 生成唯一 tenant_id 和 code ──
    tenant_id = str(uuid.uuid4())
    base_slug = _slugify(company_name) if company_name else "cust"

    # 重试最多 5 次避免 code 碰撞
    code = None
    for _ in range(5):
        candidate = f"{base_slug}_{secrets.token_hex(3)}"
        existing_code = await db.execute(
            select(Customer).where(Customer.code == candidate)
        )
        if existing_code.scalar_one_or_none() is None:
            code = candidate
            break
    if code is None:
        # fallback: use uuid suffix
        code = f"{base_slug}_{uuid.uuid4().hex[:8]}"

    # ── 创建 Customer ──
    customer = Customer(
        tenant_id=tenant_id,
        code=code,
        name=company_name,
        plan="free",
        status="active",
    )
    db.add(customer)
    await db.flush()

    # ── 创建 UserCustomer 绑定 ──
    uc = UserCustomer(user_id=user.id, customer_id=customer.id)
    db.add(uc)

    token = create_access_token(user.id, "customer")

    logger.info("user_registered", user_id=user.id, email=email, tenant_id=tenant_id, code=code)

    return JSONResponse(
        status_code=201,
        content=_auth_response(user, {
            "customer_id": customer.id,
            "customer_code": code,
            "customer_name": company_name,
            "tenant_id": tenant_id,
        }, token),
    )


@router.post("/login")
async def login(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """登录。"""
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""

    if not email or not password:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "email and password are required"},
        )

    user = await _find_user_by_email(db, email)

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

    binding = await _get_customer_binding(db, user)
    token = create_access_token(user.id, user.account_type)

    logger.info("user_login", user_id=user.id, account_type=user.account_type)

    return JSONResponse(
        status_code=200,
        content=_auth_response(user, binding, token),
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
    user_result = await db.execute(select(User).where(User.id == auth.user_id))
    user = user_result.scalar_one_or_none()

    customer_id = auth.customer_id
    customer_code = auth.customer_code
    customer_name = auth.customer_name
    tenant_id = auth.tenant_id

    if customer_id is None and auth.is_customer():
        binding = await _get_customer_binding(db, user) if user else {}
        customer_id = binding.get("customer_id")
        customer_code = binding.get("customer_code")
        customer_name = binding.get("customer_name")
        tenant_id = binding.get("tenant_id")

    if user is None:
        raise HTTPException(status_code=401, detail="unauthorized: User not found")

    return {
        "user_id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "account_type": user.account_type,
        "role": user.role,
        "effective_role": user.effective_role,
        "plan": user.plan,
        "customer_id": customer_id,
        "customer_code": customer_code,
        "customer_name": customer_name,
        "tenant_id": tenant_id,
    }


@router.post("/bootstrap-admin")
async def bootstrap_admin(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """一次性管理员初始化。

    安全规则:
    - ADMIN_SETUP_TOKEN 为空 → 503（未配置）
    - 任一 system_admin 已存在 → 403（已初始化）
    - Token 通过 Authorization: Bearer <token> 传入，常数时间比对
    - 创建后永久禁用此端点
    """
    # ── 检查配置 ──
    if not settings.admin_setup_token:
        return JSONResponse(
            status_code=503,
            content={"error": "not_configured", "message": "ADMIN_SETUP_TOKEN not configured"},
        )

    # ── 检查是否已初始化 ──
    existing_admin = await db.execute(
        select(User).where(
            User.account_type == "internal",
            User.role == "system_admin",
        )
    )
    if existing_admin.scalar_one_or_none() is not None:
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "System already initialized. A system_admin exists."},
        )

    # ── 提取 token ──
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse(
            status_code=401,
            content={"error": "unauthorized", "message": "Authorization: Bearer <token> required"},
        )
    provided_token = auth_header[7:]

    # ── 常数时间比对 ──
    if not _constant_time_compare(provided_token, settings.admin_setup_token):
        return JSONResponse(
            status_code=403,
            content={"error": "forbidden", "message": "Invalid setup token"},
        )

    # ── 读取请求体 ──
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()

    if not email or not password or not display_name:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "email, password, display_name are required"},
        )

    if len(password) < 8:
        return JSONResponse(
            status_code=422,
            content={"error": "validation_error", "message": "Password must be at least 8 characters"},
        )

    # ── 检查邮箱唯一 ──
    existing = await _find_user_by_email(db, email)
    if existing is not None:
        return JSONResponse(
            status_code=409,
            content={"error": "conflict", "message": "Email already registered"},
        )

    # ── 创建 system_admin ──
    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
        account_type="internal",
        role="system_admin",
        plan="internal",
        status="active",
    )
    db.add(user)
    await db.flush()

    token = create_access_token(user.id, "internal")

    logger.info("system_admin_bootstrapped", user_id=user.id, email=email)

    return JSONResponse(
        status_code=201,
        content=_auth_response(user, {
            "customer_id": None,
            "customer_code": None,
            "customer_name": None,
            "tenant_id": None,
        }, token),
    )
