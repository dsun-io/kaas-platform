"""Kaas v2 · API package."""

from app.api.events import router as events_router
from app.api.oss_presign import router as oss_presign_router
from app.api.admin import router as admin_router

__all__ = ["events_router", "oss_presign_router", "admin_router"]
