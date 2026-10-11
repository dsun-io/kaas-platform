"""
Kaas v2 · AUTH-WX-R1: 账号注册/登录/登出/me/bootstrap-admin
──────────────────────────────────────────────────────────
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/bootstrap-admin

规则:
- 注册强制 customer + free，忽略 body 中的 account_type/role/plan（反伪造）
- 注册可选带 `invite_token`（凭码加入现有团队）或 `team_name`（新建团队，成为团队管理员）；
  两者都不带时，注册者是一个**没有团队的独立账号**（团队归属真源 = `users.team_id`）
- internal 账号只能通过 bootstrap-admin 或种子数据创建
- bootstrap-admin 仅当 ADMIN_SETUP_TOKEN 已配置且无 system_admin 时可用（一次性）

2026-10-11 拆分「团队 / 用户(账号) / 业务客户」
------------------------------------------------
注册**不再为注册者创建 `customers` 行**：那一行原来是"公司身份"，
现在公司身份由 `teams` 承载，而 `customers` 表**只放业务客户**
（客户工位里录入的"我的客户"）。因此：
- `POST /register`、`POST /login`、`GET /me` 的响应体**去掉 `customer_*`**，
  改为 `team_id` / `team_name` / `console_access`（前端契约 `frontend/src/lib/auth/types.ts` 已同口径）；
- 账号能不能登录/鉴权与"有没有绑定业务客户"**彻底无关**（旧逻辑"没绑定就 403"会把
  公司行被删之后的所有账号锁在门外）。
"""
import hmac
from typing import Optional

import structlog
from fastapi import APIRouter, Request, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.session import get_db_session
from app.db.models import User, Team, TeamSubscription

# 平台默认租户。**业务逻辑不以租户做鉴权边界**（2026-10-11 业务确认）：
# 授权靠"账号/团队开通了哪些工位"（订阅 + 付费），数据隔离靠团队。
# 与 Worker（单租户部署，硬编码 DEFAULT_TENANT）保持同一口径。
DEFAULT_TENANT = "default"
from app.core.auth import (
    hash_password,
    verify_password,
    create_access_token,
    get_auth_context,
    AuthContext,
)
from app.api.teams import (
    accept_invite,
    assert_team_name_available,
    resolve_invite_token,
    rule_error_422,
)
from app.config.settings import settings
from kaas_common.workstation.subscriptions import (
    all_workstations,
    normalize_codes,
)
from kaas_common.workstation.teams import TeamRuleError, validate_team_name

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


def _constant_time_compare(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


async def _find_user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


async def _grant_signup_workstations(db: AsyncSession, team_id: int, codes) -> None:
    """注册建团队时写 `team_subscriptions`（`source='signup'`）。

    `codes is None` = 调用方没传 `workstations` → **开通全部**。当前阶段所有工位免费，
    所以默认给全量而不是"什么都不给"：新团队一建好就能用，不会出现
    "注册完发现所有工位都是闭的、还要找管理员开通"的空壳体验。

    写的是**具体工位 key**（而不是 `full_chain`）：将来某个工位开始收费时，
    逐条 key 才能分辨"这条是当初免费送的、那条是买的"。
    """
    target = frozenset(all_workstations()) if codes is None else frozenset(codes)
    if not target:
        return
    for code in sorted(target):
        db.add(TeamSubscription(
            team_id=team_id, code=code, active=True, source="signup"))
    await db.flush()


def _validate_workstations(raw) -> Optional[frozenset]:
    """校验注册时可选的 `workstations` 开通清单。

    - **不传**（None）→ 返回 None，语义是"开通全部工位"（当前阶段全部免费，
      由调用方翻译成 `full_chain`）；
    - 传了就逐个用共享内核的工位清单核对，未知工位 → 422 `UNKNOWN_WORKSTATION`。

    判定一律走 `kaas_common/workstation/subscriptions.py`，这里不另写一份清单。
    """
    if raw is None:
        return None
    if isinstance(raw, str) or not isinstance(raw, (list, tuple, set)):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_WORKSTATION",
            "detail": "workstations 需为工位 key 数组，如 [\"customers\", \"quotes\"]"})
    codes = normalize_codes(raw)
    known = set(all_workstations())
    unknown = sorted(c for c in codes if c not in known)
    if unknown:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_WORKSTATION",
            "detail": f"未知工位：{', '.join(unknown)}；可选：{', '.join(sorted(known))}"})
    return frozenset(codes)


