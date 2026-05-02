"""Kaas v2 · middleware package."""

from app.middleware.tenant import TenantContextMiddleware

__all__ = ["TenantContextMiddleware"]
