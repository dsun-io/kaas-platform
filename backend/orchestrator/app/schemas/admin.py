"""Kaas v2 · Admin Schema"""
from pydantic import BaseModel


class TenantItem(BaseModel):
    tenant_id: str
    display_name: str | None = None
    enabled: bool = True


class TenantListResponse(BaseModel):
    tenants: list[TenantItem]


class TenantDetailResponse(BaseModel):
    tenant_id: str
    config: dict


class FeatureFlagResponse(BaseModel):
    tenant_id: str
    feature_flags: dict


class FeatureFlagRequest(BaseModel):
    tenant_id: str
    flag_name: str
    flag_value: bool


class FeatureFlagSetResponse(BaseModel):
    tenant_id: str
    flag_name: str
    old_value: bool | None = None
    new_value: bool


class CacheClearResponse(BaseModel):
    cleared_sessions: int


class TenantReloadResponse(BaseModel):
    message: str
    tenant_count: int


class MetricsSummaryResponse(BaseModel):
    active_sessions: int


class AuditLogItem(BaseModel):
    timestamp: str | None = None
    action: str | None = None
    tenant_id: str | None = None


class AuditLogResponse(BaseModel):
    audit_logs: list[dict]
    count: int


class ArchiveLogItem(BaseModel):
    id: str
    tenant_id: str
    month: str
    minio_path: str
    status: str
    archived_at: str


class ArchiveLogResponse(BaseModel):
    logs: list[ArchiveLogItem]
