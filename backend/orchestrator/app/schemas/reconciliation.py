"""
Kaas v2 · 电商对账模块 Schema
────────────────────────────────
设计原则：
- 所有金额字段使用 Decimal（前端传字符串，后端解析）
- tenant_id 由中间件注入，不在 schema 中暴露
- 平台与物流商配置完全可扩展，不硬编码枚举
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator


# ═══════════════════════════════════════════════════════════════
# EcommercePlatformConfig（电商平台配置）
# ═══════════════════════════════════════════════════════════════

class EcommercePlatformConfigCreate(BaseModel):
    platform_name: str = Field(..., min_length=1, max_length=50)
    platform_display_name: str = Field(..., min_length=1, max_length=100)
    platform_type: str = Field(..., min_length=1, max_length=50)  # taobao | jd | pdd | douyin | custom
    api_endpoint: str = Field(..., pattern=r"^https://")
    api_version: Optional[str] = "v1"
    credentials_encrypted: str
    credentials_kms_key_id: str
    credentials_encryption_context: Dict[str, Any]
    config_params: Optional[Dict[str, Any]] = None
    supported_fields: Optional[List[str]] = None


class EcommercePlatformConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tenant_id: str
    platform_name: str
    platform_display_name: str
    platform_type: str
    api_endpoint: str
    api_version: Optional[str]
    credentials_kms_key_id: str
    config_params: Optional[Dict[str, Any]]
    supported_fields: Optional[List[str]]
    is_enabled: bool
    last_sync_at: Optional[datetime]
    sync_status: Optional[str]
    created_at: datetime
    updated_at: datetime


# ═══════════════════════════════════════════════════════════════
# LogisticsProviderConfig（物流商配置）
# ═══════════════════════════════════════════════════════════════

class LogisticsProviderConfigCreate(BaseModel):
    provider_name: str = Field(..., min_length=1, max_length=50)
    provider_display_name: str = Field(..., min_length=1, max_length=100)
    provider_type: str = Field(..., min_length=1, max_length=50)  # express | freight | courier | custom
    api_endpoint: str = Field(..., pattern=r"^https://")
    api_version: Optional[str] = "v1"
    credentials_encrypted: str
    credentials_kms_key_id: str
    credentials_encryption_context: Dict[str, Any]
    config_params: Optional[Dict[str, Any]] = None
    supported_bill_formats: Optional[List[str]] = None


class LogisticsProviderConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tenant_id: str
    provider_name: str
    provider_display_name: str
    provider_type: str
    api_endpoint: str
    api_version: Optional[str]
    credentials_kms_key_id: str
    config_params: Optional[Dict[str, Any]]
    supported_bill_formats: Optional[List[str]]
    is_enabled: bool
    last_sync_at: Optional[datetime]
    sync_status: Optional[str]
    created_at: datetime
    updated_at: datetime


# ═══════════════════════════════════════════════════════════════
# ReconciliationReport（对账报告）
# ═══════════════════════════════════════════════════════════════

class ReconciliationReportCreate(BaseModel):
    report_name: str = Field(..., min_length=1, max_length=255)
    report_period_start: date
    report_period_end: date
    platform_ids: List[int]
    logistics_provider_ids: List[int]

    @field_validator("report_period_end")
    @classmethod
    def end_after_start(cls, v: date, info) -> date:
        values = info.data
        if values.get("report_period_start") and v < values["report_period_start"]:
            raise ValueError("report_period_end must be >= report_period_start")
        return v


class ReconciliationReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tenant_id: str
    report_name: str
    report_period_start: date
    report_period_end: date
    platform_ids: List[int]
    platform_config_snapshot: Optional[List[Dict[str, Any]]]
    logistics_provider_ids: List[int]
    logistics_config_snapshot: Optional[List[Dict[str, Any]]]
    total_platform_order_count: int
    total_platform_amount: Decimal
    total_logistics_bill_count: int
    total_logistics_amount: Decimal
    diff_summary: Optional[Dict[str, Any]]
    unmatched_platform_orders: int
    unmatched_logistics_bills: int
    status: str
    triggered_by_user_id: Optional[int]
    completed_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class ReconciliationReportListResponse(BaseModel):
    items: List[ReconciliationReportOut]
    total: int


# ═══════════════════════════════════════════════════════════════
# ReconciliationDiff（差异明细）
# ═══════════════════════════════════════════════════════════════

class ReconciliationDiffOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tenant_id: str
    reconciliation_report_id: int
    diff_type: str
    platform_order_id: Optional[str]
    platform_name: Optional[str]
    platform_sku: Optional[str]
    platform_quantity: Optional[int]
    platform_amount: Optional[Decimal]
    platform_order_date: Optional[date]
    logistics_bill_id: Optional[str]
    logistics_provider: Optional[str]
    logistics_bill_no: Optional[str]
    logistics_freight_fee: Optional[Decimal]
    logistics_bill_date: Optional[date]
    diff_amount: Optional[Decimal]
    diff_reason: Optional[str]
    resolution_status: str
    resolved_by_user_id: Optional[int]
    resolved_at: Optional[datetime]
    resolution_notes: Optional[str]
    created_at: datetime


class ReconciliationDiffListResponse(BaseModel):
    items: List[ReconciliationDiffOut]
    total: int


class ResolveDiffRequest(BaseModel):
    resolution_status: Literal["resolved", "ignored"] = "resolved"
    resolution_notes: Optional[str] = Field(None, max_length=500)


# ═══════════════════════════════════════════════════════════════
# 对账执行与结果
# ═══════════════════════════════════════════════════════════════

class RunReconciliationRequest(BaseModel):
    report_id: int
    matching_strategy: str = Field(default="order_id_exact")  # order_id_exact | fuzzy | manual


class RunReconciliationResponse(BaseModel):
    report_id: int
    status: str
    summary: Dict[str, Any]
    message: str


class ReconciliationDashboardStats(BaseModel):
    total_reports: int
    last_report_date: Optional[datetime]
    total_unresolved_diffs: int
    total_platforms: int
    total_logistics_providers: int
    recent_reports: List[ReconciliationReportOut]
