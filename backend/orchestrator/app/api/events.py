"""
Kaas v2 · Events API 路由 (§3.7.12)
POST /api/v1/events — 写入原始事件
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.session import get_db_session
from app.domain.schema_registry import PAYLOAD_SCHEMAS
from app.repositories.events import insert_event

router = APIRouter(prefix="/api/v1", tags=["events"])


@router.post("/events")
async def create_event(request: Request, db: AsyncSession = Depends(get_db_session)):
    """
    写入原始事件 (INSERT-only · 铁律5)。
    event_type 必须是 schema_registry.py 的 6 个之一。
    tenant_id 从中间件注入的 request.state 读取，严禁从 payload 读。
    """
    body = await request.json()

    event_type = body.get("event_type")
    if not event_type or event_type not in PAYLOAD_SCHEMAS:
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_event_type",
                "message": f"event_type must be one of {sorted(PAYLOAD_SCHEMAS.keys())}",
            },
        )

    schema_version = body.get("schema_version", "1.0")
    payload = body.get("payload", {})
    source = body.get("source", "api")

    event = await insert_event(
        session=db,
        tenant_id=request.state.tenant_id,
        trace_id=request.state.trace_id,
        route_version=request.state.route_version,
        event_type=event_type,
        schema_version=schema_version,
        payload=payload,
        sampled=request.state.sampled,
        source=source,
    )

    return JSONResponse(
        status_code=201,
        content={
            "id": str(event.id),
            "event_type": event.event_type,
            "tenant_id": event.tenant_id,
            "trace_id": event.trace_id,
            "created_at": event.created_at.isoformat(),
        },
    )
