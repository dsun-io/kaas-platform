"""Kaas v2 · config package."""

from app.config.settings import settings
from app.config.tenant_config import get_tenant, get_all_tenants, get_tenant_datasets

__all__ = ["settings", "get_tenant", "get_all_tenants", "get_tenant_datasets"]
