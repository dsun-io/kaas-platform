"""公司公章 API（租户级）—— 单证签章区盖章用（单证工位独立化 P1）

为什么单独一套
------------
单证（PI/CI/PL/CO）签章区要盖公司公章。公章是**图片资产**而非文本配置
（company_profile 只有 logo_url 外链），需要上传、格式转换、落库、按租户隔离。

铁律
----
- **后端零图像库**（2026-09-30 设计裁决）：格式转换/白底透明/裁边全部在
  **前端 Canvas** 完成，后端只收 PNG 字节 + 校验 + 落库（内核 png.py 纯 Python
  解析）。于是 orchestrator 与 Worker 行为完全一致，无 Pillow/Pillow 替代品。
- **权限**：仅 internal/admin 可管理；取图接口先校验 tenant_id 再回字节，
  防止 ID 枚举越权看别家公章（客户账号一律 403/404）。
- **默认章唯一**：部分唯一索引兜底，API 层切换时事务内先清后设。

端点：
- POST   /api/v1/tenant/company-seals            上传（multipart；PNG）
- GET    /api/v1/tenant/company-seals            列表（元数据 + preview_url，不回裸字节）
- GET    /api/v1/tenant/company-seals/{id}/image 取 PNG（校验 tenant 后回字节）
- PUT    /api/v1/tenant/company-seals/{id}/default 设为默认章
- DELETE /api/v1/tenant/company-seals/{id}       删除（默认章需先转移）
"""
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.workstation_models import TenantCompanySeal
from app.core.auth import AuthContext, get_auth_context
from app.api.ws_common import tenant_id_of
from kaas_common.trade_doc import PngError, validate_seal_image
from app.api.company_profile import require_team_admin

router = APIRouter(prefix="/api/v1", tags=["company-seals"])

MAX_UPLOAD_BYTES = 5 * 1024 * 1024      # 5MB 足够印章图
ALLOWED_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/bmp", "image/x-ms-bmp"}


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _require_internal(auth: AuthContext) -> None:
    """公章是公司资产，只有内部账号可管；客户账号一律拒绝。"""
    if not (auth.is_internal() or auth.is_admin()):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "INTERNAL_ONLY",
            "detail": "公章管理仅限内部账号",
        })


def _validate_png(data: bytes) -> tuple[int, int]:
    """公章图校验（内核纯 Python）：非空、≤5MB、PNG 魔数 + IHDR 尺寸。

    格式转换（jpg/webp→PNG、白底透明、裁边）由**前端 Canvas** 完成，
    后端不再做图像处理（去 Pillow，Worker 同源行为）。
    """
    try:
        return validate_seal_image(data)
    except PngError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail,
        })


def _to_meta(row: TenantCompanySeal) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "mime": row.mime,
        "width": row.width,
        "height": row.height,
        "is_default": row.is_default,
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "preview_url": f"/api/v1/tenant/company-seals/{row.id}/image",
    }


