"""
Kaas v2 · Admin API 鉴权依赖 (§3.7.18)
──────────────────────────────────────
统一 Authorization: Bearer ${ADMIN_RELOAD_TOKEN} 鉴权。
"""
import os
from fastapi import Request, HTTPException
from fastapi.responses import JSONResponse

ADMIN_RELOAD_TOKEN = os.environ.get("ADMIN_RELOAD_TOKEN", "dev-admin-token")


async def verify_admin_token(request: Request):
    """验证 Bearer token，失败返回 401。"""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(
            status_code=401,
            detail={"error": "unauthorized", "message": "Bearer token required"},
        )
    token = auth[7:]
    if token != ADMIN_RELOAD_TOKEN:
        raise HTTPException(
            status_code=401,
            detail={"error": "unauthorized", "message": "Invalid admin token"},
        )
    return token