async def _team_name_of(db: AsyncSession, team_id: Optional[int]) -> Optional[str]:
    """团队名（未入队 / 团队已被删 → None，前端据此显示"建团队/加入"引导）。"""
    if team_id is None:
        return None
    return (await db.execute(select(Team.name).where(Team.id == team_id))).scalar_one_or_none()


async def _auth_response(db: AsyncSession, user: User, token: Optional[str] = None) -> dict:
    """注册/登录/me 共用的账号响应体（**前端契约**，字段名必须逐字一致）。

    `customer_*` 已移除：账号与"业务客户"不再有归属关系（见模块 docstring）。
    `access_token` 只在注册/登录时给（`/me` 传 None）。
    """
    out = {
        "user_id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "account_type": user.account_type,
        "role": user.role,
        "plan": user.plan,
        "team_id": user.team_id,
        "team_name": await _team_name_of(db, user.team_id),
        "console_access": bool(user.console_access),
    }
    if token is not None:
        out["access_token"] = token
        out["token_type"] = "bearer"
    return out


@router.post("/register")
async def register(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """注册新用户（仅限 customer 账号）。

    安全规则（反伪造）:
    - 忽略 body 中的 account_type / role / plan
    - 强制: account_type='customer', role='owner'（凭邀请码入队的成员为 'user'）, plan='free'

    团队（三层组织，规则真源 `kaas_common/workstation/teams.py`，可选二选一）:
    - `invite_token`：注册成功后凭码入队（码无效/过期/已用 → 整个注册不落库）
    - `team_name`：注册成功后新建团队，注册者即**团队管理员**（`teams.created_by`）
    - 两个都给 → 422 TEAM_ACTION_CONFLICT；都不给 → 独立账号（无团队），账号照常可用

    **不再创建 `customers` 行**（2026-10-11 拆分模型）：公司身份由 `teams` 承载，
    `customers` 只放客户工位录入的**业务客户**。`company_name` / `product_category`
    仍然接收（前端注册页仍在传），但它们只是注册信息，不再落成一条客户行。

    可选 `workstations`：新建团队时要在 `team_subscriptions` 里开通哪些工位
    （`source='signup'`）；**不传 = 开通全部**（当前阶段全部免费）。未知工位 → 422。
    """
    body = await request.json()

    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()
    company_name = (body.get("company_name") or "").strip()
    product_category = (body.get("product_category") or "").strip().lower()
    contact = (body.get("contact") or "").strip() or None
    # 团队动作（可选）：凭邀请码加入现有团队 / 新建团队并成为其管理员
    invite_token_raw = (body.get("invite_token") or "").strip()
    team_name_raw = (body.get("team_name") or "").strip()
    # 工位开通（可选）：不传 = 全部（当前阶段免费）
    workstations = _validate_workstations(body.get("workstations"))

    # ── 校验 ──
    if not email or not password or not display_name:
        raise HTTPException(status_code=422, detail="validation_error: email, password, display_name are required")

    if not company_name:
        raise HTTPException(status_code=422, detail="validation_error: company_name is required")

    if not product_category or product_category not in _CATEGORIES:
        raise HTTPException(status_code=422, detail="validation_error: product_category is required and must be one of: " + ", ".join(sorted(_CATEGORIES)))

    if len(password) < 8:
        raise HTTPException(status_code=422, detail="validation_error: Password must be at least 8 characters")

    if "@" not in email or "." not in email.split("@")[-1]:
        raise HTTPException(status_code=422, detail="validation_error: Invalid email format")

    # ── 团队动作：加入现有团队 与 新建团队 只能二选一 ──
    # 两个都给说明调用方状态错乱，直接拒绝：猜错会给用户建一个他并不想要的团队。
    if invite_token_raw and team_name_raw:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "TEAM_ACTION_CONFLICT",
            "detail": "只能二选一：凭邀请码加入现有团队，或新建一个团队",
        })

    # ── 团队动作预校验（**放在建账号之前**）──
    # 码无效/过期/已用、团队名不合法，都必须让"整个注册不落库"。先校验再写库，
    # 比"先写了再 rollback"少一条中间状态；判定全部来自共享内核，这里不另写规则。
    invite = None
    if invite_token_raw:
        invite = await resolve_invite_token(db, invite_token_raw)

    new_team_name = None
    if team_name_raw:
        try:
            new_team_name = validate_team_name(team_name_raw)
        except TeamRuleError as exc:
            raise rule_error_422(exc)

    # ── 检查邮箱唯一 ──
    existing = await _find_user_by_email(db, email)
    if existing is not None:
        raise HTTPException(status_code=409, detail="conflict: Email already registered")

    # ── 创建 User（强制 customer + free） ──
    # 角色：建团队 / 不带团队动作 → owner（团队管理员身份由 teams.created_by 判定）；
    # 凭码加入的是普通成员 → user，否则每个新成员一进来就是"负责人"（与 Worker 同口径）。
    role = "user" if invite is not None else "owner"
    user = User(
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
        account_type="customer",
        role=role,
        plan="free",
        status="active",
    )
    db.add(user)
    await db.flush()

    # 注册者不新建租户（2026-10-11 业务确认）：业务逻辑不以租户做鉴权边界 ——
    # 授权靠"账号/团队开通了哪些工位"（订阅 + 付费），数据隔离靠团队。
    # 这里固定用平台默认租户，与 Worker（单租户部署）口径一致。
    tenant_id = DEFAULT_TENANT

    # ── 团队动作执行 ──
    # 与建账号同属一个事务：`get_db_session` 只在请求整体成功时提交一次，中途抛异常
    # 即整体回滚，因此不会留下"账号建了但没进团队"的半截状态。
    if invite is not None:
        await accept_invite(db, invite, user)      # 改 users.team_id + 标记邀请已用
    elif new_team_name is not None:
        await assert_team_name_available(db, tenant_id, new_team_name)
        team = Team(tenant_id=tenant_id, name=new_team_name, created_by=user.id)
        db.add(team)
        await db.flush()
        user.team_id = team.id
        await _grant_signup_workstations(db, team.id, workstations)

    token = create_access_token(user.id, "customer")

    logger.info("user_registered", user_id=user.id, email=email, tenant_id=tenant_id,
                team_id=user.team_id, company_name=company_name)

    return await _auth_response(db, user, token)


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
        raise HTTPException(status_code=422, detail="validation_error: email and password are required")

    user = await _find_user_by_email(db, email)

    if user is None or not verify_password(password, user.password_hash):
        raise HTTPException(status_code=401, detail="unauthorized: Invalid email or password")

    if user.status != "active":
        raise HTTPException(status_code=403, detail="forbidden: Account is disabled")

    token = create_access_token(user.id, user.account_type)

    logger.info("user_login", user_id=user.id, account_type=user.account_type)

    return await _auth_response(db, user, token)


