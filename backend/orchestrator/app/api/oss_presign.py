"""
Kaas v2 · OSS Presign API 路由 (§3.7.9)
POST /api/v1/oss/presign — 生成预签名上传 URL

鉴权:
- customer/free: 必须 auth，key 自动绑定 tenant
- internal: 必须 auth + body 显式 tenant_id
"""
import uuid
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Request, HTTPException
from minio import Minio
from app.config.settings import settings
from app.core.auth import AuthContext

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
    """生成 OSS 预签名上传 URL (§3.7.9)。

    AUTH:
    - internal: body 必须传 tenant_id，key 使用指定租户
    - customer/free: 自动使用自己的 tenant_id，拒绝跨租户
    """
    # ── 鉴权 ──
    auth: AuthContext | None = getattr(request.state, "auth", None)
    if auth is None:
        raise HTTPException(
            status_code=401,
            detail={"error": "unauthorized", "message": "Authentication required"},
        )

    body = await request.json()

    # ── 确定 tenant_id ──
    if auth.is_internal():
        tenant_id = body.get("tenant_id")
        if not tenant_id:
            raise HTTPException(status_code=400, detail="missing_tenant: tenant_id is required in body for internal access")
    else:
        tenant_id = auth.tenant_id
        if not tenant_id:
            raise HTTPException(status_code=403, detail="forbidden: Customer account has no tenant binding")

    purpose = body.get("purpose", "event_payload")
    if purpose not in VALID_PURPOSES:
        raise HTTPException(status_code=400, detail=f"invalid_purpose: purpose must be one of {sorted(VALID_PURPOSES)}")

    size_bytes = body.get("size_bytes", 0)
    if size_bytes > MAX_SIZE_BYTES:
        raise HTTPException(status_code=400, detail=f"size_too_large: size_bytes {size_bytes} exceeds {MAX_SIZE_BYTES // 1024 // 1024}MB limit")

    content_type = body.get("content_type", "application/octet-stream")
    event_type = body.get("event_type", "unknown")

    # OSS key 格式: events-archive/{tenant_id}/{yyyy}/{mm}/{dd}/{event_type}/{uuid}.json
    now = datetime.now(timezone.utc)
    oss_key = (
        f"events-archive/{tenant_id}/{now.year:04d}/{now.month:02d}/{now.day:02d}/"
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
        raise HTTPException(status_code=500, detail=f"minio_error: {e}")

    return {
        "oss_key": oss_key,
        "presigned_url": url,
        "expires_in": PRESIGN_EXPIRES,
        "method": "PUT",
        "content_type": content_type,
    }
