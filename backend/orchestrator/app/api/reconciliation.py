"""
Kaas v2 · 电商对账 API
──────────────────────
安全设计：
- 所有端点校验 tenant_id（由中间件注入）
- 平台/物流商配置创建需管理员权限
- 对账报告数据租户隔离
"""

from typing import Optional

import structlog
from fastapi import APIRouter, Request, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.core.auth import get_auth_context, AuthContext
from app.core.auth_utils import require_internal, require_tenant_access
from app.schemas.reconciliation import (
    EcommercePlatformConfigCreate,
    EcommercePlatformConfigOut,
    LogisticsProviderConfigCreate,
    LogisticsProviderConfigOut,
    ReconciliationReportCreate,
    ReconciliationReportOut,
    ReconciliationReportListResponse,
    ReconciliationDiffOut,
    ReconciliationDiffListResponse,
    ResolveDiffRequest,
    RunReconciliationRequest,
    RunReconciliationResponse,
    ReconciliationDashboardStats,
)
from app.services.reconciliation_service import ReconciliationService

logger = structlog.get_logger(__name__)
router = APIRouter(prefix="/api/v1/reconciliation", tags=["reconciliation"])


async def get_reconciliation_service(
    db: AsyncSession = Depends(get_db_session),
) -> ReconciliationService:
    return ReconciliationService(db)


# ═══════════════════════════════════════════════════════════════
# Dashboard
# ═══════════════════════════════════════════════════════════════

@router.get("/dashboard", response_model=ReconciliationDashboardStats)
async def get_dashboard(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """对账仪表盘统计。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.get_dashboard_stats(tenant_id)


# ═══════════════════════════════════════════════════════════════
# EcommercePlatformConfig
# ═══════════════════════════════════════════════════════════════

@router.post("/platforms", response_model=EcommercePlatformConfigOut)
async def create_platform_config(
    data: EcommercePlatformConfigCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """创建电商平台配置 — 需管理员权限。"""
    require_internal(auth)
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_platform_config(tenant_id, data, auth)


@router.get("/platforms", response_model=list[EcommercePlatformConfigOut])
async def list_platform_configs(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """列出电商平台配置。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_platform_configs(tenant_id)


# ═══════════════════════════════════════════════════════════════
# LogisticsProviderConfig
# ═══════════════════════════════════════════════════════════════

@router.post("/logistics", response_model=LogisticsProviderConfigOut)
async def create_logistics_config(
    data: LogisticsProviderConfigCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """创建物流商配置 — 需管理员权限。"""
    require_internal(auth)
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_logistics_config(tenant_id, data, auth)


@router.get("/logistics", response_model=list[LogisticsProviderConfigOut])
async def list_logistics_configs(
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """列出物流商配置。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_logistics_configs(tenant_id)


# ═══════════════════════════════════════════════════════════════
# ReconciliationReport
# ═══════════════════════════════════════════════════════════════

@router.post("/reports", response_model=ReconciliationReportOut)
async def create_report(
    data: ReconciliationReportCreate,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """创建对账报告。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.create_report(tenant_id, data, auth)


@router.get("/reports", response_model=ReconciliationReportListResponse)
async def list_reports(
    request: Request,
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """列出对账报告。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_reports(tenant_id, status, page, page_size)


@router.get("/reports/{report_id}", response_model=ReconciliationReportOut)
async def get_report(
    report_id: int,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """获取对账报告详情。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.get_report(tenant_id, report_id)


@router.post("/reports/{report_id}/run", response_model=RunReconciliationResponse)
async def run_reconciliation(
    report_id: int,
    data: RunReconciliationRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """执行对账。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.run_reconciliation(tenant_id, report_id, data, auth)


# ═══════════════════════════════════════════════════════════════
# ReconciliationDiff
# ═══════════════════════════════════════════════════════════════

@router.get("/reports/{report_id}/diffs", response_model=ReconciliationDiffListResponse)
async def list_diffs(
    report_id: int,
    request: Request,
    diff_type: Optional[str] = Query(None),
    resolution_status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """列出差异明细。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.list_diffs(tenant_id, report_id, diff_type, resolution_status, page, page_size)


@router.post("/diffs/{diff_id}/resolve", response_model=ReconciliationDiffOut)
async def resolve_diff(
    diff_id: int,
    data: ResolveDiffRequest,
    request: Request,
    auth: AuthContext = Depends(get_auth_context),
    service: ReconciliationService = Depends(get_reconciliation_service),
):
    """处理差异。"""
    tenant_id = getattr(request.state, "tenant_id", None)
    require_tenant_access(auth, tenant_id)
    if not tenant_id:
        raise HTTPException(status_code=400, detail="tenant_id missing")
    return await service.resolve_diff(tenant_id, diff_id, data, auth)