@router.post("/logout")
async def logout(request: Request):
    """登出（stateless JWT — 客户端丢弃 token 即可）。"""
    return {"message": "Logged out (client should discard token)"}


@router.get("/me")
async def me(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """获取当前用户信息（**前端契约**：team_* / console_access，无 customer_*）。

    `effective_role` 与 `tenant_id` 是既有字段，保留不删：前者前端用于角色展示，
    后者固定 `"default"`（业务不以租户鉴权）。移除的是 `customer_id/customer_code/
    customer_name` —— 账号与业务客户不再有归属关系。
    """
    user_result = await db.execute(select(User).where(User.id == auth.user_id))
    user = user_result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=401, detail="unauthorized: User not found")

    return {
        **await _auth_response(db, user),
        "effective_role": user.effective_role,
        "tenant_id": DEFAULT_TENANT,
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
        raise HTTPException(status_code=503, detail="not_configured: ADMIN_SETUP_TOKEN not configured")

    # ── 检查是否已初始化 ──
    existing_admin = await db.execute(
        select(User).where(
            User.account_type == "internal",
            User.role == "system_admin",
        )
    )
    if existing_admin.scalar_one_or_none() is not None:
        raise HTTPException(status_code=403, detail="forbidden: System already initialized. A system_admin exists.")

    # ── 提取 token ──
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="unauthorized: Authorization: Bearer <token> required")
    provided_token = auth_header[7:]

    # ── 常数时间比对 ──
    if not _constant_time_compare(provided_token, settings.admin_setup_token):
        raise HTTPException(status_code=403, detail="forbidden: Invalid setup token")

    # ── 读取请求体 ──
    body = await request.json()
    email = (body.get("email") or "").strip().lower()
    password = body.get("password") or ""
    display_name = (body.get("display_name") or "").strip()

    if not email or not password or not display_name:
        raise HTTPException(status_code=422, detail="validation_error: email, password, display_name are required")

    if len(password) < 8:
        raise HTTPException(status_code=422, detail="validation_error: Password must be at least 8 characters")

    # ── 检查邮箱唯一 ──
    existing = await _find_user_by_email(db, email)
    if existing is not None:
        raise HTTPException(status_code=409, detail="conflict: Email already registered")

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

    return await _auth_response(db, user, token)