async def _get_or_404(db: AsyncSession, tenant_id: str, seal_id: int) -> TenantCompanySeal:
    """取章并强制租户过滤 —— 越权防线：别家的章一律 404（不泄露存在性）。"""
    row = (await db.execute(
        select(TenantCompanySeal).where(
            TenantCompanySeal.tenant_id == tenant_id,
            TenantCompanySeal.id == seal_id,
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SEAL_NOT_FOUND",
        })
    return row


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SealMetaOut(BaseModel):
    id: int
    name: str
    mime: str
    width: Optional[int] = None
    height: Optional[int] = None
    is_default: bool
    preview_url: str


# ─── 端点 ─────────────────────────────────────────────────────────────────────

@router.post("/tenant/company-seals", status_code=201)
async def upload_seal(
    file: UploadFile = File(...),
    name: str = Form(...),
    set_default: bool = Form(False),
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """上传公章：任意常见格式 → 统一转 PNG（白底透明 + 裁白边）落库。"""
    # 用户 2026-10-18：公章归企业抬头设置区，只有团队管理员可改。
    await require_team_admin(db, auth)
    tenant_id = tenant_id_of(auth)

    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "NAME_REQUIRED",
            "detail": "请给章起个名字（如：公章 / 财务章）",
        })

    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "EMPTY_FILE",
            "detail": "上传内容为空",
        })
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail={
            "error": "validation", "code": "FILE_TOO_LARGE",
            "detail": "图片不能超过 5MB",
        })
    if file.content_type and file.content_type not in ALLOWED_MIME:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "BAD_IMAGE",
            "detail": "仅支持 PNG / JPG / WebP / BMP（非 PNG 请用上传框的自动转换）",
        })

    # 前端 Canvas 已归一化为 PNG（含透明底/裁边）；后端纯校验不处理图像
    png_bytes = data
    width, height = _validate_png(data)

    # 同名唯一（uq 约束兜底）：提示用户改名或删除旧章
    exists = (await db.execute(
        select(TenantCompanySeal.id).where(
            TenantCompanySeal.tenant_id == tenant_id,
            TenantCompanySeal.name == name,
        )
    )).scalar_one_or_none()
    if exists is not None:
        raise HTTPException(status_code=409, detail={
            "error": "conflict", "code": "SEAL_NAME_TAKEN",
            "detail": f"已存在同名章「{name}」，请改名或先删除",
        })

    row = TenantCompanySeal(
        tenant_id=tenant_id,
        name=name,
        mime="image/png",
        png_bytes=png_bytes,
        width=width,
        height=height,
        is_default=False,
        created_by=str(auth.user_id),
    )
    db.add(row)
    await db.flush()

    # 首枚章自动成为默认；显式 set_default 时事务内先清后设（保证唯一）
    if set_default:
        await db.execute(
            update(TenantCompanySeal)
            .where(TenantCompanySeal.tenant_id == tenant_id)
            .values(is_default=False)
        )
        row.is_default = True
    else:
        any_default = (await db.execute(
            select(TenantCompanySeal.id).where(
                TenantCompanySeal.tenant_id == tenant_id,
                TenantCompanySeal.is_default.is_(True),
            )
        )).scalar_one_or_none()
        if any_default is None:
            row.is_default = True

    await db.commit()
    await db.refresh(row)
    return _to_meta(row)


@router.get("/tenant/company-seals")
async def list_seals(
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """列表只回元数据 + 预览 URL，不回裸字节（取图走专用端点，便于缓存与鉴权）。"""
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(
        select(TenantCompanySeal)
        .where(TenantCompanySeal.tenant_id == tenant_id)
        .order_by(TenantCompanySeal.is_default.desc(), TenantCompanySeal.id)
    )).scalars().all()
    return {"items": [_to_meta(r) for r in rows]}


@router.get("/tenant/company-seals/{seal_id}/image")
async def get_seal_image(
    seal_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """回 PNG 字节。tenant 校验在 _get_or_404 内 —— 越权看图=404。"""
    tenant_id = tenant_id_of(auth)
    row = await _get_or_404(db, tenant_id, seal_id)
    return Response(
        content=row.png_bytes,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": f'inline; filename="seal-{seal_id}.png"',
        },
    )


class SealDefaultIn(BaseModel):
    pass


@router.put("/tenant/company-seals/{seal_id}/default")
async def set_default_seal(
    seal_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """设为默认章（单证渲染时自动盖默认章）。事务内先清后设，保证唯一。"""
    await require_team_admin(db, auth)
    tenant_id = tenant_id_of(auth)
    row = await _get_or_404(db, tenant_id, seal_id)

    await db.execute(
        update(TenantCompanySeal)
        .where(TenantCompanySeal.tenant_id == tenant_id)
        .values(is_default=False)
    )
    row.is_default = True
    await db.commit()
    await db.refresh(row)
    return _to_meta(row)


@router.delete("/tenant/company-seals/{seal_id}")
async def delete_seal(
    seal_id: int,
    auth: AuthContext = Depends(get_auth_context),
    db: AsyncSession = Depends(get_db_session),
):
    """删除公章。默认章不允许直接删（先转移默认，避免单证突然没章可盖）。"""
    await require_team_admin(db, auth)
    tenant_id = tenant_id_of(auth)
    row = await _get_or_404(db, tenant_id, seal_id)

    if row.is_default:
        others = (await db.execute(
            select(TenantCompanySeal.id).where(
                TenantCompanySeal.tenant_id == tenant_id,
                TenantCompanySeal.id != seal_id,
            )
        )).scalars().all()
        if others:
            raise HTTPException(status_code=409, detail={
                "error": "conflict", "code": "DEFAULT_SEAL",
                "detail": "这是默认章，请先把其他章设为默认再删除",
            })

    await db.delete(row)
    await db.commit()
    return {"deleted": True, "id": seal_id}
