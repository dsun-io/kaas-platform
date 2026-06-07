"""
Kaas v2 · 财务工位 — 智能开票模块 Schema
───────────────────────────────────────────
设计原则：
- 所有金额字段使用 Decimal（前端传字符串，后端解析）
- tenant_id 由中间件注入，不在 schema 中暴露
- 状态机校验在 API 层，业务逻辑在 Service 层
"""

from datetime import datetime
from decimal import Decimal
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, ConfigDict, field_validator


# ── 基础响应 ──
class InvoiceResponseBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    tenant_id: str
    status: str
    created_at: datetime
    updated_at: datetime


# ═══════════════════════════════════════════════════════════════
# InvoiceRequest（开票请求）
# ═══════════════════════════════════════════════════════════════

class InvoiceRequestCreate(BaseModel):
    """从企业微信消息创建开票请求"""
    wechat_message_id: str = Field(..., min_length=1, max_length=255)
    from_wechat_user_id: str = Field(..., min_length=1, max_length=255)
    from_wechat_username: Optional[str] = Field(None, max_length=255)
    wechat_conversation_id: int
    raw_message_content: str = Field(..., max_length=10000)
    message_type: Literal["text", "image", "voice", "mixed"] = "text"
    attached_image_urls: Optional[List[str]] = None
    voice_transcription: Optional[str] = Field(None, max_length=5000)


class InvoiceRequestOut(BaseModel):
    """开票请求详情"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    customer_id: int

    wechat_message_id: str
    from_wechat_user_id: str
    from_wechat_username: Optional[str]
    message_type: str

    raw_message_content: str
    extracted_data: Optional[Dict[str, Any]]
    extraction_confidence: Optional[Decimal]
    extraction_issues: Optional[List[Dict[str, Any]]]

    matched_customer_header_id: Optional[int]
    merged_invoice_params: Optional[Dict[str, Any]]

    extracted_data_override: Optional[Dict[str, Any]]
    override_reason: Optional[str]
    override_approved_by: Optional[int]
    override_approved_at: Optional[datetime]

    invoice_platform_config_id: Optional[int]
    invoice_record_id: Optional[int]

    status: str
    version: int

    confirmed_by_user_id: Optional[int]
    confirmation_timestamp: Optional[datetime]
    confirmation_notes: Optional[str]
    rejection_reason: Optional[str]
    resubmitted_from_id: Optional[int]

    created_at: datetime
    extraction_completed_at: Optional[datetime]
    confirmation_deadline: Optional[datetime]
    completed_at: Optional[datetime]


class InvoiceConfirmRequest(BaseModel):
    """确认开票请求 — 红蓝修复版

    安全约束：
    - customer_header_id 对应的抬头 verification_status 必须为 "verified"
    - extracted_data_override 若超过阈值，需 override_approved_by 且有权限
    """
    customer_header_id: int
    extracted_data_override: Optional[Dict[str, Any]] = None
    override_reason: Optional[str] = Field(None, max_length=500)
    override_approved_by: Optional[int] = None
    platform_config_id: Optional[int] = None
    notes: Optional[str] = Field(None, max_length=500)

    @field_validator("override_reason")
    @classmethod
    def require_reason_if_override(cls, v: Optional[str], info) -> Optional[str]:
        values = info.data
        if values.get("extracted_data_override") and not v:
            raise ValueError("override_reason is required when extracted_data_override is provided")
        return v


class InvoiceRejectRequest(BaseModel):
    """拒绝开票请求"""
    rejection_reason: str = Field(..., min_length=1, max_length=500)
    suggestions: Optional[str] = Field(None, max_length=500)


class InvoiceRequestListItem(BaseModel):
    """开票请求列表项"""
    model_config = ConfigDict(from_attributes=True)
    id: int
    customer_id: int
    status: str
    extraction_confidence: Optional[Decimal]
    created_at: datetime


class InvoiceRequestListResponse(BaseModel):
    items: List[InvoiceRequestListItem]
    total: int


# ═══════════════════════════════════════════════════════════════
# InvoiceRecord（发票记录）
# ═══════════════════════════════════════════════════════════════

class InvoiceRecordOut(BaseModel):
    """发票记录详情 — INSERT-only"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    invoice_request_id: int

    invoice_number: str
    invoice_type: str
    invoice_date: datetime

    amount: Decimal
    tax_amount: Decimal
    total_amount: Decimal

    pdf_url: Optional[str]
    pdf_hash: Optional[str]
    pdf_page_count: Optional[int]

    platform_request_id: Optional[str]
    platform_response: Optional[Dict[str, Any]]

    status: str
    confirmed_by_user_id: int
    confirmed_at: datetime
    created_at: datetime


# ═══════════════════════════════════════════════════════════════
# CustomerInvoiceHeader（客户抬头）
# ═══════════════════════════════════════════════════════════════

class CustomerHeaderCreate(BaseModel):
    """创建客户抬头"""
    customer_id: int
    company_name: str = Field(..., min_length=1, max_length=255)
    uscc: Optional[str] = Field(None, max_length=18)
    tax_id: str = Field(..., min_length=15, max_length=18)
    registered_address: str = Field(..., max_length=500)
    registered_province: Optional[str] = Field(None, max_length=50)
    registered_city: Optional[str] = Field(None, max_length=50)
    phone_number: Optional[str] = Field(None, max_length=20)
    bank_name: Optional[str] = Field(None, max_length=255)
    bank_account_number: Optional[str] = Field(None, max_length=50)
    is_primary: bool = False


