"""Kaas v2 · 请求上下文中间件 (§8.2)

注入 request_id + timing，日志自动绑定 contextvars。
"""
import uuid
import time
import structlog
from contextvars import ContextVar
from starlette.middleware.base import BaseHTTPMiddleware

request_id_var: ContextVar[str] = ContextVar("request_id", default="")
tenant_id_var: ContextVar[str] = ContextVar("tenant_id", default="")


class RequestContextMiddleware(BaseHTTPMiddleware):
    """请求上下文中间件（最外层，最先执行）。

    每个请求:
    - 生成/透传 request_id
    - 记录开始/结束 + elapsed_ms
    - 自动注入 structlog contextvars
    """

    async def dispatch(self, request, call_next):
        rid = request.headers.get("X-Request-Id", str(uuid.uuid4())[:8])
        tid = request.headers.get("X-Tenant-Id", "unknown")

        request_id_var.set(rid)
        tenant_id_var.set(tid)

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=rid,
            tenant_id=tid,
            method=request.method,
            path=request.url.path,
        )

        logger = structlog.get_logger()
        start = time.perf_counter()

        logger.info("request.start")
        try:
            response = await call_next(request)
            elapsed = round((time.perf_counter() - start) * 1000, 1)
            logger.info("request.end", status=response.status_code, elapsed_ms=elapsed)
            response.headers["X-Request-Id"] = rid
            response.headers["X-Elapsed-Ms"] = str(elapsed)
            return response
        except Exception as e:
            elapsed = round((time.perf_counter() - start) * 1000, 1)
            logger.error("request.error", error=str(e), elapsed_ms=elapsed)
            raise
