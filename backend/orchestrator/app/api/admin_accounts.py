"""平台账号治理 API —— 列表 / 停用 / 恢复（**无物理删除**）。

契约（两端一致）：
- ``GET  /api/v1/admin/accounts``                      账号列表（白名单序列化）
- ``PATCH /api/v1/admin/accounts/{user_id}``           body ``{"status": "active"|"disabled"}``

安全边界：
- 仅 ``account_type=internal`` 且 ``effective_role=system_admin``（含历史 ``admin`` 映射）可访问；
- 响应**绝不含** password_hash / token 等敏感字段；
- 保护：禁停自己（409 SELF_PROTECT）、禁停最后一名 active system_admin（409 LAST_ADMIN）；
- **不提供任何删除账号/团队的端点**。
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import AuthContext
from app.core.auth_utils import require_internal
from app.db.models import Team, User
from app.db.session import get_db_session

router = APIRouter(prefix="/api/v1/admin", tags=["admin-accounts"])

# 角色 → effective_role 映射（与 AuthContext.effective_role / kaas_common scope 同源）
_ROLE_MAP = {
    "system_admin": "system_admin",
    "admin": "system_admin",
    "owner": "customer_owner",
    "customer_owner": "customer_owner",
    "user": "customer_member",
    "customer_member": "customer_member",
}
_ACCOUNT_STATUSES = frozenset({"active", "disabled"})


class AccountStatusIn(BaseModel):
    """PATCH 请求体。"""

    status: str = Field(..., description="active | disabled")


def _account_out(user: User, team_name: str | None) -> dict:
    """账号白名单序列化 —— 显式列举允许字段，绝不透出敏感列。"""
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "account_type": user.account_type,
        "role": _ROLE_MAP.get(user.role, "customer_member"),
        "status": user.status,
        "team_id": user.team_id,
        "team_name": team_name,
        "console_access": bool(user.console_access),
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
    }


@router.get("/accounts")
async def list_accounts(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """列出全部账号（system_admin 专属）。响应不含 password_hash/token。"""
    auth: AuthContext | None = getattr(request.state, "auth", None)
    if auth is None:
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    require_internal(auth)

    rows = (
        (
            await db.execute(
                select(User).order_by(User.id)
            )
        )
        .scalars()
        .all()
    )
    team_ids = {u.team_id for u in rows if u.team_id is not None}
    team_names: dict[int, str] = {}
    if team_ids:
        for tid, name in (
            await db.execute(select(Team.id, Team.name).where(Team.id.in_(team_ids)))
        ).all():
            team_names[tid] = name
    return {"accounts": [_account_out(u, team_names.get(u.team_id)) for u in rows]}


@router.patch("/accounts/{user_id}")
async def update_account_status(
    user_id: int,
    body: AccountStatusIn,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
):
    """停用 / 恢复账号（system_admin 专属）。"""
    auth: AuthContext | None = getattr(request.state, "auth", None)
    if auth is None:
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    require_internal(auth)

    target = body.status.strip().lower()
    if target not in _ACCOUNT_STATUSES:
        raise HTTPException(
            status_code=422,
            detail={"error": "validation_error", "message": "status must be active|disabled"},
        )

    user = (
        await db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=404, detail={"error": "not_found"})

    if target == "disabled":
        # 保护 1：禁止停用当前登录管理员（自停）
        if user.id == auth.user_id:
            raise HTTPException(
                status_code=409,
                detail={"error": "conflict", "code": "SELF_PROTECT"},
            )
        # 保护 2：禁止停用最后一名 active system_admin（历史 admin 同义）
        if _ROLE_MAP.get(user.role, "customer_member") == "system_admin" and user.status == "active":
            remaining = (
                await db.execute(
                    select(func.count())
                    .select_from(User)
                    .where(
                        User.status == "active",
                        User.role.in_(("system_admin", "admin")),
                    )
                )
            ).scalar_one()
            if remaining <= 1:
                raise HTTPException(
                    status_code=409,
                    detail={"error": "conflict", "code": "LAST_ADMIN"},
                )

    user.status = target
    await db.commit()

    team_name = None
    if user.team_id is not None:
        team_name = (
            await db.execute(select(Team.name).where(Team.id == user.team_id))
        ).scalar_one_or_none()

    return {"account": _account_out(user, team_name)}