class CustomerHeaderOut(BaseModel):
    """客户抬头详情"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    customer_id: int

    company_name: str
    uscc: Optional[str]
    tax_id: str

    verification_status: str
    verification_source: Optional[str]
    verification_checked_at: Optional[datetime]

    registered_address: str
    registered_province: Optional[str]
    registered_city: Optional[str]
    phone_number: Optional[str]
    bank_name: Optional[str]

    is_primary: bool
    status: str
    effective_from: datetime
    effective_to: Optional[datetime]

    created_at: datetime
    updated_at: datetime


class CustomerHeaderListResponse(BaseModel):
    items: List[CustomerHeaderOut]
    total: int


# ═══════════════════════════════════════════════════════════════
# InvoicePlatformConfig（开票平台配置）
# ═══════════════════════════════════════════════════════════════

class PlatformConfigCreate(BaseModel):
    """创建开票平台配置 — KMS 加密"""
    platform_name: str = Field(..., min_length=1, max_length=50)
    platform_display_name: str = Field(..., min_length=1, max_length=100)
    api_endpoint: str = Field(..., pattern=r"^https://")
    api_version: Optional[str] = "v1"
    # 凭证由前端 KMS 客户端加密后传入
    credentials_encrypted: str
    credentials_kms_key_id: str
    credentials_encryption_context: Dict[str, Any]
    config_params: Optional[Dict[str, Any]] = None
    is_primary: bool = False
    daily_quota: Optional[int] = Field(None, ge=1)


class PlatformConfigOut(BaseModel):
    """开票平台配置详情 — 不返回加密凭证"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    platform_name: str
    platform_display_name: str
    api_endpoint: str
    api_version: Optional[str]
    # 凭证只返回 key_id（用于审计），不返回密文
    credentials_kms_key_id: str
    config_params: Optional[Dict[str, Any]]
    is_enabled: bool
    is_primary: bool
    last_health_check_at: Optional[datetime]
    health_check_status: Optional[str]
    daily_quota: Optional[int]
    daily_used_count: int
    quota_reset_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class PlatformHealthCheckResponse(BaseModel):
    status: str
    message: str
    response_time_ms: int
    last_checked_at: datetime


# ═══════════════════════════════════════════════════════════════
# InvoiceTemplate（开票模板）
# ═══════════════════════════════════════════════════════════════

class InvoiceTemplateCreate(BaseModel):
    """创建开票模板"""
    customer_id: Optional[int] = None
    tax_code: str = Field(..., min_length=1, max_length=50)
    tax_code_name: str = Field(..., min_length=1, max_length=255)
    nickname: str = Field(..., min_length=1, max_length=100)
    synonyms: Optional[List[str]] = None
    default_tax_rate: Decimal = Field(..., ge=0, le=1)
    tax_rate_options: Optional[List[Decimal]] = None
    default_unit: str = Field("项", max_length=20)
    unit_options: Optional[List[str]] = None
    category: Optional[str] = Field(None, max_length=50)
    sub_category: Optional[str] = Field(None, max_length=50)


class InvoiceTemplateOut(BaseModel):
    """开票模板详情"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    customer_id: Optional[int]
    tax_code: str
    tax_code_name: str
    nickname: str
    synonyms: Optional[List[str]]
    default_tax_rate: Decimal
    tax_rate_options: Optional[List[Decimal]]
    default_unit: str
    unit_options: Optional[List[str]]
    category: Optional[str]
    sub_category: Optional[str]
    priority_score: int
    usage_count: int
    last_used_at: Optional[datetime]
    status: str
    created_at: datetime


# ═══════════════════════════════════════════════════════════════
# FinancialWorkstationSession（工位会话）
# ═══════════════════════════════════════════════════════════════

class WorkstationTodoItem(BaseModel):
    """工位待办列表项"""
    id: int
    invoice_request_id: int
    status: str
    priority: int
    customer_name: Optional[str]
    amount: Optional[Decimal]
    extraction_confidence: Optional[Decimal]
    ai_issues: Optional[List[Dict[str, Any]]]
    assigned_at: datetime
    timeout_at: Optional[datetime]


class WorkstationTodoListResponse(BaseModel):
    items: List[WorkstationTodoItem]
    total: int


class WorkstationClaimResponse(BaseModel):
    status: str
    session_id: int
    invoice_request: InvoiceRequestOut


# ═══════════════════════════════════════════════════════════════
# AuditLog（审计日志）
# ═══════════════════════════════════════════════════════════════

class InvoiceAuditLogOut(BaseModel):
    """审计日志详情"""
    model_config = ConfigDict(from_attributes=True)

    id: int
    tenant_id: str
    event_type: str
    actor_id: Optional[int]
    resource_type: str
    resource_id: str
    action: str
    changes: Optional[Dict[str, Any]]
    previous_hash: Optional[str]
    current_hash: str
    minio_status: str
    minio_object_key: Optional[str]
    created_at: datetime
