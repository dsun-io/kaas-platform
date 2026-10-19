"""团队（三层组织）管理 API（Worker 镜像 · 生产）。

规则真源 = 共享内核 `kaas_common/workstation/teams.py`（名称校验、邀请码生成/规范化、
邀请状态、团队管理员判定）—— 本文件只负责把它接到 asyncpg 上，**不另写一份判定**。

业务规则（2026-10-11 确认）
--------------------------
- 团队由**第一个成员创建**，创建者即**团队管理员**（`teams.created_by`），可管理本团队。
- 一个用户同一时刻只属于一个团队（`users.team_id`）；已有团队就不能再建或再加。
- **加入现有团队必须凭邀请码**（否则 A 公司的人可以自由进入 B 公司团队）。
- 邀请两条路：**邮箱点名**（对方已注册 → 直接入队；未注册 → 生成邀请码）
  + **通用邀请码**（不指定邮箱，谁拿到谁用）。

为什么生产端尤其需要它
----------------------
生产 Worker 是**单租户**部署（所有数据 `tenant_id='default'`），账号之间没有
`tenant_id` 隔离；团队就是提供"公司级隔离"的那一层 —— 成员创建的记录带
`team_id`，可见性由 `kaas_common/workstation/scope.py` 判定：本团队可见、
其他团队不可见，管理员全可见。
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import Depends, HTTPException, Request, Response
from pydantic import BaseModel

from kaas_common.workstation.subscriptions import all_workstations
from kaas_common.workstation.teams import (
    INVITE_TTL_DAYS,
    TeamRuleError,
    generate_invite_token,
    invite_state,
    is_team_admin,
    validate_transfer_target,
    normalize_invite_token,
    validate_team_name,
)

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db
_acquire = _main._acquire

# 邀请码唯一约束冲突时的重试次数（24 位字母表，撞码概率可忽略，这里只兜底）
_TOKEN_RETRY = 5


# ── Schemas ─────────────────────────────────────────────────────────────────

class TeamCreateIn(BaseModel):
    name: str
    # 建团队时勾选要开通的工位（当前阶段全部免费）。不传 = 默认开通全部工位，
    # 免得新团队建完"什么都用不了"。
    workstations: Optional[List[str]] = None


class TeamPatchIn(BaseModel):
    name: str


class InviteCreateIn(BaseModel):
    email: Optional[str] = None


class JoinIn(BaseModel):
    token: str


class TeamTransferIn(BaseModel):
    """转让团队管理权：把团队交给另一个成员。"""

    user_id: int


# ── Helpers ─────────────────────────────────────────────────────────────────

def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=409, detail={"error": "conflict", "code": code,
                                                 "message": message})


def _rule_422(exc: TeamRuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


def _team_out(team, *, user: dict, member_count: int) -> dict:
    return {
        "id": team["id"],
        "name": team["name"],
        "created_by": team["created_by"],
        "is_admin": is_team_admin(team["created_by"], user["id"], user.get("role")),
        "member_count": member_count,
    }


def _require_team_admin(team, user: dict) -> None:
    """团队管理员（团队创建者）或平台管理员才可管理该团队。"""
    if not is_team_admin(team["created_by"], user["id"], user.get("role")):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理该团队"})


async def _team_or_404(conn, team_id: int) -> dict:
    row = await conn.fetchrow(
        "SELECT * FROM teams WHERE tenant_id=$1 AND id=$2", DEFAULT_TENANT, team_id)
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEAM_NOT_FOUND"})
    return dict(row)


async def _member_count(conn, team_id: int) -> int:
    return await conn.fetchval(
        "SELECT count(*) FROM users WHERE team_id=$1", team_id) or 0


async def _insert_invite(conn, *, team_id: int, email: Optional[str], user: dict) -> dict:
    """生成邀请码（撞唯一约束就重试）。"""
    expires_at = datetime.now(timezone.utc) + timedelta(days=INVITE_TTL_DAYS)
    for _ in range(_TOKEN_RETRY):
        token = generate_invite_token()
        try:
            row = await conn.fetchrow(
                "INSERT INTO team_invites"
                " (tenant_id, team_id, email, token, invited_by, status, expires_at)"
                " VALUES ($1,$2,$3,$4,$5,'pending',$6)"
                " RETURNING id, token, email, status, created_at, expires_at",
                DEFAULT_TENANT, team_id, email, token, user["id"], expires_at,
            )
            return dict(row)
        except Exception as exc:  # asyncpg.UniqueViolationError（撞码）
            if "uq_team_invites_token" not in str(exc) and "duplicate key" not in str(exc):
                raise
    raise HTTPException(status_code=500, detail={
        "error": "internal_error", "code": "INVITE_TOKEN_GENERATION_FAILED"})


def _invite_out(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"], "email": d["email"], "token": d["token"], "status": d["status"],
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
        "expires_at": d["expires_at"].isoformat() if d.get("expires_at") else None,
        "accepted_at": d["accepted_at"].isoformat() if d.get("accepted_at") else None,
        "accepted_by": d.get("accepted_by"),
    }


# ── 团队 ────────────────────────────────────────────────────────────────────

@app.post("/api/v1/teams", status_code=201)
async def create_team(
    request: Request,
    body: TeamCreateIn,
    user: dict = Depends(_get_current_user),
):
    """建团队：创建者即团队管理员，并自动入队。"""
    if user.get("team_id") is not None:
        raise _conflict("ALREADY_IN_TEAM", "你已属于一个团队，不能再创建团队")
    try:
        name = validate_team_name(body.name)
    except TeamRuleError as exc:
        raise _rule_422(exc)

    async with _acquire(request) as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT 1 FROM teams WHERE tenant_id=$1 AND name=$2", DEFAULT_TENANT, name)
            if exists is not None:
                raise _conflict("TEAM_NAME_TAKEN", f"已存在同名团队「{name}」")
            team = dict(await conn.fetchrow(
                "INSERT INTO teams (tenant_id, name, created_by) VALUES ($1,$2,$3)"
                " RETURNING *",
                DEFAULT_TENANT, name, user["id"],
            ))
            await conn.execute(
                "UPDATE users SET team_id=$2, updated_at=now() WHERE id=$1", user["id"], team["id"])
            # 建团队时勾选的工位一次性开通（当前阶段全部免费，故 source='signup'）
            chosen = _resolve_signup_workstations(body.workstations)
            for ws in chosen:
                await conn.execute(
                    "INSERT INTO team_subscriptions (team_id, code, active, source)"
                    " VALUES ($1,$2,true,'signup')"
                    " ON CONFLICT (team_id, code) DO UPDATE SET"
                    "   active = true, source = 'signup', updated_at = now()",
                    team["id"], ws)
    return {**_team_out(team, user=user, member_count=1), "workstations": chosen}


def _resolve_signup_workstations(chosen: Optional[List[str]]) -> list[str]:
    """建团队/注册时勾选的工位 → 要开通的编码清单。

    不传（None）= 默认**全部工位**（当前阶段全部免费，免得新团队"什么都用不了"）；
    传空数组 = **零开通**（与 orchestrator `_validate_workstations([])` 同口径；
    前端 `lib/auth/types.ts` 也按"不传 ≠ 空数组"写，PARITY-DIFF-11）。
    """
    if chosen is None:
        return list(all_workstations())
    known = set(all_workstations())
    out: list[str] = []
    for raw in chosen:
        code = (raw or "").strip().lower()
        if code not in known:
            raise HTTPException(status_code=422, detail={
                "error": "validation", "code": "UNKNOWN_WORKSTATION",
                "detail": f"未知工位：{raw}；可选：{', '.join(sorted(known))}"})
        if code not in out:
            out.append(code)
    return out


@app.get("/api/v1/teams/me")
async def my_team(request: Request, user: dict = Depends(_get_current_user)):
    """我的团队（未加入任何团队时 team=null）——前端据此决定显示"建团队/加入"引导。

    刻意**不按 tenant_id 过滤**（与 orchestrator 同口径）：团队归属的唯一真源是
    `users.team_id`。若按租户过滤，凭"邮箱点名直入 / 跨租户邀请码"进团队的人会看到
    `team=null`，再建团队又撞 409 `ALREADY_IN_TEAM` —— 前后端都无法自愈的死局。
    数据可见性仍由「租户 + 团队」两层把关，不以这里为准。
    """
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT t.* FROM teams t JOIN users u ON u.team_id = t.id WHERE u.id=$1",
            user["id"],
        )
        if row is None:
            return {"team": None, "is_admin": False, "member_count": 0}
        team = dict(row)
        count = await _member_count(conn, team["id"])
    return {
        "team": _team_out(team, user=user, member_count=count),
        "is_admin": is_team_admin(team["created_by"], user["id"], user.get("role")),
        "member_count": count,
    }


@app.patch("/api/v1/teams/{team_id}")
async def update_team(
    request: Request,
    team_id: int,
    body: TeamPatchIn,
    user: dict = Depends(_get_current_user),
):
    try:
        name = validate_team_name(body.name)
    except TeamRuleError as exc:
        raise _rule_422(exc)
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _team_or_404(conn, team_id)
            _require_team_admin(team, user)
            taken = await conn.fetchval(
                "SELECT 1 FROM teams WHERE tenant_id=$1 AND name=$2 AND id<>$3",
                DEFAULT_TENANT, name, team_id)
            if taken is not None:
                raise _conflict("TEAM_NAME_TAKEN", f"已存在同名团队「{name}」")
            team = dict(await conn.fetchrow(
                "UPDATE teams SET name=$2, updated_at=now() WHERE id=$1 RETURNING *",
                team_id, name))
            count = await _member_count(conn, team_id)
    return _team_out(team, user=user, member_count=count)


@app.get("/api/v1/teams/{team_id}/members")
async def list_members(
    request: Request,
    team_id: int,
    user: dict = Depends(_get_current_user),
):
    async with _acquire(request) as conn:
        team = await _team_or_404(conn, team_id)
        _require_team_admin(team, user)
        rows = await conn.fetch(
            "SELECT id, email, display_name, role FROM users WHERE team_id=$1 ORDER BY id",
            team_id)
    items = [{
        "user_id": r["id"], "email": r["email"], "display_name": r["display_name"],
        "role": r["role"],
        "is_admin": is_team_admin(team["created_by"], r["id"], r["role"]),
    } for r in rows]
    return {"items": items, "total": len(items)}


@app.delete("/api/v1/teams/{team_id}/members/{user_id}")
async def remove_member(
    request: Request,
    team_id: int,
    user_id: int,
    user: dict = Depends(_get_current_user),
):
    """移除成员。

    不允许移除团队管理员自己 —— 否则会出现"团队没人能管理"的死局
    （要改管理权请先把别人设为创建者，或由平台管理员处理）。
    """
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _team_or_404(conn, team_id)
            _require_team_admin(team, user)
            if str(team["created_by"]) == str(user_id):
                raise _conflict("CANNOT_REMOVE_SELF", "不能移除团队管理员本人")
            removed = await conn.fetchval(
                "UPDATE users SET team_id=NULL, updated_at=now()"
                " WHERE id=$1 AND team_id=$2 RETURNING id",
                user_id, team_id)
            if removed is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "MEMBER_NOT_FOUND"})
    return {"removed": True, "user_id": user_id}


# ── 邀请 ────────────────────────────────────────────────────────────────────

@app.post("/api/v1/teams/{team_id}/invites", status_code=201)
async def create_invite(
    request: Request,
    team_id: int,
    body: InviteCreateIn,
    response: Response,
    user: dict = Depends(_get_current_user),
):
    """邀请成员：邮箱点名（已注册直接入队 / 未注册发码）或通用邀请码（email 留空）。

    状态码两端统一：**发码 = 201（新建了邀请资源）**，**邮箱直入 = 200（没有新建资源）**。
    """
    email = (body.email or "").strip().lower() or None
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _team_or_404(conn, team_id)
            _require_team_admin(team, user)

            if email is not None:
                target = await conn.fetchrow(
                    "SELECT id, team_id FROM users WHERE lower(email)=$1", email)
                if target is not None:
                    if target["team_id"] is not None:
                        raise _conflict(
                            "ALREADY_IN_TEAM", f"{email} 已属于一个团队")
                    await conn.execute(
                        "UPDATE users SET team_id=$2, updated_at=now() WHERE id=$1",
                        target["id"], team_id)
                    response.status_code = 200      # 直入：未创建邀请资源
                    return {"joined": True, "user_id": target["id"], "email": email}

            invite = await _insert_invite(conn, team_id=team_id, email=email, user=user)
    payload = {"joined": False, "invite_id": invite["id"], "token": invite["token"],
               "email": email}
    return payload


@app.get("/api/v1/teams/{team_id}/invites")
async def list_invites(
    request: Request,
    team_id: int,
    user: dict = Depends(_get_current_user),
):
    """邀请列表（含 token，方便管理员再复制一次链接）。仅团队管理员可见。"""
    async with _acquire(request) as conn:
        team = await _team_or_404(conn, team_id)
        _require_team_admin(team, user)
        rows = await conn.fetch(
            "SELECT id, email, token, status, created_at, expires_at, accepted_at, accepted_by"
            " FROM team_invites WHERE team_id=$1 ORDER BY id DESC", team_id)
    items = [_invite_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@app.delete("/api/v1/teams/{team_id}/invites/{invite_id}")
async def revoke_invite(
    request: Request,
    team_id: int,
    invite_id: int,
    user: dict = Depends(_get_current_user),
):
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _team_or_404(conn, team_id)
            _require_team_admin(team, user)
            row = await conn.fetchval(
                "UPDATE team_invites SET status='revoked'"
                " WHERE id=$1 AND team_id=$2 RETURNING id",
                invite_id, team_id)
            if row is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "INVITE_NOT_FOUND"})
    return {"revoked": True, "id": invite_id}


@app.post("/api/v1/teams/join")
async def join_team(
    request: Request,
    body: JoinIn,
    user: dict = Depends(_get_current_user),
):
    """凭邀请码加入团队。码无效/被撤销/已用/过期分别给 404/410/409/410。"""
    if user.get("team_id") is not None:
        raise _conflict("ALREADY_IN_TEAM", "你已属于一个团队")
    token = normalize_invite_token(body.token)
    if not token:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_INVITE_TOKEN",
            "detail": "邀请码不能为空"})

    async with _acquire(request) as conn:
        async with conn.transaction():
            invite = await conn.fetchrow(
                "SELECT * FROM team_invites WHERE token=$1", token)
            state = invite_state(dict(invite) if invite is not None else None)
            if state == "not_found":
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "INVITE_NOT_FOUND"})
            if state == "revoked":
                raise HTTPException(status_code=410, detail={
                    "error": "gone", "code": "INVITE_REVOKED"})
            if state == "used":
                raise _conflict("INVITE_ALREADY_USED", "该邀请码已被使用")
            if state == "expired":
                raise HTTPException(status_code=410, detail={
                    "error": "gone", "code": "INVITE_EXPIRED"})

            team = await _team_or_404(conn, invite["team_id"])
            await conn.execute(
                "UPDATE users SET team_id=$2, updated_at=now() WHERE id=$1",
                user["id"], team["id"])
            await conn.execute(
                "UPDATE team_invites SET status='accepted', accepted_at=now(), accepted_by=$2"
                " WHERE id=$1",
                invite["id"], user["id"])
            count = await _member_count(conn, team["id"])
    return {"joined": True, "team": _team_out(team, user=user, member_count=count)}

class ConsoleAccessIn(BaseModel):
    allowed: bool


@app.post("/api/v1/teams/{team_id}/transfer")
async def transfer_team(
    team_id: int,
    request: Request,
    body: TeamTransferIn,
    user: dict = Depends(_get_current_user),
):
    """转让团队管理权：把 `teams.created_by` 改成另一个成员。

    与 orchestrator 的 `POST /teams/{team_id}/transfer` **同语义**。

    授权（用户 2026-10-11 裁决）：**团队管理员（现任）或平台管理员**都能发起
    —— 复用 `_require_team_admin`（→ 共享内核 `is_team_admin`），
    **不新增一套判定**。

    策略无关校验走共享内核 `validate_transfer_target`：目标必须是**本团队成员**、
    不能转给自己。前任留在团队里继续当普通成员（管理权在本项目就等于创建者）。
    """
    async with _acquire(request) as conn:
        team = await _team_or_404(conn, team_id)
        _require_team_admin(team, user)

        rows = await conn.fetch("SELECT id FROM users WHERE team_id=$1", team_id)
        try:
            validate_transfer_target(
                target_user_id=body.user_id,
                current_owner_id=team["created_by"],
                member_user_ids=[r["id"] for r in rows],
            )
        except TeamRuleError as exc:
            raise _rule_422(exc)

        await conn.execute(
            "UPDATE teams SET created_by=$1 WHERE tenant_id=$2 AND id=$3",
            body.user_id, DEFAULT_TENANT, team_id)
        team["created_by"] = body.user_id
        count = await _member_count(conn, team_id)
        return _team_out(team, user=user, member_count=count)


@app.put("/api/v1/teams/{team_id}/members/{user_id}/console-access")
async def set_console_access(
    request: Request,
    team_id: int,
    user_id: int,
    body: ConsoleAccessIn,
    user: dict = Depends(_get_current_user),
):
    """官网数据后台权限：**团队管理员**决定哪个成员能拿到。

    这是成员级权限（不是工位订阅）：团队管理员在成员列表里给某人打开/关闭。
    授权关系本身仍可用 `user_customers` 记录"该成员能代表哪个业务客户"。
    """
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _team_or_404(conn, team_id)
            _require_team_admin(team, user)
            row = await conn.fetchrow(
                "UPDATE users SET console_access=$3, updated_at=now()"
                " WHERE id=$1 AND team_id=$2 RETURNING id, console_access",
                user_id, team_id, body.allowed)
            if row is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "MEMBER_NOT_FOUND"})
    return {"user_id": row["id"], "console_access": bool(row["console_access"])}
