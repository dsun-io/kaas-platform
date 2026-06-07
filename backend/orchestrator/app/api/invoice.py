"""
Kaas v2 · 财务工位 — 智能开票 API
───────────────────────────────────
安全设计：
- 所有端点校验 tenant_id（由中间件注入）
- 覆盖审批需 override_approved_by + 权限校验
- 状态机严格校验
"""

from typing import Optional

import structlog
from fastapi import APIRouter, Request, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.core.auth import get_auth_context, AuthContext
from app.core.auth_utils import require_tenant_access, require_internal
from app.schemas.invoice import (
    InvoiceRequestCreate,
    InvoiceRequestOut,
    InvoiceConfirmRequest,
    InvoiceRejectRequest,
    InvoiceRequestListResponse,
    InvoiceRecordOut,
    CustomerHeaderCreate,
    CustomerHeaderOut,
    CustomerHeaderListResponse,
    PlatformConfigCreate,
    PlatformConfigOut,
    PlatformHealthCheckResponse,
    InvoiceTemplateCreate,
    InvoiceTemplateOut,
    WorkstationTodoListResponse,
    WorkstationClaimResponse,
    InvoiceAuditLogOut,
)
from app.services.invoice_service import InvoiceService

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1/invoice", tags=["invoice"])


# ── 依赖注入 ──
async def get_invoice_service(
    db: AsyncSession = Depends(get_db_session),
) -> InvoiceService:
    return InvoiceService(db)


# ═══════════════════════════════════════════════════════════════
# InvoiceRequest（开票请求）
# ═══════════════════════════════════════════════════════════════

@router.post("/requests", response_model=InvoiceRequestOut)
async def create_invoice_request(
    data: InvoiceRequestCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """从企业微信消息创建开票请求。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_request(tenant_id, data, auth)


@router.get("/requests", response_model=InvoiceRequestListResponse)
async def list_invoice_requests(
    request: Request,
    status: Optional[str] = Query(None, description="按状态过滤"),
    customer_id: Optional[int] = Query(None, description="按客户过滤"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """列出开票请求。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_requests(
        tenant_id=tenant_id,
        status=status,
        customer_id=customer_id,
        page=page,
        page_size=page_size,
    )


@router.get("/requests/{request_id}", response_model=InvoiceRequestOut)
async def get_invoice_request(
    request_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """获取开票请求详情。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.get_request(tenant_id, request_id)


@router.post("/requests/{request_id}/confirm", response_model=InvoiceRequestOut)
async def confirm_invoice_request(
    request_id: int,
    data: InvoiceConfirmRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """确认开票请求 — 红蓝修复：
    - 校验 customer_header 的 verification_status
    - 覆盖审批需 override_approved_by + 权限
    - 乐观锁防并发
    """
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.confirm_request(tenant_id, request_id, data, auth)


@router.post("/requests/{request_id}/reject", response_model=InvoiceRequestOut)
async def reject_invoice_request(
    request_id: int,
    data: InvoiceRejectRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """拒绝开票请求。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.reject_request(tenant_id, request_id, data, auth)


# ═══════════════════════════════════════════════════════════════
# CustomerInvoiceHeader（客户抬头）
# ═══════════════════════════════════════════════════════════════

@router.post("/headers", response_model=CustomerHeaderOut)
async def create_customer_header(
    data: CustomerHeaderCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """创建客户发票抬头。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_header(tenant_id, data, auth)


@router.get("/headers", response_model=CustomerHeaderListResponse)
async def list_customer_headers(
    request: Request,
    customer_id: Optional[int] = Query(None),
    status: Optional[str] = Query("active"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """列出客户发票抬头。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_headers(
        tenant_id=tenant_id,
        customer_id=customer_id,
        status=status,
        page=page,
        page_size=page_size,
    )


@router.get("/headers/{header_id}", response_model=CustomerHeaderOut)
async def get_customer_header(
    header_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """获取客户抬头详情。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.get_header(tenant_id, header_id)


@router.post("/headers/{header_id}/verify")
async def verify_customer_header(
    header_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """触发税务校验（异步）。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.verify_header(tenant_id, header_id, auth)


# ═══════════════════════════════════════════════════════════════
# InvoicePlatformConfig（开票平台配置）
# ═══════════════════════════════════════════════════════════════

@router.post("/platforms", response_model=PlatformConfigOut)
async def create_platform_config(
    data: PlatformConfigCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """创建开票平台配置 — 需管理员权限。"""
    require_internal(auth)
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_platform_config(tenant_id, data, auth)


@router.get("/platforms", response_model=list[PlatformConfigOut])
async def list_platform_configs(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """列出开票平台配置。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_platform_configs(tenant_id)


@router.post("/platforms/{config_id}/health-check", response_model=PlatformHealthCheckResponse)
async def health_check_platform(
    config_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """触发平台健康检查。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.health_check_platform(tenant_id, config_id)


# ═══════════════════════════════════════════════════════════════
# InvoiceTemplate（开票模板）
# ═══════════════════════════════════════════════════════════════

@router.post("/templates", response_model=InvoiceTemplateOut)
async def create_invoice_template(
    data: InvoiceTemplateCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """创建开票模板。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_template(tenant_id, data, auth)


@router.get("/templates", response_model=list[InvoiceTemplateOut])
async def list_invoice_templates(
    request: Request,
    category: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="搜索关键词"),
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """列出开票模板，支持搜索。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_templates(tenant_id, category=category, q=q)


# ═══════════════════════════════════════════════════════════════
# FinancialWorkstationSession（工位会话）
# ═══════════════════════════════════════════════════════════════

@router.get("/workstation/todo", response_model=WorkstationTodoListResponse)
async def get_workstation_todo(
    request: Request,
    status: Optional[str] = Query("pending"),
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """获取工位待办列表。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.get_todo_list(tenant_id, status, auth)


@router.post("/workstation/claim/{invoice_request_id}", response_model=WorkstationClaimResponse)
async def claim_workstation(
    invoice_request_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """原子抢占工位。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.claim_workstation(tenant_id, invoice_request_id, auth)


# ═══════════════════════════════════════════════════════════════
# AuditLog（审计日志）
# ═══════════════════════════════════════════════════════════════

@router.get("/audit-logs", response_model=list[InvoiceAuditLogOut])
async def list_audit_logs(
    request: Request,
    resource_type: Optional[str] = Query(None),
    resource_id: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    service: InvoiceService = Depends(get_invoice_service),
):
    """查询审计日志 — 需管理员权限。"""
    require_internal(auth)
    tenant_id = getattr(request.state, "tenant_id", None)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_audit_logs(
        tenant_id, resource_type=resource_type, resource_id=resource_id,
        page=page, page_size=page_size,
    )
