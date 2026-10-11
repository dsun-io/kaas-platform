"""工位订阅（开通 / 撤销 / 我的工位）API —— orchestrator 端适配层。

职责
----
1. `/api/v1/me/workstations`：告诉前端"我开通了哪些工位"，用于**隐藏入口 / 显示开通引导页**；
2. `/api/v1/teams/{id}/subscriptions*`：团队管理员开通/撤销团队工位；
3. `/api/v1/users/{id}/subscriptions*`：平台管理员给个人额外开通/撤销；
4. 维护**进程内订阅缓存**（`app/middleware/workstation.py` 用的那份），
   提供"开通/撤销后立即失效"的入口 —— 否则最长 30 秒内用户仍被拦，体验成"开通了没用"。

判定真源
--------
工位清单、路径映射、生效判定**全部** import 共享内核
`kaas_common/workstation/subscriptions.py`（`all_workstations` / `has_workstation` /
`normalize_codes` / `FULL_CHAIN`）；团队管理员判定 import
`kaas_common/workstation/teams.py` 的 `is_team_admin`。本文件**不另写一份判定**。

授权模型（2026-10-11 业务确认）
------------------------------
业务逻辑不以租户做鉴权边界。真正的边界是「这个**团队** / **个人**开通了哪些**工位**」：

- **团队为主**：团队开通 = 全员可用；
- **个人可额外开通**；
- 平台管理员（system_admin，含历史 admin）不受限；
- 未开通的工位 API 返回 **404**（不暴露工位存在性），拦截在中间件里做；
- 付费暂时手动开通（`source='manual'`），支付渠道以后接。

与生产 Worker 的关系
--------------------
生产端 `backend/worker/src/ws_workstations.py` 是同一契约的另一个适配层（Worker 就是生产）。
两侧的**路径、状态码、错误码、字段名必须逐字一致**，所以本文件与它同构：同一个错误码配同一个
HTTP 状态码，差异只应出现在"怎么读写数据库"（ORM vs asyncpg），不应出现在业务语义上。

事务边界
--------
写操作在**同一事务**里完成（`INSERT ... ON CONFLICT DO UPDATE` 幂等 upsert），
失败即 `rollback`；缓存失效放在 DB 成功之后，避免"写失败但缓存先失效"的抖动。
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from kaas_common.workstation.scope import is_admin_role
from kaas_common.workstation.subscriptions import (
    FULL_CHAIN,
    all_workstations,
    has_workstation,
    normalize_codes,
)
from kaas_common.workstation.teams import is_team_admin

from app.api.ws_common import tenant_id_of
from app.core.auth import AuthContext, get_auth_context
from app.db.models import Team, TeamSubscription, User, UserSubscription
from app.db.session import get_db_session

router = APIRouter(prefix="/api/v1", tags=["workstations"])

# 订阅缓存 TTL：30 秒够短（撤销后最多漏 30 秒），又足以让高频请求不打爆库。
# 开通/撤销端点会**主动清缓存**，所以正常路径上用户感知不到这个延迟。
CACHE_TTL_SECONDS = 30.0


# ── 进程内订阅缓存（中间件与写端点共用同一份）────────────────────────────────
#
# key = user_id；value = (过期时间戳 monotonic, 是否平台管理员, 生效编码)
# 缓存放在本模块而不是中间件里：写端点要清它，中间件只读它，
# 两个模块互相 import 会成环，而"谁写谁清"放在一起最不容易漏。
_SUBSCRIPTION_CACHE: dict[int, tuple[float, bool, frozenset[str]]] = {}


def cached_subscription(user_id) -> Optional[tuple[float, bool, frozenset[str]]]:
    """读缓存；过期返回 None（由调用方决定回源）。"""
    hit = _SUBSCRIPTION_CACHE.get(int(user_id))
    if hit is None or hit[0] <= time.monotonic():
        return None
    return hit


def store_subscription(user_id, is_admin: bool, codes) -> None:
    _SUBSCRIPTION_CACHE[int(user_id)] = (
        time.monotonic() + CACHE_TTL_SECONDS, bool(is_admin), normalize_codes(codes))


def invalidate_users(user_ids) -> None:
    """按用户清缓存（个人开通 / 撤销）。"""
    for uid in user_ids:
        _SUBSCRIPTION_CACHE.pop(int(uid), None)


def invalidate_all() -> None:
    """全清。团队订阅变更影响全团队，而我们无法反查"谁缓存过"，
    全清是最省事且绝不会漏的做法（本进程缓存，代价只有一次回源）。"""
    _SUBSCRIPTION_CACHE.clear()


# ── Schemas ─────────────────────────────────────────────────────────────────

class SubscriptionIn(BaseModel):
    """开通/续期入参。active 留默认 True：`PUT` 不带 body 字段也算开通。

    expires_at 收成 str（而非 datetime）是为了让"格式错误"走我们自己的
    422 `INVALID_EXPIRES_AT`，与 Worker 端逐字一致；否则 FastAPI 会先用自己的
    422 体把请求挡掉，两端错误码就对不上了。
    """
    active: bool = True
    expires_at: Optional[str] = None


# ── Helpers ─────────────────────────────────────────────────────────────────

def _known_codes() -> set[str]:
    """可选编码 = 全部工位 key ∪ 全工位套餐。真源是共享内核的工位清单。"""
    return set(all_workstations()) | {FULL_CHAIN}


def _validate_code(code: str) -> str:
    """校验路径里的工位编码。未知编码 → 422 UNKNOWN_WORKSTATION。"""
    text = (code or "").strip().lower()
    if text not in _known_codes():
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "UNKNOWN_WORKSTATION",
            "detail": f"未知工位：{code}；可选：{', '.join(sorted(_known_codes()))}"})
    return text


def _parse_expires(value: Optional[str]) -> Optional[datetime]:
    """ISO 时间串 → datetime；空串/None = 永久（与"expires_at IS NULL 视为有效"配套）。"""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "INVALID_EXPIRES_AT",
            "detail": "expires_at 需为 ISO 时间，如 2026-12-31T00:00:00+08:00"})


def _sub_out(row) -> dict:
    """订阅行序列化（列表 / 开通 共用同一形态，避免两处字段名漂移）。"""
    return {
        "code": row.code,
        "active": bool(row.active),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "source": row.source,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _set_result_out(row) -> dict:
    """PUT 的响应体 —— 契约逐字规定（**不含** created_at/updated_at）。

    与列表项刻意不同：开通接口只承诺"这个编码现在是什么状态"，
    前端拿它做乐观更新，不需要也不应该依赖行时间戳。
    """
    return {
        "code": row.code,
        "active": bool(row.active),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "source": row.source,
    }


async def _load_user_or_401(db: AsyncSession, user_id) -> User:
    """取当前登录用户的库内行（角色/团队以库为准，不信 token 里的陈旧快照）。"""
    user = (await db.execute(
        select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=401, detail={
            "error": "unauthorized", "code": "USER_NOT_FOUND"})
    return user


async def _live_codes(db: AsyncSession, user: User) -> frozenset[str]:
    """生效编码 = 团队订阅 ∪ 个人订阅（都要求 active 且未过期）。

    平台管理员直接视为 `full_chain`（不受限），**不查表** —— 与 Worker 同口径。
    """
    if is_admin_role(user.role):
        return frozenset({FULL_CHAIN})

    conditions = []
    if user.team_id is not None:
        conditions.append(select(TeamSubscription.code).where(
            TeamSubscription.team_id == user.team_id,
            TeamSubscription.active.is_(True),
            _not_expired(TeamSubscription.expires_at),
        ))
    conditions.append(select(UserSubscription.code).where(
        UserSubscription.user_id == user.id,
        UserSubscription.active.is_(True),
        _not_expired(UserSubscription.expires_at),
    ))

    codes: set[str] = set()
    for stmt in conditions:
        codes |= set((await db.execute(stmt)).scalars().all())
    return normalize_codes(codes)


def _not_expired(column):
    """过期判定：`expires_at IS NULL` 或 `> now()` 视为有效。

    用 SQL 的 `now()`（而不是 Python 的 datetime）与 Worker 的
    `expires_at > now()` 保持**同一时钟**，避免两端因时区/时钟偏差给出不同答案。
    """
    from sqlalchemy import func, or_
    return or_(column.is_(None), column > func.now())


async def _team_or_404(db: AsyncSession, tenant_id: str, team_id: int) -> Team:
    """按租户取团队：跨租户的 team_id 一律当作不存在（不泄露别家团队是否存在）。"""
    team = (await db.execute(
        select(Team).where(Team.tenant_id == tenant_id, Team.id == team_id)
    )).scalar_one_or_none()
    if team is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "TEAM_NOT_FOUND"})
    return team


async def _require_team_admin(db: AsyncSession, tenant_id: str, team_id: int,
                              auth: AuthContext) -> Team:
    """团队管理员（团队创建者）或平台管理员 —— 判定走共享内核 `is_team_admin`。

    顺序刻意是"先 404 后 403"：不存在的团队不该因为调用者不是管理员而返回 403
    （那等于告诉外人"这个 team_id 是存在的"）。
    """
    team = await _team_or_404(db, tenant_id, team_id)
    if not is_team_admin(team.created_by, auth.user_id, auth.role):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "NOT_TEAM_ADMIN",
            "message": "仅团队管理员可管理该团队的工位开通"})
    return team


def _require_platform_admin(auth: AuthContext) -> None:
    """个人工位开通只给平台管理员（团队管理员不能替别人开）。"""
    if not is_admin_role(auth.role):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "ADMIN_ONLY",
            "message": "个人工位开通仅平台管理员可操作"})


# ── 我的工位 ────────────────────────────────────────────────────────────────

@router.get("/me/workstations")
async def my_workstations(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """我开通了哪些工位 —— 前端据此隐藏入口 / 显示"去开通"引导页。

    `workstations` 只列**已开通**的工位 key（按内核清单顺序，稳定可断言）；
    平台管理员返回全部。`codes` 是生效编码（团队 ∪ 个人，规范化后），
    前端在引导页里用它解释"为什么我能用"。
    """
    user = await _load_user_or_401(db, auth.user_id)
    codes = await _live_codes(db, user)
    enabled = [ws for ws in all_workstations() if has_workstation(codes, ws)]
    return {
        "workstations": enabled,
        "codes": sorted(codes),
        "is_admin": is_admin_role(user.role),
        "has_team": user.team_id is not None,
    }


# ── 团队订阅（团队管理员 / 平台管理员）──────────────────────────────────────

@router.get("/teams/{team_id}/subscriptions")
async def list_team_subscriptions(
    team_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """团队订阅列表。

    返回**全部行**（含 active=false）：撤销是"置 false"而不是删行，
    列表要能让管理员看到"曾经开过、现在停了"，也方便审计。
    """
    await _require_team_admin(db, tenant_id_of(auth), team_id, auth)
    rows = (await db.execute(
        select(TeamSubscription).where(TeamSubscription.team_id == team_id)
        .order_by(TeamSubscription.code)
    )).scalars().all()
    items = [_sub_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.put("/teams/{team_id}/subscriptions/{code}")
async def set_team_subscription(
    team_id: int,
    code: str,
    body: SubscriptionIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """开通 / 停用 / 续期某个团队工位（幂等 upsert，`source` 固定 manual）。

    幂等靠唯一索引 `(team_id, code)` 上的 `ON CONFLICT DO UPDATE`：
    重复调用只会把同一行改成同样的值，不会撞唯一约束、也不会产生第二行 ——
    于是"前端重试"和"管理员点两次"都不会出问题。
    """
    target = _validate_code(code)          # 编码先校验：坏编码不必查库（与 Worker 同序）
    expires = _parse_expires(body.expires_at)
    await _require_team_admin(db, tenant_id_of(auth), team_id, auth)

    stmt = pg_insert(TeamSubscription).values(
        team_id=team_id, code=target, active=body.active,
        expires_at=expires, source="manual",
    ).on_conflict_do_update(
        index_elements=["team_id", "code"],
        set_={
            "active": body.active,
            "expires_at": expires,
            # 手动开通覆盖任何历史来源（如 system_migration）：语义是"这是人工决定"
            "source": "manual",
            "updated_at": datetime.now(timezone.utc),
        },
    ).returning(TeamSubscription)
    try:
        row = (await db.execute(stmt)).scalar_one()
        await db.commit()
    except Exception:
        # 同一事务：要么整条 upsert 生效，要么什么都不留
        await db.rollback()
        raise

    # 团队订阅影响**全团队**的可见能力；本进程缓存无法反查"谁缓存过"，
    # 直接全清最稳妥（代价仅是每台进程各回源一次）。
    invalidate_all()
    return _set_result_out(row)


@router.delete("/teams/{team_id}/subscriptions/{code}")
async def revoke_team_subscription(
    team_id: int,
    code: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """撤销团队工位：置 `active=false`（保留行，便于审计"谁在什么时候停的"）。

    不做物理删除：工位开通是**计费相关**的事实，删了就没法回答
    "这个团队上个月开通过什么"。列表接口也据此显示历史。
    """
    target = _validate_code(code)
    await _require_team_admin(db, tenant_id_of(auth), team_id, auth)

    row = (await db.execute(
        select(TeamSubscription).where(
            TeamSubscription.team_id == team_id, TeamSubscription.code == target)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SUBSCRIPTION_NOT_FOUND"})

    row.active = False
    row.updated_at = datetime.now(timezone.utc)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    invalidate_all()
    return {"revoked": True, "code": target}


# ── 个人订阅（仅平台管理员）────────────────────────────────────────────────

@router.get("/users/{user_id}/subscriptions")
async def list_user_subscriptions(
    user_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """个人额外开通的工位列表（仅平台管理员）。结构与团队订阅列表一致。"""
    _require_platform_admin(auth)
    rows = (await db.execute(
        select(UserSubscription).where(UserSubscription.user_id == user_id)
        .order_by(UserSubscription.code)
    )).scalars().all()
    items = [_sub_out(r) for r in rows]
    return {"items": items, "total": len(items)}


@router.put("/users/{user_id}/subscriptions/{code}")
async def set_user_subscription(
    user_id: int,
    code: str,
    body: SubscriptionIn,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """给某个人额外开通工位（仅平台管理员）。

    先确认目标用户存在：`user_subscriptions.user_id` 有外键，账号不存在时
    直接插会撞 FK 违例（表现为 500，完全看不出真实原因）。
    """
    _require_platform_admin(auth)
    target = _validate_code(code)
    expires = _parse_expires(body.expires_at)

    exists = (await db.execute(
        select(User.id).where(User.id == user_id))).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "USER_NOT_FOUND"})

    stmt = pg_insert(UserSubscription).values(
        user_id=user_id, code=target, active=body.active,
        expires_at=expires, source="manual",
    ).on_conflict_do_update(
        index_elements=["user_id", "code"],
        set_={
            "active": body.active,
            "expires_at": expires,
            "source": "manual",
            "updated_at": datetime.now(timezone.utc),
        },
    ).returning(UserSubscription)
    try:
        row = (await db.execute(stmt)).scalar_one()
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    invalidate_users([user_id])
    return _set_result_out(row)


@router.delete("/users/{user_id}/subscriptions/{code}")
async def revoke_user_subscription(
    user_id: int,
    code: str,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """撤销某个人的工位开通（仅平台管理员）—— 置 `active=false`，同团队口径。"""
    _require_platform_admin(auth)
    target = _validate_code(code)

    row = (await db.execute(
        select(UserSubscription).where(
            UserSubscription.user_id == user_id, UserSubscription.code == target)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SUBSCRIPTION_NOT_FOUND"})

    row.active = False
    row.updated_at = datetime.now(timezone.utc)
    try:
        await db.commit()
    except Exception:
        await db.rollback()
        raise

    invalidate_users([user_id])
    return {"revoked": True, "code": target}
