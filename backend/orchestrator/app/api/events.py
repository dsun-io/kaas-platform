"""
Kaas v2 · Events API 路由 (§3.7.8)
POST /api/v1/events — 写入原始事件 (INSERT-only · 铁律5)
"""
import json
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.api.schema_registry import (
    PAYLOAD_SCHEMAS,
    VALID_EVENT_TYPES,
    VALID_EVENT_SOURCES,
    MAX_PAYLOAD_BYTES,
)
from app.repositories.events import insert_event
from app.schemas.events import EventResponse
from app.core.auth import AuthContext

router = APIRouter(prefix="/api/v1", tags=["events"])

# ─── 6 错误码白名单 (§3.7.8) ───
ERROR_TENANT_ID_MISSING = "tenant_id_missing"
ERROR_SCHEMA_VERSION_REQUIRED = "schema_version_required"
ERROR_EVENT_TYPE_UNKNOWN = "event_type_unknown"
ERROR_SCHEMA_VERSION_UNSUPPORTED = "schema_version_unsupported"
ERROR_PAYLOAD_SCHEMA_MISMATCH = "payload_schema_mismatch"
ERROR_PAYLOAD_TOO_LARGE = "payload_too_large"


@router.get("/events")
async def list_events_endpoint(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    event_type: str | None = None,
    schema_version: int | None = None,
    actor_id: str | None = None,
    event_source: str | None = None,
    sampled: bool | None = None,
    limit: int = 100,
    offset: int = 0,
):
    """查询事件列表，支持过滤和分页。"""
    auth = getattr(request.state, "auth", None)
    if auth and auth.is_customer():
        tenant_id: str | None = auth.tenant_id
    else:
        tenant_id: str | None = getattr(request.state, "tenant_id", None)
    from app.repositories.events import list_events as repo_list_events

    events, total = await repo_list_events(
        session=db,
        tenant_id=tenant_id,
        event_type=event_type,
        schema_version=schema_version,
        actor_id=actor_id,
        event_source=event_source,
        sampled=sampled,
        limit=min(limit, 500),
        offset=offset,
    )

    return JSONResponse(
        status_code=200,
        content={
            "items": [
                {
                    "id": str(e.id),
                    "event_type": e.event_type,
                    "schema_version": e.schema_version,
                    "tenant_id": e.tenant_id,
                    "actor_id": e.actor_id,
                    "session_id": e.session_id,
                    "trace_id": e.trace_id,
                    "event_source": e.event_source,
                    "payload": e.payload,
                    "sampled": e.sampled,
                    "created_at": e.created_at.isoformat(),
                }
                for e in events
            ],
            "total": total,
            "page": (offset // max(limit, 1)) + 1 if limit > 0 else 1,
            "page_size": limit,
        },
    )


@router.post("/events", response_model=EventResponse)
async def create_event(request: Request, db: AsyncSession = Depends(get_db_session)):
    """写入原始事件。tenant_id 从 AuthContext 取，严禁从 body 读。"""

    # 1. tenant_id — customer 以 auth 为准，internal 从中间件注入
    auth = getattr(request.state, "auth", None)
    if auth and auth.is_customer():
        tenant_id: str | None = auth.tenant_id
    else:
        tenant_id: str | None = getattr(request.state, "tenant_id", None)

    if not tenant_id:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_TENANT_ID_MISSING,
                "message": "tenant_id is required; ensure X-Tenant-Id header is set",
            },
        )

    body = await request.json()

    # customer/free: 拒绝 body 中携带的不匹配 tenant_id
    from app.core.auth_utils import require_tenant_match
    if auth:
        require_tenant_match(auth, body.get("tenant_id"))

    # 2. event_type 校验
    event_type = body.get("event_type")
    if not event_type:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_EVENT_TYPE_UNKNOWN,
                "message": f"event_type is required, must be one of {sorted(VALID_EVENT_TYPES)}",
            },
        )
    if event_type not in VALID_EVENT_TYPES:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_EVENT_TYPE_UNKNOWN,
                "message": f"Unknown event_type '{event_type}', must be one of {sorted(VALID_EVENT_TYPES)}",
            },
        )

    # 3. schema_version 校验
    schema_version = body.get("schema_version")
    if schema_version is None:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_SCHEMA_VERSION_REQUIRED,
                "message": "schema_version is required",
            },
        )

    schemas_for_type = PAYLOAD_SCHEMAS.get(event_type, {})
    if schema_version not in schemas_for_type:
        valid_versions = sorted(schemas_for_type.keys())
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_SCHEMA_VERSION_UNSUPPORTED,
                "message": (
                    f"schema_version {schema_version} not supported for '{event_type}', "
                    f"must be one of {valid_versions}"
                ),
            },
        )

    # 4. payload 校验（字段集必须匹配注册表）
    payload = body.get("payload", {})
    expected_schema = schemas_for_type[schema_version]
    try:
        validated = expected_schema(**payload)
        payload_dict = validated.model_dump()
    except Exception as e:
        missing = [err["loc"][0] for err in e.errors()] if hasattr(e, "errors") else []
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_PAYLOAD_SCHEMA_MISMATCH,
                "message": f"Payload schema mismatch for '{event_type}' v{schema_version}",
                "missing_fields": missing,
                "detail": str(e),
            },
        )

    # 5. payload 大小限制（> 10KB 走 OSS presign）
    payload_json = json.dumps(payload_dict, ensure_ascii=False)
    if len(payload_json.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_PAYLOAD_TOO_LARGE,
                "message": (
                    f"Payload size exceeds {MAX_PAYLOAD_BYTES // 1024}KB limit, "
                    "use POST /api/v1/oss/presign for large payloads"
                ),
            },
        )

    # 6. event_source 校验
    event_source = body.get("event_source", "orchestrator")
    if event_source not in VALID_EVENT_SOURCES:
        return JSONResponse(
            status_code=400,
            content={
                "error": ERROR_EVENT_TYPE_UNKNOWN,
                "message": f"Invalid event_source '{event_source}', must be one of {sorted(VALID_EVENT_SOURCES)}",
            },
        )

    # 7. 隐式注入
    trace_id = body.get("trace_id") or getattr(request.state, "trace_id", None)
    sampled: bool = getattr(request.state, "sampled", True)

    event = await insert_event(
        session=db,
        tenant_id=tenant_id,
        trace_id=trace_id,
        event_type=event_type,
        schema_version=schema_version,
        event_source=event_source,
        payload=payload_dict,
        sampled=sampled,
        actor_id=body.get("actor_id"),
        session_id=body.get("session_id"),
    )

    return JSONResponse(
        status_code=201,
        content={
            "id": event.id,
            "event_type": event.event_type,
            "tenant_id": event.tenant_id,
            "trace_id": event.trace_id,
            "schema_version": event.schema_version,
            "created_at": event.created_at.isoformat(),
        },
    )
