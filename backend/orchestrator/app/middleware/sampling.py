"""
Kaas v2 · 采样中间件（最外层 · §3.7.11）
──────────────────────────────────────────
5 档采样决策:
  - HTTP 4xx/5xx: 100%
  - 慢请求 P95 之上: 100%
  - capability.update / kb.edit / 调价: 100%
  - audit.access: 100%
  - 正常请求: env NORMAL_SAMPLING_RATE (default 10%)
"""
import os
import random
import time
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from app.domain.tenant_config import load_tenant_config

NORMAL_SAMPLING_RATE = float(os.environ.get("NORMAL_SAMPLING_RATE", "0.1"))
P95_THRESHOLD_MS = int(os.environ.get("P95_THRESHOLD_MS", "1500"))
FORCE_SAMPLE_EVENT_TYPES = frozenset(
    {"capability.update", "kb.edit", "quote.request", "quote.response"}
)


class SamplingMiddleware(BaseHTTPMiddleware):
    """采样中间件（最外层）。"""

    async def dispatch(self, request: Request, call_next):
        request.state._start_time = time.perf_counter()

        sampling_rate = NORMAL_SAMPLING_RATE
        tenant_id = request.headers.get("X-Tenant-Id")
        if tenant_id:
            tenant_config = load_tenant_config(tenant_id)
            if tenant_config:
                sampling_rate = tenant_config.get("feature_flags", {}).get(
                    "sampling_rate", NORMAL_SAMPLING_RATE
                )

        request.state.sampled = random.random() < sampling_rate

        response = await call_next(request)

        elapsed_ms = (time.perf_counter() - request.state._start_time) * 1000

        # 强制采样: 管理路径
        if request.url.path.startswith("/api/v1/admin"):
            request.state.sampled = True
        # 强制采样: HTTP 错误
        elif response.status_code >= 400:
            request.state.sampled = True
        # 强制采样: 慢请求
        elif elapsed_ms > P95_THRESHOLD_MS:
            request.state.sampled = True
        # 强制采样: 特定 event_type（从 body 读取）
        elif request.method == "POST" and request.url.path == "/api/v1/events":
            try:
                body = await request.body()
                import json
                data = json.loads(body)
                if data.get("event_type") in FORCE_SAMPLE_EVENT_TYPES:
                    request.state.sampled = True
            except Exception:
                pass

        response.headers["X-Sampled"] = str(request.state.sampled).lower()
        return response
