"""团队（三层组织）管理 API —— orchestrator 端适配层。

职责
----
`/api/v1/teams*` 这一组端点的 HTTP 适配：把共享内核
`kaas_common/workstation/teams.py` 的判定接到 orchestrator 的 SQLAlchemy 会话上。
本文件**不包含任何团队规则**（名称校验、邀请码生成/规范化、邀请状态、团队管理员判定
全部 import 内核），规则改一次两端同时生效。

业务规则来源（2026-10-11 业务确认）
-----------------------------------
- 规则真源：`kaas_common/workstation/teams.py`（名称/邀请码/管理员判定）与
  `kaas_common/workstation/scope.py`（数据可见性）。
- 团队由**第一个成员创建**，创建者即**团队管理员**（`teams.created_by`）。
- 一个用户同一时刻只属于一个团队（`users.team_id`）；**建团队 / 加入团队二选一**。
- **加入现有团队必须凭邀请码**：邮箱点名（对方已注册 → 直接入队；未注册 → 发码）
  或通用邀请码（不指定邮箱，谁拿到谁用）。

与生产 Worker 镜像的关系
------------------------
生产端 `backend/worker/src/ws_teams.py` 是同一契约的另一个适配层（Worker 就是生产）。
两侧的**路径、状态码、错误码、字段名必须逐字一致**，所以本文件刻意与它同构：
同一个错误码配同一个 HTTP 状态码，同一个 helper 只写一份判定。
差异只应出现在"怎么读写数据库"（ORM vs asyncpg），不应出现在业务语义上。

事务边界
--------
所有写操作都在**同一事务**里完成，失败即 `rollback`：
- `POST /teams`：建团队 + 把自己 `users.team_id` 指过去（否则会出现"建了团队但看不到
  自己数据"的悬空状态）；
- `POST /teams/join`：改 `users.team_id` + 把邀请码标记为已用（否则一个码能被反复用）；
- 其余单表单行写同样显式 commit/rollback，保持"要么全成、要么全不成"。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from kaas_common.workstation.subscriptions import (
    all_workstations,
    normalize_codes,
)
from kaas_common.workstation.teams import (
    INVITE_TTL_DAYS,
    TeamRuleError,
    generate_invite_token,
    invite_state,
    is_team_admin,
    normalize_invite_token,
    validate_team_name,
)

from app.api.ws_common import tenant_id_of
from app.core.auth import AuthContext, get_auth_context
from app.db.models import Team, TeamInvite, TeamSubscription, User
from app.db.session import get_db_session

router = APIRouter(prefix="/api/v1", tags=["teams"])

# 邀请码撞唯一约束时的重试次数。24 位 / 55 字符表（≈140 bit）实际上不可能撞，
# 这里只是兜底：不重试的话一次巧合就会让管理员看到"生成失败"。
_TOKEN_RETRY = 5


# ── Schemas ──────────────────────────────────────────────────────────────────

class TeamCreateIn(BaseModel):
    """建团队。name 留成 Optional，是为了让**空/超长/纯空白**全部走内核判定，
    统一返回 {"error":"validation","code":"INVALID_TEAM_NAME"}，
    而不是 FastAPI 自己那套"字段缺失"的 422 体。

    `workstations`：建团队时开通的工位清单；**不传 = 开通全部**（当前阶段全部免费），
    传了则逐个按共享内核的工位清单核对，未知工位 → 422 `UNKNOWN_WORKSTATION`。
    """
    name: Optional[str] = None
    workstations: Optional[list[str]] = None


class ConsoleAccessIn(BaseModel):
    """官网数据后台授权开关。字段名逐字为 `allowed`（前端契约）。"""
    allowed: bool


class TeamPatchIn(BaseModel):
    name: Optional[str] = None


class InviteCreateIn(BaseModel):
    """email 为空 = 通用邀请码（谁拿到谁用）。"""
    email: Optional[str] = None


class JoinIn(BaseModel):
    token: Optional[str] = None


# ── 错误体（与 Worker 同一套 code/状态码）────────────────────────────────────

def conflict_error(code: str, message: str) -> HTTPException:
    """409 冲突：带人类可读 message，前端可直接提示。"""
    return HTTPException(status_code=409, detail={
        "error": "conflict", "code": code, "message": message})


def rule_error_422(exc: TeamRuleError) -> HTTPException:
    """内核规则违例 → 422：code 直接用内核给的，前端据此做字段级提示。"""
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


# ── Helpers ──────────────────────────────────────────────────────────────────

def _team_out(team: Team, *, user_id, role: Optional[str], member_count: int) -> dict:
    """团队对象（唯一的团队序列化形态，4 个端点共用）。

    `is_admin` 是**"对这个团队而言"**的管理权（团队管理员或平台管理员），
    不是全局角色 —— 同一份判定走内核 `is_team_admin`，避免这里再写一遍。
    """
    return {
        "id": team.id,
        "name": team.name,
        "created_by": team.created_by,
        "is_admin": is_team_admin(team.created_by, user_id, role),
        "member_count": member_count,
    }


def _invite_out(invite: TeamInvite) -> dict:
    return {
        "id": invite.id,
        "email": invite.email,
        "token": invite.token,
        "status": invite.status,
        "created_at": invite.created_at.isoformat() if invite.created_at else None,
        "expires_at": invite.expires_at.isoformat() if invite.expires_at else None,
        "accepted_at": invite.accepted_at.isoformat() if invite.accepted_at else None,
        "accepted_by": invite.accepted_by,
    }


async def _load_user_or_401(db: AsyncSession, user_id) -> User:
    """取当前登录用户的**库内行**。

    为什么不用 `auth.team_id` 直接判定：auth 是请求进入时的快照，而写入
    `users.team_id` 需要行对象本身；两处读同一行才能保证"判定"和"落库"不会各看各的。
    """
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail={
            "error": "unauthorized", "code": "USER_NOT_FOUND"})
    return user


async def _team_or_404(db: AsyncSession, tenant_id: str, team_id: int) -> Team:
    """按租户取团队：跨租户的 team_id 一律当作不存在（不泄露别家团队是否存在）。"""
    team = (await db.execute(
        select(Team).where(Team.tenant_id == tenant_id, Team.id == team_id)
    )).scalar_one_or_none()
    if team is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEAM_NOT_FOUND"})
    return team


def _require_team_admin(team: Team, auth: AuthContext) -> None:
    """管理权：团队管理员（团队创建者）或平台管理员 —— 判定走共享内核。"""
    if not is_team_admin(team.created_by, auth.user_id, auth.role):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理该团队"})


def _signup_workstation_codes(raw: Optional[list[str]]) -> frozenset[str]:
    """建团队时要开通的工位编码。

    - `None`（**不传**）→ 全部工位：当前阶段所有工位免费，新团队一建好就能用，
      否则会留下"注册完发现所有工位都是闭的"的空壳团队；
    - 传了就按共享内核的工位清单核对，未知工位 → 422 `UNKNOWN_WORKSTATION`
      （清单与判定都来自 `kaas_common/workstation/subscriptions.py`，这里不另写一份）。
    """
    if raw is None:
        return frozenset(all_workstations())
    codes = normalize_codes(raw)
    known = set(all_workstations())
    unknown = sorted(c for c in codes if c not in known)
    if unknown:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_WORKSTATION",
            "detail": f"未知工位：{', '.join(unknown)}；可选：{', '.join(sorted(known))}"})
    return codes


async def _grant_team_workstations(db: AsyncSession, team_id: int, codes) -> None:
    """把工位订阅写进 `team_subscriptions`（`source='signup'`，幂等）。

    `ON CONFLICT DO NOTHING` 而不是 upsert：既有行可能来自 `system_migration`（存量团队的
    full_chain）或人工开通（manual）—— 建团队**不应该**覆盖"谁在什么时候开的"这个事实，
    只补上"还没有的"。
    """
    if not codes:
        return
    await db.execute(
        pg_insert(TeamSubscription)
        .values([{"team_id": team_id, "code": code, "active": True, "source": "signup"}
                 for code in sorted(codes)])
        .on_conflict_do_nothing(index_elements=["team_id", "code"])
    )


async def _member_count(db: AsyncSession, team_id: int) -> int:
    count = (await db.execute(
        select(func.count()).select_from(User).where(User.team_id == team_id)
    )).scalar_one()
    return int(count or 0)


async def assert_team_name_available(db: AsyncSession, tenant_id: str, name: str,
                                     *, exclude_team_id: Optional[int] = None) -> None:
    """租户内团队重名检查（建团队 / 改名 / 注册建团队三处共用同一口径）。

    表上还有 `uq_teams_tenant_name` 兜底：这里的 SELECT 只是把并发写撞库
    变成可读的 409，而不是让用户看到 IntegrityError。
    """
    stmt = select(Team.id).where(Team.tenant_id == tenant_id, Team.name == name)
    if exclude_team_id is not None:
        stmt = stmt.where(Team.id != exclude_team_id)
    if (await db.execute(stmt)).first() is not None:
        raise conflict_error("TEAM_NAME_TAKEN", f"已存在同名团队「{name}」")


def _invite_state_of(invite: Optional[TeamInvite]) -> str:
    """内核 `invite_state` 只认 Mapping（两端共用），这里把 ORM 行翻成它要的形状。"""
    if invite is None:
        return invite_state(None)
    return invite_state({"status": invite.status, "expires_at": invite.expires_at})


async def resolve_invite_token(db: AsyncSession, raw_token: str) -> TeamInvite:
    """邀请码 → 邀请行；不可用状态直接映射成 HTTP。

    状态 → HTTP 的映射只写这一份：`/teams/join` 与 `POST /auth/register`
    的 invite_token 必须给出同样的 404/409/410，否则用户"注册时不行、登录后行"
    这种自相矛盾的行为就会冒出来。
    """
    token = normalize_invite_token(raw_token)
    invite = (await db.execute(
        select(TeamInvite).where(TeamInvite.token == token)
    )).scalar_one_or_none()

    state = _invite_state_of(invite)
    if state == "not_found":
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "INVITE_NOT_FOUND"})
    if state == "revoked":
        raise HTTPException(status_code=410, detail={
            "error": "gone", "code": "INVITE_REVOKED"})
    if state == "used":
        raise conflict_error("INVITE_ALREADY_USED", "该邀请码已被使用")
    if state == "expired":
        raise HTTPException(status_code=410, detail={
            "error": "gone", "code": "INVITE_EXPIRED"})
    return invite


async def accept_invite(db: AsyncSession, invite: TeamInvite, user: User) -> Team:
    """凭邀请码入队：改 `users.team_id` + 标记邀请已用（同一事务，调用方负责 commit）。

    这两步必须一起成功：只改 team_id 会让一个码被反复使用（谁都能进），
    只标记已用又会让用户拿不到团队。
    """
    # 按**邀请行自己的租户**取团队（该行的 team_id 就属于这个租户）：邀请码本身即凭证，
    # 用调用者的租户来过滤会让"别家租户的团队"直接 404，而 Worker 是单租户、无此差别。
    team = await _team_or_404(db, invite.tenant_id, invite.team_id)
    user.team_id = team.id
    invite.status = "accepted"
    invite.accepted_at = datetime.now(timezone.utc)
    invite.accepted_by = user.id
    return team


# ── 团队 ────────────────────────────────────────────────────────────────────

@router.post("/teams", status_code=201)
async def create_team(
    body: TeamCreateIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """建团队：创建者即团队管理员，并自动入队（一人一团队）。

    可选 `workstations` 在同一事务里开通（不传 = 全部，见 `_signup_workstation_codes`）：
    团队与它的工位订阅必须一起成功 —— 只建团队不开通会得到一个"进得去但什么都用不了"
    的空团队，而这是用户自己修不好的状态（要再找管理员开通）。
    """
    tenant_id = tenant_id_of(auth)
    user = await _load_user_or_401(db, auth.user_id)
    if user.team_id is not None:
        raise conflict_error("ALREADY_IN_TEAM", "你已属于一个团队，不能再创建团队")

    try:
        name = validate_team_name(body.name)
    except TeamRuleError as exc:
        raise rule_error_422(exc)

    # 工位编码是纯函数判定，同样放在写库之前：坏编码不该先落一个团队再报错
    codes = _signup_workstation_codes(body.workstations)

    try:
        await assert_team_name_available(db, tenant_id, name)
        team = Team(tenant_id=tenant_id, name=name, created_by=user.id)
        db.add(team)
        await db.flush()            # 先拿到 team.id，才能把 users.team_id 指过去
        user.team_id = team.id
        await _grant_team_workstations(db, team.id, codes)
        await db.commit()
    except HTTPException:
        await db.rollback()
        raise
    except IntegrityError:
        # 并发下另一个请求刚建了同名团队：唯一索引兜底，仍按"重名"回给用户
        await db.rollback()
        raise conflict_error("TEAM_NAME_TAKEN", f"已存在同名团队「{name}」")

    # member_count 恒为 1：团队刚建，队员只有创建者自己
    return _team_out(team, user_id=user.id, role=auth.role, member_count=1)


@router.get("/teams/me")
async def my_team(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """我的团队（未加入任何团队时 team=null）——前端据此决定显示"建团队/加入"引导。

    这里**不额外按租户过滤**（Worker 是单租户，那个条件恒真、看不出差别）：
    用户的租户来自其 customer 绑定，而团队租户来自 `teams.tenant_id`，两者在
    "邮箱点名直入"这类路径上可以不同。若此处按租户过滤，用户会看到 team=null，
    再去建团队又因 `users.team_id` 已占用而 409 —— 前后端都无法自愈的死局。
    团队归属以 `users.team_id` 为准（唯一真源），数据可见性仍由租户 + 团队两层把关。
    """
    user = await _load_user_or_401(db, auth.user_id)
    if user.team_id is None:
        return {"team": None, "is_admin": False, "member_count": 0}

    team = (await db.execute(
        select(Team).where(Team.id == user.team_id)
    )).scalar_one_or_none()
    if team is None:
        # 团队被删：对外表现与"没有团队"一致
        return {"team": None, "is_admin": False, "member_count": 0}

    count = await _member_count(db, team.id)
    return {
        "team": _team_out(team, user_id=user.id, role=auth.role, member_count=count),
        "is_admin": is_team_admin(team.created_by, user.id, auth.role),
        "member_count": count,
    }


@router.patch("/teams/{team_id}")
async def update_team(
    team_id: int,
    body: TeamPatchIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """改团队名。仅团队管理员 / 平台管理员。"""
    # 名称是纯函数判定，放在取团队之前：坏名字不必先查库（与 Worker 同序）
    try:
        name = validate_team_name(body.name)
    except TeamRuleError as exc:
        raise rule_error_422(exc)

    tenant_id = tenant_id_of(auth)
    team = await _team_or_404(db, tenant_id, team_id)
    _require_team_admin(team, auth)
    await assert_team_name_available(db, tenant_id, name, exclude_team_id=team_id)

    team.name = name
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise conflict_error("TEAM_NAME_TAKEN", f"已存在同名团队「{name}」")

    count = await _member_count(db, team_id)
    return _team_out(team, user_id=auth.user_id, role=auth.role, member_count=count)


@router.get("/teams/{team_id}/members")
async def list_members(
    team_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """团队成员列表。`is_admin` 指"是不是这个团队的管理员"，不是全局角色。

    `console_access` = 官网数据后台权限（团队管理员可授予/收回，见下面的 PUT 端点）。
    """
    team = await _team_or_404(db, tenant_id_of(auth), team_id)
    _require_team_admin(team, auth)

    rows = (await db.execute(
        select(User).where(User.team_id == team_id).order_by(User.id)
    )).scalars().all()
    items = [{
        "user_id": u.id,
        "email": u.email,
        "display_name": u.display_name,
        "role": u.role,
        "is_admin": is_team_admin(team.created_by, u.id, u.role),
        "console_access": bool(u.console_access),
    } for u in rows]
    return {"items": items, "total": len(items)}


@router.put("/teams/{team_id}/members/{user_id}/console-access")
async def set_member_console_access(
    team_id: int,
    user_id: int,
    body: ConsoleAccessIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """授予/收回某成员的**官网数据后台**权限（仅团队管理员或平台管理员）。

    顺序刻意是"先 404 后 403"（与 `_require_team_admin` 同一约定）：
    调用者不属/不存在的团队一律 404 `TEAM_NOT_FOUND`（不泄露别家团队是否存在）；
    团队存在但不是管理员 → 403 `NOT_TEAM_ADMIN`；目标成员不属本团队 → 404 `MEMBER_NOT_FOUND`
    （跨团队授权等于越权，装作这个成员不存在最稳妥）。
    """
    team = await _team_or_404(db, tenant_id_of(auth), team_id)
    _require_team_admin(team, auth)

    target = (await db.execute(
        select(User).where(User.id == user_id, User.team_id == team_id)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "MEMBER_NOT_FOUND"})

    target.console_access = bool(body.allowed)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    return {"user_id": target.id, "console_access": bool(target.console_access)}


@router.delete("/teams/{team_id}/members/{user_id}")
async def remove_member(
    team_id: int,
    user_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """移除成员（清空其 `users.team_id`）。

    不允许移除团队管理员本人 —— 否则会出现"团队没人能管理"的死局
    （要改管理权请先由平台管理员处理）。
    """
    team = await _team_or_404(db, tenant_id_of(auth), team_id)
    _require_team_admin(team, auth)

    if str(team.created_by) == str(user_id):
        raise conflict_error("CANNOT_REMOVE_SELF", "不能移除团队管理员本人")

    target = (await db.execute(
        select(User).where(User.id == user_id, User.team_id == team_id)
    )).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "MEMBER_NOT_FOUND"})

    target.team_id = None
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"removed": True, "user_id": user_id}


# ── 邀请 ────────────────────────────────────────────────────────────────────

@router.post("/teams/{team_id}/invites", status_code=201)
async def create_invite(
    team_id: int,
    body: InviteCreateIn,
    response: Response,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """邀请成员：邮箱点名（已注册直接入队 / 未注册发码）或通用邀请码（email 留空）。

    两种结果的状态码不同：**直入成功 200**（没有任何邀请行产生），
    **发码 201**（创建了邀请资源）；默认 201 在直入分支里被改写。
    """
    email = (body.email or "").strip().lower() or None
    tenant_id = tenant_id_of(auth)
    # 先确认调用者确实存在：`team_invites.invited_by` 有外键，账号被删后光有 token
    # 会撞 FK 违例（表现为"生成邀请码失败"，完全看不出真实原因）
    user = await _load_user_or_401(db, auth.user_id)
    team = await _team_or_404(db, tenant_id, team_id)
    _require_team_admin(team, auth)

    if email is not None:
        # lower(email)：注册时已统一小写，这里再兜一层，避免大小写不同被当成新邮箱
        target = (await db.execute(
            select(User).where(func.lower(User.email) == email)
        )).scalar_one_or_none()
        if target is not None:
            if target.team_id is not None:
                raise conflict_error("ALREADY_IN_TEAM", f"{email} 已属于一个团队")
            target.team_id = team.id
            try:
                await db.commit()
            except Exception:
                await db.rollback()
                raise
            response.status_code = 200
            return {"joined": True, "user_id": target.id, "email": email}

    expires_at = datetime.now(timezone.utc) + timedelta(days=INVITE_TTL_DAYS)
    invite = None
    for _ in range(_TOKEN_RETRY):
        invite = TeamInvite(
            tenant_id=tenant_id, team_id=team.id, email=email,
            token=generate_invite_token(), invited_by=user.id,
            status="pending", expires_at=expires_at,
        )
        db.add(invite)
        try:
            await db.commit()
            break
        except IntegrityError:
            # token 撞唯一约束（理论不可能）→ 换一个码再来
            await db.rollback()
            invite = None
    if invite is None:
        raise HTTPException(status_code=500, detail={
            "error": "internal_error", "code": "INVITE_TOKEN_GENERATION_FAILED"})

    return {"joined": False, "invite_id": invite.id, "token": invite.token, "email": email}


@router.get("/teams/{team_id}/invites")
async def list_invites(
    team_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """邀请列表（含 token，方便管理员再复制一次链接）。仅团队管理员可见。"""
    team = await _team_or_404(db, tenant_id_of(auth), team_id)
    _require_team_admin(team, auth)

    rows = (await db.execute(
        select(TeamInvite).where(TeamInvite.team_id == team_id)
        .order_by(TeamInvite.id.desc())
    )).scalars().all()
    items = [_invite_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.delete("/teams/{team_id}/invites/{invite_id}")
async def revoke_invite(
    team_id: int,
    invite_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """撤销邀请码：置 `status='revoked'`（保留行，便于审计"谁撤销的"）。"""
    team = await _team_or_404(db, tenant_id_of(auth), team_id)
    _require_team_admin(team, auth)

    invite = (await db.execute(
        select(TeamInvite).where(TeamInvite.id == invite_id, TeamInvite.team_id == team_id)
    )).scalar_one_or_none()
    if invite is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "INVITE_NOT_FOUND"})

    invite.status = "revoked"
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise
    return {"revoked": True, "id": invite_id}


@router.post("/teams/join")
async def join_team(
    body: JoinIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """凭邀请码加入团队。码无效/被撤销/已用/过期分别给 404/410/409/410。

    邀请码是**登录后**才用得上的凭证：用户名下已有团队就不给再进第二个。
    """
    user = await _load_user_or_401(db, auth.user_id)
    if user.team_id is not None:
        raise conflict_error("ALREADY_IN_TEAM", "你已属于一个团队")

    token = normalize_invite_token(body.token)
    if not token:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_INVITE_TOKEN",
            "detail": "邀请码不能为空"})

    invite = await resolve_invite_token(db, token)
    try:
        team = await accept_invite(db, invite, user)
        await db.commit()
    except Exception:
        # 整体回滚：不能出现"人进了团队但码还是 pending"（同一个码会被再用一次）
        await db.rollback()
        raise

    count = await _member_count(db, team.id)
    return {"joined": True,
            "team": _team_out(team, user_id=user.id, role=auth.role, member_count=count)}
