"""Kaas v2 · Admin Schema"""
from pydantic import BaseModel


class TenantItem(BaseModel):
    """租户列表条目 —— 前端消费契约的形状（P1/P2）。

    键集合是**精确**的：`tenant_id` / `display_name` / `is_active`。
    不保留旧键 `enabled`（Lead 2026-10-11 裁决选 B，理由：用户裁决是「以前端消费契约为准」，
    而 `scripts/contracts-allowlist.txt` 的棘轮用精确键集比对，留旧键 = 该行永久留档、棘轮退不掉）。
    """

    tenant_id: str
    display_name: str | None = None
    is_active: bool = True


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


class TenantReloadItem(BaseModel):
    """重载后的租户条目（前端 reload 表格列：display_name/locale/region/is_active）。"""

    tenant_id: str
    display_name: str | None = None
    locale: str | None = None
    region: str | None = None
    is_active: bool = True


class TenantReloadResponse(BaseModel):
    """热重载响应 —— 前端 reload-button.tsx:56-66 直接 `result.active_tenants.map(...)`。

    P4：必须返回重载后的启用租户清单。键集合精确为 `reloaded_count` + `active_tenants`
    （不保留旧键 `message` / `tenant_count`，理由同 TenantItem）。
    """

    reloaded_count: int
    active_tenants: list[TenantReloadItem]


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
