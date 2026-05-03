"""
Kaas v2 · OSS Presign API 路由 (§3.7.9)
POST /api/v1/oss/presign — 生成预签名上传 URL
"""
import uuid
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from minio import Minio
from app.config.settings import settings

router = APIRouter(prefix="/api/v1/oss", tags=["oss"])

VALID_PURPOSES = frozenset({"event_payload", "kb_attachment", "audit_attachment"})
MAX_SIZE_BYTES = 10 * 1024 * 1024  # 10MB
PRESIGN_EXPIRES = 600  # 10 minutes


def _get_minio_client() -> Minio:
    return Minio(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
    )


@router.post("/presign")
async def create_presigned_url(request: Request):
    """生成 OSS 预签名上传 URL (§3.7.9)。"""
    body = await request.json()

    purpose = body.get("purpose", "event_payload")
    if purpose not in VALID_PURPOSES:
        return JSONResponse(
            status_code=400,
            content={
                "error": "invalid_purpose",
                "message": f"purpose must be one of {sorted(VALID_PURPOSES)}",
            },
        )

    size_bytes = body.get("size_bytes", 0)
    if size_bytes > MAX_SIZE_BYTES:
        return JSONResponse(
            status_code=400,
            content={
                "error": "size_too_large",
                "message": f"size_bytes {size_bytes} exceeds {MAX_SIZE_BYTES // 1024 // 1024}MB limit",
            },
        )

    content_type = body.get("content_type", "application/octet-stream")
    event_type = body.get("event_type", "unknown")

    # OSS key 格式: events-archive/{yyyy}/{mm}/{dd}/{event_type}/{uuid}.json
    now = datetime.now(timezone.utc)
    oss_key = (
        f"events-archive/{now.year:04d}/{now.month:02d}/{now.day:02d}/"
        f"{event_type}/{uuid.uuid4().hex}.json"
    )

    try:
        client = _get_minio_client()
        bucket = settings.minio_bucket

        found = client.bucket_exists(bucket)
        if not found:
            client.make_bucket(bucket)

        url = client.presigned_put_object(
            bucket_name=bucket,
            object_name=oss_key,
            expires=timedelta(seconds=PRESIGN_EXPIRES),
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": "minio_error", "message": str(e)},
        )

    return JSONResponse(
        status_code=200,
        content={
            "oss_key": oss_key,
            "presigned_url": url,
            "expires_in": PRESIGN_EXPIRES,
            "method": "PUT",
            "content_type": content_type,
        },
    )
