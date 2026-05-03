"""
Kaas v2 · Admin API 路由 (§3.7.12)
管理端点: 租户 CRUD / 缓存热重载 / 归档日志查询
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.domain.tenant_config import get_all_tenants, load_tenant_config, reload_all_tenants
from app.repositories.admin import get_archive_logs


router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


@router.get("/tenants")
async def list_tenants(request: Request):
    """列出所有启用租户。"""
    tenants = get_all_tenants()
    return JSONResponse(
        status_code=200,
        content={
            "tenants": [
                {
                    "tenant_id": tid,
                    "display_name": t.get("display_name"),
                    "enabled": t.get("enabled", True),
                }
                for tid, t in tenants.items()
            ]
        },
    )


@router.get("/tenants/{tenant_id}")
async def get_tenant(request: Request, tenant_id: str):
    """获取指定租户配置。"""
    tenant = load_tenant_config(tenant_id)
    if tenant is None:
        return JSONResponse(
            status_code=404,
            content={"error": "tenant_not_found", "message": f"Tenant '{tenant_id}' not found"},
        )
    return JSONResponse(
        status_code=200,
        content={"tenant_id": tenant_id, "config": tenant},
    )


@router.post("/tenants/reload")
async def reload_tenants(request: Request):
    """热重载租户缓存。"""
    reload_all_tenants()
    tenants = get_all_tenants()
    return JSONResponse(
        status_code=200,
        content={
            "message": "Tenant cache reloaded",
            "tenant_count": len(tenants),
        },
    )


@router.get("/archive-logs")
async def list_archive_logs(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    tenant_id: str = None,
):
    """查询归档日志记录。"""
    logs = await get_archive_logs(session=db, tenant_id=tenant_id)
    return JSONResponse(
        status_code=200,
        content={
            "logs": [
                {
                    "id": str(log.id),
                    "tenant_id": log.tenant_id,
                    "month": log.month,
                    "minio_path": log.minio_path,
                    "status": log.status,
                    "archived_at": log.archived_at.isoformat(),
                }
                for log in logs
            ]
        },
    )
