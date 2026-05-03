"""
Kaas v2 · OSS Presign API 路由 (§3.7.12)
POST /api/v1/oss-presign — MinIO 预签名上传 URL
"""
from datetime import timedelta
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from minio import Minio
from app.config.settings import settings


router = APIRouter(prefix="/api/v1", tags=["oss"])


def _get_minio_client() -> Minio:
    return Minio(
        endpoint=settings.minio_endpoint,
        access_key=settings.minio_access_key,
        secret_key=settings.minio_secret_key,
        secure=settings.minio_secure,
    )


@router.post("/oss-presign")
async def create_presigned_url(request: Request):
    """
    生成 MinIO 预签名上传 URL。
    租户隔离: object_name 前缀为 {tenant_id}/。
    """
    body = await request.json()
    object_name = body.get("object_name")
    if not object_name:
        return JSONResponse(
            status_code=400,
            content={"error": "missing_object_name", "message": "object_name is required"},
        )

    tenant_id = request.state.tenant_id
    tenant_prefix = f"{tenant_id}/{object_name}"

    try:
        client = _get_minio_client()
        bucket = settings.minio_bucket

        found = client.bucket_exists(bucket)
        if not found:
            client.make_bucket(bucket)

        url = client.presigned_put_object(
            bucket_name=bucket,
            object_name=tenant_prefix,
            expires=timedelta(minutes=15),
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"error": "minio_error", "message": str(e)},
        )

    return JSONResponse(
        status_code=200,
        content={
            "presigned_url": url,
            "bucket": bucket,
            "object_name": tenant_prefix,
            "expires_in": 900,
        },
    )
