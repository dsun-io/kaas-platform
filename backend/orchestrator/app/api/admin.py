"""
Kaas v2 · Admin API 路由 (§3.7.18)
管理端点: 租户 CRUD / 缓存热重载 / feature flag / 部署审计
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.domain.tenant_config import get_all_tenants, load_tenant_config, reload_all_tenants
from app.repositories.admin import get_archive_logs
from app.api.deps import verify_admin_token
from app.schemas.admin import (
    TenantListResponse,
    TenantDetailResponse,
    TenantReloadResponse,
    FeatureFlagResponse,
    FeatureFlagSetResponse,
    CacheClearResponse,
    MetricsSummaryResponse,
    AuditLogResponse,
    ArchiveLogResponse,
)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

AUDIT_LOG_PATH = Path(__file__).resolve().parent.parent.parent / "logs" / "deployment_audit.jsonl"
VALID_AUDIT_ACTIONS = frozenset(
    {"feature_flag_change", "rollback", "tenants_reload", "manual_override"}
)


def _append_audit(action: str, tenant_id: str, detail: dict) -> None:
    """追加 deployment_audit.jsonl 记录。"""
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "tenant_id": tenant_id,
        **detail,
    }
    with open(AUDIT_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


# ─── Tenant listing (no auth required) ───


@router.get("/tenants", response_model=TenantListResponse)
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


@router.get("/tenants/{tenant_id}", response_model=TenantDetailResponse)
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


# ─── Auth-required endpoints (§3.7.18) ───


@router.post("/tenants/reload", response_model=TenantReloadResponse)
async def reload_tenants(
    request: Request,
    _token: str = Depends(verify_admin_token),
):
    """热重载租户缓存（需 admin token）。"""
    reload_all_tenants()
    tenants = get_all_tenants()
    _append_audit("tenants_reload", "*", {"tenant_count": len(tenants)})
    return JSONResponse(
        status_code=200,
        content={
            "message": "Tenant cache reloaded",
            "tenant_count": len(tenants),
        },
    )


@router.post("/feature_flag", response_model=FeatureFlagSetResponse)
async def set_feature_flag(
    request: Request,
    _token: str = Depends(verify_admin_token),
):
    """设置租户 feature flag（写 tenants.yaml + 审计）。"""
    body = await request.json()
    tenant_id = body.get("tenant_id")
    flag_name = body.get("flag_name")
    flag_value = body.get("flag_value")

    if not tenant_id or not flag_name:
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_request",
                "message": "tenant_id and flag_name are required",
            },
        )

    # 读现有配置
    from app.domain.tenant_config import _TENANTS_FILE
    import yaml

    with open(_TENANTS_FILE, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    tenants = config.get("tenants", {})
    if tenant_id not in tenants:
        return JSONResponse(
            status_code=404,
            content={
                "error": "tenant_not_found",
                "message": f"Tenant '{tenant_id}' not found",
            },
        )

    # 更新 feature_flag
    tenant = tenants[tenant_id]
    if "feature_flags" not in tenant:
        tenant["feature_flags"] = {}
    old_value = tenant["feature_flags"].get(flag_name)
    tenant["feature_flags"][flag_name] = flag_value

    # 写回 YAML
    with open(_TENANTS_FILE, "w", encoding="utf-8") as f:
        yaml.safe_dump(config, f, allow_unicode=True, default_flow_style=False)

    # 清除缓存 + 审计
    reload_all_tenants()
    _append_audit(
        "feature_flag_change",
        tenant_id,
        {"flag_name": flag_name, "old_value": old_value, "new_value": flag_value},
    )

    return JSONResponse(
        status_code=200,
        content={
            "tenant_id": tenant_id,
            "flag_name": flag_name,
            "old_value": old_value,
            "new_value": flag_value,
        },
    )


@router.get("/feature_flag", response_model=FeatureFlagResponse)
async def get_feature_flag(
    request: Request,
    tenant_id: str | None = None,
):
    """读取租户当前 feature flags。

    如果未提供 tenant_id，默认使用请求上下文的 tenant_id。
    """
    tid = tenant_id or getattr(request.state, "tenant_id", None)
    if not tid:
        return JSONResponse(
            status_code=400,
            content={
                "error_code": "TENANT_REQUIRED",
                "message": "tenant_id query param or X-Tenant-Id header is required",
            },
        )
    tenant = load_tenant_config(tid)
    if tenant is None:
        return JSONResponse(
            status_code=404,
            content={"error": "tenant_not_found", "message": f"Tenant '{tid}' not found"},
        )
    return JSONResponse(
        status_code=200,
        content={
            "tenant_id": tid,
            "feature_flags": tenant.get("feature_flags", {}),
        },
    )


@router.get("/deployment_audit", response_model=AuditLogResponse)
async def get_deployment_audit(
    request: Request,
    since: str = None,
    limit: int = 200,
):
    """查询部署审计日志（tail jsonl）。"""
    if not AUDIT_LOG_PATH.exists():
        return JSONResponse(
            status_code=200,
            content={"items": [], "total": 0},
        )

    records = []
    with open(AUDIT_LOG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
                if record.get("action") not in VALID_AUDIT_ACTIONS:
                    continue
                if since and record.get("timestamp", "") < since:
                    continue
                records.append(record)
            except json.JSONDecodeError:
                continue

    # 取最近 limit 条
    records = records[-limit:]

    # 前端期望 {items, total} 格式
    items = [
        {
            "id": r.get("timestamp", ""),
            "action": r.get("action", ""),
            "actor_id": r.get("actor_id", ""),
            "resource_type": r.get("resource_type", ""),
            "resource_id": r.get("resource_id", ""),
            "reason": r.get("reason", ""),
            "timestamp": r.get("timestamp", ""),
        }
        for r in records
    ]
    return JSONResponse(
        status_code=200,
        content={"items": items, "total": len(items)},
    )


@router.get("/archive-logs", response_model=ArchiveLogResponse)
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


# ─── Metrics summary (§9.2) ───


@router.get("/metrics/summary", response_model=MetricsSummaryResponse)
async def metrics_summary():
    """管理员仪表盘 — 报价统计聚合。"""
    from app.core.metrics import ACTIVE_SESSIONS, QUOTE_REQUESTS, LLM_FALLBACK_TOTAL
    from app.domain.session_store import session_store

    return JSONResponse(
        status_code=200,
        content={
            "active_sessions": len(session_store),
        },
    )


# ─── Cache control (§9.2) ───


@router.post("/cache/clear", response_model=CacheClearResponse)
async def clear_cache(
    _token: str = Depends(verify_admin_token),
):
    """清空 session_store（需 admin token）。"""
    from app.domain.session_store import session_store
    count = session_store.clear()
    return JSONResponse(
        status_code=200,
        content={"cleared_sessions": count},
    )
