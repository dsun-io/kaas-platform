"""Kaas v2 · 安全中间件 (§14)

CORS 配置 + 基础安全响应头。
"""
import os


def setup_security_headers(app):
    """注入基础安全响应头。"""

    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response
