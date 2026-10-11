"""工位订阅（开通/撤销 + 未开通拦截）—— Worker 端。

授权模型（2026-10-11 业务确认）
------------------------------
业务逻辑**不以租户做鉴权边界**。真正的边界是「这个**团队** / **个人**开通了哪些**工位**」：

- **团队为主**：团队开通 = 全员可用（`team_subscriptions`）
- **个人可额外开通**（`user_subscriptions`）
- 平台管理员不受限
- 未开通的工位 API 返回 **404**（不暴露工位存在性）；前端用 `GET /me/workstations`
  隐藏入口 / 显示开通引导
- 付费暂时手动开通（`source='manual'`），支付渠道以后接

判定真源 = 共享内核 `kaas_common/workstation/subscriptions.py`（工位→路径映射、
生效判定），本文件只负责接 asyncpg 与拦截。
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel

from kaas_common.workstation.subscriptions import (
    ALWAYS_ALLOWED_PREFIXES as _ALWAYS_ALLOWED,
    FULL_CHAIN,
    all_workstations,
    has_workstation,
    is_always_allowed,
    normalize_codes,
    workstation_of,
)
from kaas_common.workstation.teams import is_team_admin
from kaas_common.workstation.scope import is_admin_role

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db
_acquire = _main._acquire

# 有效订阅的 SQL 片段：active 且未过期（expires_at 为空 = 永久）
_LIVE = "active = true AND (expires_at IS NULL OR expires_at > now())"


class SubscriptionIn(BaseModel):
    active: bool = True
    expires_at: Optional[str] = None


# ── 解析：这个人现在开通了哪些工位 ──────────────────────────────────────────

async def _codes_for_user(conn, user: dict) -> frozenset[str]:
    """生效编码 = 团队订阅 ∪ 个人订阅；平台管理员视为拥有全工位。"""
    if is_admin_role(user.get("role")):
        return frozenset({FULL_CHAIN})
    codes: set[str] = set()
    if user.get("team_id") is not None:
        rows = await conn.fetch(
            f"SELECT code FROM team_subscriptions WHERE team_id=$1 AND {_LIVE}",
            user["team_id"])
        codes |= {r["code"] for r in rows}
    rows = await conn.fetch(
        f"SELECT code FROM user_subscriptions WHERE user_id=$1 AND {_LIVE}", user["id"])
    codes |= {r["code"] for r in rows}
    return normalize_codes(codes)


def _known_codes() -> set[str]:
    return set(all_workstations()) | {FULL_CHAIN}


def _validate_code(code: str) -> str:
    text = (code or "").strip().lower()
    if text not in _known_codes():
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_WORKSTATION",
            "detail": f"未知工位：{code}；可选：{', '.join(sorted(_known_codes()))}"})
    return text


def _parse_expires(value: Optional[str]):
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_EXPIRES_AT",
            "detail": "expires_at 需为 ISO 时间，如 2026-12-31T00:00:00+08:00"})
    return parsed


def _sub_out(row) -> dict:
    d = dict(row)
    return {
        "code": d["code"], "active": bool(d["active"]),
        "expires_at": d["expires_at"].isoformat() if d.get("expires_at") else None,
        "source": d.get("source"),
        "created_at": d["created_at"].isoformat() if d.get("created_at") else None,
    }


def _sub_set_out(row) -> dict:
    """PUT（开通/续期）的响应体：契约固定这 4 个字段，两端逐字一致。

    列表接口用 `_sub_out`（多一个 created_at），开通接口不返回它 —— 前端只用这 4 个。
    """
    d = dict(row)
    return {
        "code": d["code"], "active": bool(d["active"]),
        "expires_at": d["expires_at"].isoformat() if d.get("expires_at") else None,
        "source": d.get("source"),
    }


# ── 我的工位 ────────────────────────────────────────────────────────────────

@app.get("/api/v1/me/workstations")
async def my_workstations(request: Request, user: dict = Depends(_get_current_user)):
    """我开通了哪些工位 —— 前端据此隐藏入口 / 显示"去开通"引导页。

    平台管理员返回全部工位（他们不受订阅限制）。
    """
    async with _acquire(request) as conn:
        codes = await _codes_for_user(conn, user)
    enabled = [ws for ws in all_workstations() if has_workstation(codes, ws)]
    return {
        "workstations": enabled,
        "codes": sorted(codes),
        "is_admin": is_admin_role(user.get("role")),
        "has_team": user.get("team_id") is not None,
    }


# ── 团队订阅（团队管理员 / 平台管理员）──────────────────────────────────────

async def _require_team_admin(conn, team_id: int, user: dict) -> dict:
    team = await conn.fetchrow(
        "SELECT * FROM teams WHERE id=$1 AND tenant_id=$2", team_id, DEFAULT_TENANT)
    if team is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEAM_NOT_FOUND"})
    if not is_team_admin(team["created_by"], user["id"], user.get("role")):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理该团队的工位开通"})
    return dict(team)


@app.get("/api/v1/teams/{team_id}/subscriptions")
async def list_team_subscriptions(
    request: Request,
    team_id: int,
    user: dict = Depends(_get_current_user),
):
    async with _acquire(request) as conn:
        await _require_team_admin(conn, team_id, user)
        rows = await conn.fetch(
            "SELECT * FROM team_subscriptions WHERE team_id=$1 ORDER BY code", team_id)
    items = [_sub_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@app.put("/api/v1/teams/{team_id}/subscriptions/{code}")
async def set_team_subscription(
    request: Request,
    team_id: int,
    code: str,
    body: SubscriptionIn,
    user: dict = Depends(_get_current_user),
):
    """开通/续期某个工位（幂等 upsert）。

    写完后**立即失效**该团队成员的缓存，否则最长 30 秒内仍会被拦（体验成"开通了没用"）。
    """
    target = _validate_code(code)
    expires = _parse_expires(body.expires_at)
    async with _acquire(request) as conn:
        async with conn.transaction():
            await _require_team_admin(conn, team_id, user)
            row = await conn.fetchrow(
                "INSERT INTO team_subscriptions (team_id, code, active, expires_at, source)"
                " VALUES ($1,$2,$3,$4,'manual')"
                " ON CONFLICT (team_id, code) DO UPDATE SET"
                "   active = EXCLUDED.active, expires_at = EXCLUDED.expires_at,"
                "   source = 'manual', updated_at = now()"
                " RETURNING *",
                team_id, target, body.active, expires)
    # 整体清空：开通/撤销影响的是"整个团队"，只清操作者会让队友最长 30 秒仍被拦，
    # 被体验成"管理员开通了但成员进不去"。
    _invalidate_all()
    return _sub_set_out(row)


@app.delete("/api/v1/teams/{team_id}/subscriptions/{code}")
async def revoke_team_subscription(
    request: Request,
    team_id: int,
    code: str,
    user: dict = Depends(_get_current_user),
):
    target = _validate_code(code)
    async with _acquire(request) as conn:
        async with conn.transaction():
            await _require_team_admin(conn, team_id, user)
            row = await conn.fetchrow(
                "UPDATE team_subscriptions SET active=false, updated_at=now()"
                " WHERE team_id=$1 AND code=$2 RETURNING id", team_id, target)
            if row is None:
                raise HTTPException(status_code=404, detail={
                    "error": "not_found", "code": "SUBSCRIPTION_NOT_FOUND"})
    _invalidate_all()
    return {"revoked": True, "code": target}


# ── 个人订阅（仅平台管理员）────────────────────────────────────────────────

def _require_platform_admin(user: dict) -> None:
    if not is_admin_role(user.get("role")):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "ADMIN_ONLY",
            "message": "个人工位开通仅平台管理员可操作"})


@app.get("/api/v1/users/{user_id}/subscriptions")
async def list_user_subscriptions(
    request: Request,
    user_id: int,
    user: dict = Depends(_get_current_user),
):
    _require_platform_admin(user)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            "SELECT * FROM user_subscriptions WHERE user_id=$1 ORDER BY code", user_id)
    items = [_sub_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@app.put("/api/v1/users/{user_id}/subscriptions/{code}")
async def set_user_subscription(
    request: Request,
    user_id: int,
    code: str,
    body: SubscriptionIn,
    user: dict = Depends(_get_current_user),
):
    _require_platform_admin(user)
    target = _validate_code(code)
    expires = _parse_expires(body.expires_at)
    async with _acquire(request) as conn:
        exists = await conn.fetchval("SELECT 1 FROM users WHERE id=$1", user_id)
        if exists is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "USER_NOT_FOUND"})
        row = await conn.fetchrow(
            "INSERT INTO user_subscriptions (user_id, code, active, expires_at, source)"
            " VALUES ($1,$2,$3,$4,'manual')"
            " ON CONFLICT (user_id, code) DO UPDATE SET"
            "   active = EXCLUDED.active, expires_at = EXCLUDED.expires_at,"
            "   source = 'manual', updated_at = now()"
            " RETURNING *",
            user_id, target, body.active, expires)
    _invalidate_cache(user_id)
    return _sub_set_out(row)


@app.delete("/api/v1/users/{user_id}/subscriptions/{code}")
async def revoke_user_subscription(
    request: Request,
    user_id: int,
    code: str,
    user: dict = Depends(_get_current_user),
):
    _require_platform_admin(user)
    target = _validate_code(code)
    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "UPDATE user_subscriptions SET active=false, updated_at=now()"
            " WHERE user_id=$1 AND code=$2 RETURNING id", user_id, target)
        if row is None:
            raise HTTPException(status_code=404, detail={
                "error": "not_found", "code": "SUBSCRIPTION_NOT_FOUND"})
    _invalidate_cache(user_id)
    return {"revoked": True, "code": target}


# ── 拦截：未开通的工位一律 404 ──────────────────────────────────────────────

# user_id → (过期时间戳, 生效编码)。30 秒够短，开通/撤销时会主动失效。
_CODES_CACHE: dict[int, tuple[float, frozenset[str]]] = {}
_CACHE_TTL_SECONDS = 30.0


def _invalidate_cache(user_id) -> None:
    _CODES_CACHE.pop(int(user_id), None)


def _invalidate_all() -> None:
    """团队级开通/撤销影响全团队 —— 整体清空，避免"管理员开通了队友却还进不去"。"""
    _CODES_CACHE.clear()


async def _cached_codes(request: Request, user_id: int) -> frozenset[str]:
    import time as _time

    now = _time.monotonic()
    hit = _CODES_CACHE.get(user_id)
    if hit is not None and hit[0] > now:
        return hit[1]

    async with _acquire(request) as conn:
        row = await conn.fetchrow(
            "SELECT id, role, team_id FROM users WHERE id=$1", user_id)
        if row is None:
            return frozenset()
        codes = await _codes_for_user(conn, dict(row))
    _CODES_CACHE[user_id] = (now + _CACHE_TTL_SECONDS, codes)
    return codes


@app.middleware("http")
async def enforce_workstation_subscription(request: Request, call_next):
    """未开通的工位 → 404（不暴露工位存在性）。

    几条安全约定：
    - 只处理 `/api/` 且**属于某个工位**的路径；`is_always_allowed` 的一律放行
      （账号/团队/订阅接口必须可用，否则用户没法"去开通"）；
    - **没有 token 就放行** —— 认证是路由自身依赖的职责，中间件不越权；
    - 任何异常（token 解不开、DB 不通）都放行：订阅校验出问题不该让整个服务不可用。
    """
    from fastapi.responses import JSONResponse

    path = request.url.path
    if not path.startswith("/api/") or is_always_allowed(path):
        return await call_next(request)
    workstation = workstation_of(path)
    if workstation is None:
        return await call_next(request)

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return await call_next(request)

    try:
        user_id = int(_main._decode_token(auth[7:], request)["sub"])
        codes = await _cached_codes(request, user_id)
        if not has_workstation(codes, workstation):
            return JSONResponse(status_code=404, content={
                "error": "not_found", "code": "WORKSTATION_NOT_SUBSCRIBED",
                "workstation": workstation,
                "detail": "该工位未开通，请在“工位开通”里启用",
            })
    except Exception:
        pass
    return await call_next(request)
