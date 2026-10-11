"""工位订阅拦截中间件 —— 未开通的工位一律 404（不暴露工位存在性）。

为什么需要它
------------
授权模型（2026-10-11 业务确认）：业务逻辑**不以租户做鉴权边界**，真正的边界是
「这个**团队** / **个人**开通了哪些**工位**」。既然工位是**计费单元**，那么"没开通"
就不能是 403（那等于告诉所有人"这个工位存在，只是你没买"），而应该是 **404**：
从前端看，未开通的工位与不存在的接口**无法区分**。

判定真源 = 共享内核 `kaas_common/workstation/subscriptions.py`
（`workstation_of` 路径→工位、`is_always_allowed` 永不锁死清单、`has_workstation` 生效判定）。
本模块只负责"从请求里拿到 user_id、拿到他的生效编码、比对"，**不另写一份判定**。

与生产 Worker 的关系
--------------------
生产端同一个拦截写在 `backend/worker/src/ws_workstations.py` 的 `@app.middleware("http")` 里，
状态码与错误体逐字一致（404 / `WORKSTATION_NOT_SUBSCRIBED` / `workstation` 字段）。

三条安全约定（照抄 Worker，两端行为必须一致）
--------------------------------------------
1. 只处理 `/api/` 开头的请求；`is_always_allowed(path)` 或 `workstation_of(path) is None`
   一律放行 —— 账号/团队/订阅接口必须永远可用，否则用户没法"去开通工位"（死锁）。
2. **没有 token 就放行**：认证是路由自身依赖（`get_auth_context`）的职责，
   中间件不越权。否则这里就要重复一遍 401 语义，还会和认证中间件打架。
3. **任何异常都放行**（token 解不开、DB 连不上……）：订阅校验出问题绝不能让
   整个服务不可用 —— 宁可短暂多给访问，也不能把所有用户关在门外。
"""
from __future__ import annotations

import structlog
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from kaas_common.workstation.subscriptions import (
    has_workstation,
    is_always_allowed,
    workstation_of,
)

from app.core.auth import decode_access_token

logger = structlog.get_logger(__name__)


class WorkstationSubscriptionMiddleware(BaseHTTPMiddleware):
    """未开通工位 → 404。

    读 `app/api/workstations.py` 里的进程内订阅缓存（TTL 30 秒），
    缓存未命中才回源查一次 `users` + 两张订阅表。
    """

    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not path.startswith("/api/"):
            return await call_next(request)

        # 内核判定：永不锁死的路径 / 不属于任何收费工位的路径，直接放行
        if is_always_allowed(path):
            return await call_next(request)
        workstation = workstation_of(path)
        if workstation is None:
            return await call_next(request)

        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            # 无 token：交给路由自己的鉴权去 401（中间件不负责认证）
            return await call_next(request)

        try:
            if not await self._has_access(auth_header[7:], workstation):
                return JSONResponse(status_code=404, content={
                    "error": "not_found",
                    "code": "WORKSTATION_NOT_SUBSCRIBED",
                    "workstation": workstation,
                    "detail": "该工位未开通，请在“工位开通”里启用",
                })
        except Exception as exc:
            # 放行 + 记一笔：订阅校验故障不该让服务整体不可用
            logger.warning(
                "workstation.middleware.check_failed",
                path=path, workstation=workstation, error=str(exc),
            )
        return await call_next(request)

    async def _has_access(self, token: str, workstation: str) -> bool:
        """是否开通了该工位。缓存优先，未命中回源一次。"""
        # 延迟到函数内 import：避免 app.main 的中间件注册顺序对导入图产生约束
        # （本模块只依赖"零三方依赖"的共享内核与 app 内部模块，不存在真循环）
        from app.api.workstations import (
            _live_codes,
            cached_subscription,
            store_subscription,
        )
        from app.db.models import User
        from app.db.session import async_session_factory

        payload = decode_access_token(token)
        user_id = int(payload["sub"])

        hit = cached_subscription(user_id)
        if hit is not None:
            # 缓存第三项就是生效编码（`_live_codes` 已把平台管理员折算成 full_chain）
            return has_workstation(hit[2], workstation)

        # 自建会话：中间件跑在 FastAPI 依赖注入之外，拿不到 request-scoped session。
        # 用中性的 key 名 `db` 而非 `session`，避免与 SQLAlchemy 的 session 概念混淆。
        async with async_session_factory() as db:
            user = (await db.execute(
                select(User).where(User.id == user_id))).scalar_one_or_none()
            if user is None:
                # 用户不存在/已删除：没有任何可判定的订阅，交给路由鉴权处理（会 401）
                return True
            codes = await _live_codes(db, user)
            # 缓存的是**生效编码**而不是"是不是管理员"：管理员在 `_live_codes` 里
            # 已被折算成 full_chain，判定本身仍由内核 `has_workstation` 做。
            # 角色变更后最多 30 秒旧结果（写端点会主动清缓存）。
            store_subscription(user_id, False, codes)

        return has_workstation(codes, workstation)
