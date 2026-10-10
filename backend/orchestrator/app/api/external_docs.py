"""外部单证上传 API：上传/列表/下载/状态流转（与系统生成单证同状态机）。
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db_session
from app.db.external_docs import ExternalDocUpload
from app.core.auth import AuthContext, get_auth_context

router = APIRouter(prefix="/api/v1", tags=["external-docs"])

MAX_FILE_SIZE = 20 * 1024 * 1024  # 20MB，单证多为 PDF/扫描件


class ExternalDocOut(BaseModel):
    id: int
    doc_type: Optional[str]
    file_name: str
    content_type: Optional[str]
    file_size: Optional[float]
    order_id: Optional[int]
    quote_order_id: Optional[int]
    inquiry_id: Optional[int]
    customer_id: Optional[str]
    status: str
    notes: Optional[str]
    uploaded_by: Optional[str]
    created_at: Optional[str]


class ExternalDocStatusIn(BaseModel):
    status: str
    notes: Optional[str] = None


def _row_to_out(r: ExternalDocUpload) -> ExternalDocOut:
    return ExternalDocOut(
        id=r.id, doc_type=r.doc_type, file_name=r.file_name,
        content_type=r.content_type,
        file_size=float(r.file_size) if r.file_size is not None else None,
        order_id=r.order_id, quote_order_id=r.quote_order_id,
        inquiry_id=r.inquiry_id, customer_id=r.customer_id,
        status=r.status, notes=r.notes, uploaded_by=r.uploaded_by,
        created_at=r.created_at.isoformat() if r.created_at else None,
    )


@router.post("/external-docs", status_code=201)
async def upload_external_doc(
    file: UploadFile = File(...),
    doc_type: Optional[str] = Form(None),
    order_id: Optional[int] = Form(None),
    quote_order_id: Optional[int] = Form(None),
    inquiry_id: Optional[int] = Form(None),
    customer_id: Optional[str] = Form(None),
    notes: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> ExternalDocOut:
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail={"error": "file_too_large", "message": "文件超过 20MB"})
    if not content:
        raise HTTPException(status_code=422, detail={"error": "empty_file", "message": "文件为空"})
    row = ExternalDocUpload(
        tenant_id=auth.tenant_id or "default",
        order_id=order_id, quote_order_id=quote_order_id,
        inquiry_id=inquiry_id, customer_id=customer_id,
        doc_type=doc_type, file_name=file.filename or "untitled",
        content_type=file.content_type, file_size=len(content),
        content=content, notes=notes,
        uploaded_by=getattr(auth, "user_id", None),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.get("/external-docs", response_model=list[ExternalDocOut])
async def list_external_docs(
    order_id: Optional[int] = None,
    quote_order_id: Optional[int] = None,
    doc_type: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> list[ExternalDocOut]:
    q = select(ExternalDocUpload).order_by(desc(ExternalDocUpload.created_at))
    if order_id is not None:
        q = q.where(ExternalDocUpload.order_id == order_id)
    if quote_order_id is not None:
        q = q.where(ExternalDocUpload.quote_order_id == quote_order_id)
    if doc_type:
        q = q.where(ExternalDocUpload.doc_type == doc_type)
    rows = (await db.execute(q.limit(limit))).scalars().all()
    return [_row_to_out(r) for r in rows]


@router.get("/external-docs/{doc_id}/download")
async def download_external_doc(
    doc_id: int,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> Response:
    row = (await db.execute(
        select(ExternalDocUpload).where(ExternalDocUpload.id == doc_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    return Response(
        content=bytes(row.content),
        media_type=row.content_type or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{row.file_name}"'},
    )


@router.patch("/external-docs/{doc_id}")
async def update_external_doc(
    doc_id: int,
    body: ExternalDocStatusIn,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> ExternalDocOut:
    row = (await db.execute(
        select(ExternalDocUpload).where(ExternalDocUpload.id == doc_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    if body.status not in ("draft", "issued", "void"):
        raise HTTPException(status_code=422, detail={"error": "invalid_status", "message": "status 只能是 draft/issued/void"})
    row.status = body.status
    if body.notes is not None:
        row.notes = body.notes
    await db.commit()
    await db.refresh(row)
    return _row_to_out(row)


@router.delete("/external-docs/{doc_id}", status_code=204)
async def delete_external_doc(
    doc_id: int,
    db: AsyncSession = Depends(get_db_session),
    auth: AuthContext = Depends(get_auth_context),
) -> None:
    row = (await db.execute(
        select(ExternalDocUpload).where(ExternalDocUpload.id == doc_id)
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "DOC_NOT_FOUND"})
    await db.delete(row)
    await db.commit()
    return None
