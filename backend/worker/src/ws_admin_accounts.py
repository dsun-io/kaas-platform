"""平台账号治理（列表 / 停用 / 恢复，**无物理删除**）—— Worker 端。

与 orchestrator `app/api/admin_accounts.py` 同路径、同方法、同响应键集：
- ``GET  /api/v1/admin/accounts``
- ``PATCH /api/v1/admin/accounts/{user_id}``  body ``{"status": "active"|"disabled"}``

鉴权：``account_type='internal'`` 且 ``is_admin_role(role)``（含历史 admin→system_admin 映射）。
保护：SELF_PROTECT（禁停自己）/ LAST_ADMIN（禁停最后一名 active system_admin）均 409。
响应白名单序列化，绝不含 password_hash/token。
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from kaas_common.workstation.scope import is_admin_role

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire

_ACCOUNT_STATUSES = frozenset({"active", "disabled"})


class AccountStatusIn(BaseModel):
    status: str


def _require_system_admin(user: dict) -> None:
    if user.get("account_type") != "internal" or not is_admin_role(user.get("role")):
        raise HTTPException(status_code=403, detail={"error": "forbidden"})


def _account_out(row) -> dict:
    """白名单序列化 —— 显式列举允许字段。"""
    from kaas_common.workstation.scope import effective_role

    return {
        "id": row["id"],
        "email": row["email"],
        "display_name": row["display_name"],
        "account_type": row["account_type"],
        "role": effective_role(row["role"]),
        "status": row["status"],
        "team_id": row["team_id"],
        "team_name": row.get("team_name"),
        "console_access": bool(row["console_access"]),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "updated_at": row["updated_at"].isoformat() if row["updated_at"] else None,
    }


@app.get("/api/v1/admin/accounts")
async def list_accounts(request: Request, user: dict = Depends(_get_current_user)):
    """账号列表（system_admin 专属）。"""
    _require_system_admin(user)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT u.id, u.email, u.display_name, u.account_type, u.role, u.status,"
            " u.team_id, u.console_access, u.created_at, u.updated_at, t.name AS team_name"
            " FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.id"
        )
    return {"accounts": [_account_out(r) for r in rows]}


@app.patch("/api/v1/admin/accounts/{user_id}")
async def update_account_status(
    user_id: int,
    body: AccountStatusIn,
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """停用 / 恢复账号（system_admin 专属）。"""
    _require_system_admin(user)

    target = (body.status or "").strip().lower()
    if target not in _ACCOUNT_STATUSES:
        raise HTTPException(
            status_code=422,
            detail={"error": "validation_error", "message": "status must be active|disabled"},
        )

    async with _acquire(request) as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT id, email, display_name, account_type, role, status, team_id,"
                " console_access, created_at, updated_at FROM users WHERE id=$1",
                user_id,
            )
            if row is None:
                raise HTTPException(status_code=404, detail={"error": "not_found"})

            if target == "disabled":
                if row["id"] == user["id"]:
                    raise HTTPException(
                        status_code=409,
                        detail={"error": "conflict", "code": "SELF_PROTECT"},
                    )
                if row["status"] == "active" and is_admin_role(row["role"]):
                    remaining = await conn.fetchval(
                        "SELECT count(*) FROM users WHERE status='active'"
                        " AND role IN ('system_admin','admin')"
                    )
                    if remaining <= 1:
                        raise HTTPException(
                            status_code=409,
                            detail={"error": "conflict", "code": "LAST_ADMIN"},
                        )

            row = await conn.fetchrow(
                "UPDATE users SET status=$2, updated_at=now() WHERE id=$1"
                " RETURNING id, email, display_name, account_type, role, status,"
                " team_id, console_access, created_at, updated_at",
                user_id,
                target,
            )

        team_name = None
        if row["team_id"] is not None:
            team_name = await conn.fetchval(
                "SELECT name FROM teams WHERE id=$1", row["team_id"]
            )

    enriched = {**row, "team_name": team_name}
    return {"account": _account_out(enriched)}
