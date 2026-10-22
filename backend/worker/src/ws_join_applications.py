"""团队加入申请 API（Worker · 生产镜像，2026-10-22 新增）。

场景（用户需求）：新用户注册填写企业/团队时，**团队已存在**的情况下，除邀请码外
可**直接发起进入团队申请**；团队管理员在「团队管理 → 加入申请」里审核，
通过才入团、驳回可重新申请、申请人可撤回。

规则真源 = 共享内核 `kaas_common/workstation/teams.py`：
- `validate_application_message` / `validate_reject_reason`（≤200 字，选填）；
- `can_transition_application`（pending → approved/rejected/canceled，终态不可再流转，
  重复审核一律 409 APPLICATION_ALREADY_REVIEWED，不做静默幂等）；
- `is_team_admin` / `_require_team_admin`（团队创建者或平台管理员，复用 ws_teams，
  不另写一套判定）。

与邀请码的分工
--------------
- 邀请码：一次一码（`team_invites`，兑换行锁保证并发单飞），拿到就能进；
- 加入申请：没有码也能请求进入，**团队侧保留把关权**，审核通过才落
  `users.team_id`。工位订阅是团队级（`team_subscriptions`），通过即天然获得
  团队已开通工位，无需逐成员授权。

注册时的申请创建在 `main.py:register` 同一事务里完成（建号 + 待审申请，
任一失败整体回滚）；本文件只负责**登录后的查询与审核**。
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from kaas_common.workstation.teams import (
    JOIN_APPLICATION_STATUS,
    TeamRuleError,
    can_transition_application,
    validate_reject_reason,
)

import main as _main
import ws_teams as _teams

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
_acquire = _main._acquire


# ── Schemas ─────────────────────────────────────────────────────────────────

class ApplicationRejectIn(BaseModel):
    reason: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(status_code=409, detail={"error": "conflict", "code": code,
                                                 "message": message})


def _application_out(row, team_name: Optional[str] = None) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "team_id": d["team_id"],
        "team_name": team_name if team_name is not None else d.get("team_name"),
        "user_id": d["user_id"],
        "email": d["email"],
        "display_name": d["display_name"],
        "message": d.get("message"),
        "status": d["status"],
        "reject_reason": d.get("reject_reason"),
        "reviewed_by": d.get("reviewed_by"),
        "reviewed_at": d["reviewed_at"].isoformat() if d.get("reviewed_at") else None,
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
    }


async def _application_or_404(conn, application_id: int, *, team_id: Optional[int] = None) -> dict:
    """按 id 取申请；传 team_id 时同时校验归属（跨团队访问一律 404，不泄露存在性）。"""
    row = await conn.fetchrow(
        "SELECT * FROM team_join_applications WHERE id=$1", application_id)
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "APPLICATION_NOT_FOUND"})
    if team_id is not None and row["team_id"] != team_id:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "APPLICATION_NOT_FOUND"})
    return dict(row)


# ── 注册辅助：团队名查重（公开只读） ────────────────────────────────────────

@app.get("/api/v1/teams/check-name")
async def check_team_name(request: Request, name: str = ""):
    """团队名是否已存在（**公开**，注册页实时提示用）。

    刻意只返回布尔值：注册时用户需要知道"我填的团队名是不是已经存在"
    （存在 → 可选申请加入或改用邀请码），但**不暴露任何团队列表/详情**。
    命名规范化走共享内核 `validate_team_name`，与建团队时同口径。
    """
    try:
        normalized = _teams.validate_team_name(name)
    except TeamRuleError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail})
    async with _acquire(request) as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM teams WHERE tenant_id=$1 AND name=$2",
            DEFAULT_TENANT, normalized)
    return {"name": normalized, "exists": exists is not None}


# ── 申请人侧：我的申请 ──────────────────────────────────────────────────────

@app.get("/api/v1/me/join-application")
async def my_join_application(request: Request, user: dict = Depends(_get_current_user)):
    """我最近一条加入申请（含团队名；没有则 application=null）。

    供「团队与工位」无团队分支展示"审核中 / 已被驳回 / 已撤回"，
    并给撤回入口。按 id 倒序取一条：历史申请只是记录，待处理的永远是最新那条。
    """
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT a.*, t.name AS team_name"
            " FROM team_join_applications a JOIN teams t ON t.id = a.team_id"
            " WHERE a.user_id=$1 ORDER BY a.id DESC LIMIT 1",
            user["id"])
    return {"application": _application_out(row) if row is not None else None}


@app.post("/api/v1/join-applications/{application_id}/cancel")
async def cancel_application(
    request: Request,
    application_id: int,
    user: dict = Depends(_get_current_user),
):
    """申请人撤回自己的待审申请（pending → canceled；可再次申请）。

    非本人访问一律 404（不暴露"这条申请存在但不属于你"）。
    """
    async with _acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT * FROM team_join_applications WHERE id=$1 FOR UPDATE",
                application_id)
            if row is None or row["user_id"] != user["id"]:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "APPLICATION_NOT_FOUND"})
            if not can_transition_application(row["status"], "canceled"):
                raise _conflict(
                    "APPLICATION_ALREADY_REVIEWED", "该申请已被处理，无法撤回")
            updated = await conn.fetchrow(
                "UPDATE team_join_applications SET status='canceled', updated_at=now()"
                " WHERE id=$1 RETURNING *",
                application_id)
            team_name = await conn.fetchval(
                "SELECT name FROM teams WHERE id=$1", updated["team_id"])
    return {"canceled": True, "application": _application_out(updated, team_name)}


# ── 团队管理员侧：列表 / 审核 ───────────────────────────────────────────────

@app.get("/api/v1/teams/{team_id}/join-applications")
async def list_applications(
    request: Request,
    team_id: int,
    status: str = "pending",
    user: dict = Depends(_get_current_user),
):
    """加入申请列表（仅团队管理员）。`status=pending`（默认）只看待审；
    `status=all` 看全部；其余合法状态名（approved/rejected/canceled）按状态过滤。
    """
    if status != "all" and status not in JOIN_APPLICATION_STATUS:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_STATUS",
            "detail": "status 只能是 pending/all/" + "/".join(JOIN_APPLICATION_STATUS)})
    async with _acquire(request) as conn:
        team = await _teams._team_or_404(conn, team_id)
        _teams._require_team_admin(team, user)
        if status == "all":
            rows = await conn.fetch(
                "SELECT * FROM team_join_applications WHERE team_id=$1"
                " ORDER BY (status = 'pending') DESC, id DESC",
                team_id)
        else:
            rows = await conn.fetch(
                "SELECT * FROM team_join_applications WHERE team_id=$1 AND status=$2"
                " ORDER BY id DESC",
                team_id, status)
    items = [_application_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@app.post("/api/v1/teams/{team_id}/join-applications/{application_id}/approve")
async def approve_application(
    request: Request,
    team_id: int,
    application_id: int,
    user: dict = Depends(_get_current_user),
):
    """审核通过：申请人入团（`users.team_id` 落值）。

    并发/边界（都在一个事务里，申请行 `FOR UPDATE`）：
    - 非 pending（已审/已撤）→ 409 APPLICATION_ALREADY_REVIEWED；
    - 申请人已加入其他团队（例如同时被邀请码拉进别处）→ 409 ALREADY_IN_TEAM；
    - 工位订阅是团队级：通过即获得团队已开通工位，无需逐成员授权。
    """
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _teams._team_or_404(conn, team_id)
            _teams._require_team_admin(team, user)
            row = await conn.fetchrow(
                "SELECT * FROM team_join_applications WHERE id=$1 FOR UPDATE",
                application_id)
            if row is None or row["team_id"] != team_id:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "APPLICATION_NOT_FOUND"})
            if not can_transition_application(row["status"], "approved"):
                raise _conflict(
                    "APPLICATION_ALREADY_REVIEWED", "该申请已被处理，不能重复审核")
            target = await conn.fetchrow(
                "SELECT id, team_id FROM users WHERE id=$1", row["user_id"])
            if target is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "USER_NOT_FOUND"})
            if target["team_id"] is not None:
                raise _conflict(
                    "ALREADY_IN_TEAM", "该申请人已属于一个团队，不能重复入团")
            await conn.execute(
                "UPDATE users SET team_id=$2, updated_at=now() WHERE id=$1",
                target["id"], team_id)
            updated = await conn.fetchrow(
                "UPDATE team_join_applications"
                " SET status='approved', reviewed_by=$2, reviewed_at=now(), updated_at=now()"
                " WHERE id=$1 RETURNING *",
                application_id, user["id"])
            count = await _teams._member_count(conn, team_id)
    return {"approved": True, "application": _application_out(updated),
            "member_count": count}


@app.post("/api/v1/teams/{team_id}/join-applications/{application_id}/reject")
async def reject_application(
    request: Request,
    team_id: int,
    application_id: int,
    body: ApplicationRejectIn,
    user: dict = Depends(_get_current_user),
):
    """审核驳回（可填理由 ≤200 字）。申请人保持无团队，可再次发起申请。"""
    try:
        reason = validate_reject_reason(body.reason)
    except TeamRuleError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail})
    async with _acquire(request) as conn:
        async with conn.transaction():
            team = await _teams._team_or_404(conn, team_id)
            _teams._require_team_admin(team, user)
            row = await conn.fetchrow(
                "SELECT * FROM team_join_applications WHERE id=$1 FOR UPDATE",
                application_id)
            if row is None or row["team_id"] != team_id:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "APPLICATION_NOT_FOUND"})
            if not can_transition_application(row["status"], "rejected"):
                raise _conflict(
                    "APPLICATION_ALREADY_REVIEWED", "该申请已被处理，不能重复审核")
            updated = await conn.fetchrow(
                "UPDATE team_join_applications"
                " SET status='rejected', reviewed_by=$2, reviewed_at=now(),"
                "     reject_reason=$3, updated_at=now()"
                " WHERE id=$1 RETURNING *",
                application_id, user["id"], reason)
    return {"rejected": True, "application": _application_out(updated)}
