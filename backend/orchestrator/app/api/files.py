"""文件 / 产品媒体 API（orchestrator 侧 —— 契约源头）

端点：
- GET    /api/v1/products                          产品列表（ProductSpec 注册表 + 图片数 + 基础信息）
- GET    /api/v1/products/{key}/profile            产品基础信息
- PUT    /api/v1/products/{key}/profile            保存基础信息
- GET    /api/v1/products/{key}/media              产品图片列表
- POST   /api/v1/products/{key}/media              上传图片（multipart：file + name + media_kind）
- PATCH  /api/v1/file-objects/{id}                 改名 / 设主图 / 排序
- DELETE /api/v1/file-objects/{id}                 下线（保留行档，不物理删）
- GET    /api/v1/file-objects/{id}/content         取文件本体
- GET    /api/v1/trade-docs/{doc_id}/files         单证挂的文件
- POST   /api/v1/trade-docs/{doc_id}/files         挂文件（产品图引用 / 盖章回传 / PDF）
- DELETE /api/v1/trade-docs/{doc_id}/files/{id}    摘除引用

设计口径（见 docs/PRODUCT_MEDIA_STORAGE_PLAN.md）：
- **业务行**留业务表；**文件元数据**进 `file_objects`；**文件本体**进对象存储
  （生产 R2 / 本地 inline），本模块只写元数据 + 通过 storage 后端落字节。
- 产品图**引用而非复制**：产品图一份，单证用 `trade_doc_files.file_id` 引用。
- 盖章回传**版本化**：同 (归属, kind='stamp_scan') 再次上传 ⇒ 新版本上位、
  旧版本 `is_current=false` 但**保留**（`supersedes_id` 串成版本链）。
- 校验全部走共享内核 `kaas_common.files`（两端同一套判定，不各写一份）。
"""
from __future__ import annotations

import hashlib
import os
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from kaas_common.files import (
    FileRuleError,
    MAX_RENDER_PDF_BYTES,
    RENDERER_NOT_CONFIGURED_DETAIL,
    RENDER_PDF_KIND,
    current_of,
    looks_like_pdf,
    next_version,
    object_key,
    presign_get_url,
    presign_put_url,
    render_pdf_rest_config,
    s3_config,
    validate_render_html,
    validate_upload,
)
from kaas_common.files import MEDIA_KIND_LABELS

from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
from app.api.ws_common import tenant_id_of
from app.services.export_quote.products import get as get_product, keys as product_keys

router = APIRouter(prefix="/api/v1", tags=["files"])

# 存储后端：**S3（生产 R2 / 本地 MinIO）优先**；没配好就 inline（本机零依赖开发）。
# 两端判定同一条规则（`kaas_common.files.s3_config`），不各写一份。
_S3_TIMEOUT = 30.0

_META_COLS = (
    "id, tenant_id, team_id, owner_type, owner_id, kind, media_kind, name, storage, "
    "object_key, file_name, content_type, file_size, sha256, version, supersedes_id, "
    "is_current, is_primary, sort_order, uploaded_by, created_at"
)

# 联表查询用：列名必须显式带前缀，否则 `id` 在 t 与 f 上都有、SQL 直接报歧义
_FILE_COLS_F = (
    "f.id, f.tenant_id, f.team_id, f.owner_type, f.owner_id, f.kind, f.media_kind, f.name, "
    "f.storage, f.object_key, f.file_name, f.content_type, f.file_size, f.sha256, f.version, "
    "f.supersedes_id, f.is_current, f.is_primary, f.sort_order, f.uploaded_by, f.created_at"
)

# 产品图**展示顺序**的唯一排序口径（orchestrator 与 worker 逐字一致）：
#   主图恒排最前 → 自定义顺序 → id 兜底（sort_order 相同也不抖）
_FILE_ORDER_BY = "is_primary DESC, sort_order, id"

# 排序值上界：展示位次是人工维护的，正常不会超过图片张数；给个明确上界
# 防止误填天文数字把某张图排到"看不见的地方"。
_MAX_SORT_ORDER = 9999


def _row_to_file(row) -> dict:
    d = dict(row)
    d["id"] = int(d["id"]) if d.get("id") is not None else None
    d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
    for k in ("team_id", "file_size", "version", "supersedes_id", "sort_order"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


def _fail(exc: FileRuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


def _s3() -> Optional[dict]:
    """S3 配置；没配好返回 None ⇒ 用 inline（本机零依赖开发）。"""
    return s3_config(os.environ.get)


async def _store_bytes(key: str, data: bytes, content_type: str) -> tuple[str, Optional[str], Optional[bytes]]:
    """写入存储后端，返回 `(storage, object_key, inline_content)` —— 如实反映字节落点。

    配好 S3 时走**预签名 PUT**（同一段代码服务生产 R2 与本地 MinIO）；
    否则字节留在库里（`storage='inline'`）。
    """
    cfg = _s3()
    if cfg:
        url = presign_put_url(
            cfg["endpoint"], cfg["bucket"], key,
            access_key=cfg["access_key"], secret_key=cfg["secret_key"],
            region=cfg["region"], expires=cfg["expires"])
        async with httpx.AsyncClient(timeout=_S3_TIMEOUT) as client:
            res = await client.put(
                url, content=data,
                headers={"Content-Type": content_type or "application/octet-stream"})
            res.raise_for_status()
        return "s3", key, None
    return "inline", key, data


async def _load_bytes(row) -> Optional[bytes]:
    """取字节：inline 直接读列；s3 用预签名 GET 回源（短时效，不入库链接）。"""
    if row.get("content") is not None:
        return bytes(row["content"])
    cfg = _s3()
    if not (cfg and row.get("object_key")):
        return None
    url = presign_get_url(
        cfg["endpoint"], cfg["bucket"], row["object_key"],
        access_key=cfg["access_key"], secret_key=cfg["secret_key"],
        region=cfg["region"], expires=cfg["expires"])
    async with httpx.AsyncClient(timeout=_S3_TIMEOUT) as client:
        res = await client.get(url)
    return res.content if res.status_code == 200 else None


async def load_file_bytes(row) -> Optional[bytes]:
    """给其它模块用（单证 render-data 装配层要按 storage 取字节）。

    单独暴露一个名字而不是让调用方 import `_load_bytes`：下划线函数是模块私有的，
    跨模块直接引用会让"改内部实现"变成破坏别人的契约。
    """
    return await _load_bytes(row)


async def _fetch_current(
    db: AsyncSession, tenant_id: str, owner_type: str, owner_id: Optional[str],
    kind: str, media_kind: Optional[str] = None,
) -> Optional[dict]:
    """同一归属 + 用途的"当前件"（版本化用）。"""
    sql = (
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND owner_type=:ot"
        " AND coalesce(owner_id,'')=coalesce(:oid,'') AND kind=:k"
    )
    params = {"t": tenant_id, "ot": owner_type, "oid": owner_id, "k": kind}
    if media_kind is not None:
        sql += " AND coalesce(media_kind,'')=coalesce(:mk,'')"
        params["mk"] = media_kind
    sql += " ORDER BY version DESC"
    rows = (await db.execute(text(sql), params)).mappings().all()
    return current_of([dict(r) for r in rows])


async def _create_file(
    db: AsyncSession, *, auth: AuthContext, tenant_id: str, owner_type: str, owner_id: Optional[str],
    kind: str, media_kind: Optional[str], name: str, content: bytes,
    content_type: str, file_name: Optional[str], supersede: bool,
    pre_uploaded: Optional[tuple[str, str]] = None,
) -> dict:
    """落一条文件元数据（+ 字节）。

    `supersede=True`（盖章回传 / 系统 PDF）⇒ 走版本化：新版本上位，旧版本留档。
    `supersede=False`（产品图）⇒ 并存，互不顶替（016/017 迁移已把唯一索引收窄）。
    """
    try:
        validate_upload(owner_type=owner_type, kind=kind, media_kind=media_kind,
                        name=name, content_type=content_type, size=len(content))
    except FileRuleError as exc:
        raise _fail(exc)

    sha = hashlib.sha256(content).hexdigest()
    key = object_key(tenant_id=tenant_id, owner_type=owner_type, owner_id=owner_id,
                     kind=kind, media_kind=media_kind, sha256=sha,
                     content_type=content_type, file_name=file_name)
    if pre_uploaded is not None:
        # 浏览器已直传到对象存储（预签名 PUT）→ 这里只登记元数据，字节不再经服务端
        storage, stored_key, inline = pre_uploaded[0], pre_uploaded[1], None
    else:
        storage, stored_key, inline = await _store_bytes(key, content, content_type)

    version, supersedes_id = 1, None
    if supersede:
        cur = await _fetch_current(db, tenant_id, owner_type, owner_id, kind, media_kind)
        if cur:
            version, supersedes_id = next_version(cur)
            await db.execute(
                text("UPDATE file_objects SET is_current=false, updated_at=now() WHERE id=:id"),
                {"id": cur["id"]},
            )

    row = (await db.execute(text(
        "INSERT INTO file_objects (tenant_id, team_id, owner_type, owner_id, kind, media_kind,"
        " name, storage, object_key, content, file_name, content_type, file_size, sha256,"
        " version, supersedes_id, is_current, uploaded_by)"
        " VALUES (:t,:team,:ot,:oid,:k,:mk,:name,:storage,:okey,:content,:fname,:ctype,:size,"
        ":sha,:ver,:supers,true,:by) RETURNING " + _META_COLS
    ), {
        "t": tenant_id, "team": getattr(auth, "team_id", None), "ot": owner_type, "oid": owner_id,
        "k": kind, "mk": media_kind, "name": name.strip(), "storage": storage,
        "okey": stored_key, "content": inline, "fname": file_name, "ctype": content_type,
        "size": len(content), "sha": sha, "ver": version, "supers": supersedes_id,
        "by": str(getattr(auth, "user_id", "") or "") or None,
    })).mappings().first()
    return _row_to_file(row)


# ── 产品 ────────────────────────────────────────────────────────────────────

@router.get("/products", summary="产品列表（注册表 + 图片数 + 基础信息）")
async def list_products(auth: AuthContext = Depends(get_auth_context),
                        db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    media = {
        r["owner_id"]: int(r["n"])
        for r in (await db.execute(text(
            "SELECT owner_id, COUNT(*) AS n FROM file_objects WHERE tenant_id=:t"
            " AND owner_type='product' AND kind='product_photo' AND is_current"
            " GROUP BY owner_id"), {"t": tenant_id})).mappings().all()
    }
    profiles = {
        r["product_key"]: r["info"]
        for r in (await db.execute(text(
            "SELECT product_key, info FROM product_profiles WHERE tenant_id=:t"),
            {"t": tenant_id})).mappings().all()
    }
    # 产品本体是代码里的 ProductSpec（注册表 keys() 才是"有哪些产品"的唯一来源），
    # 这里只把**租户可编辑**的图片数与基础信息挂上去，不复制规格定义。
    out = []
    for key in product_keys():
        spec = get_product(key)
        out.append({
            "product_key": key,
            "name": spec.name or key,
            "name_en": spec.name_en,
            "category_code": spec.category_code,
            "media_count": media.get(key, 0),
            "profile": profiles.get(key) or {},
        })
    return {"items": out, "media_kinds": MEDIA_KIND_LABELS}


class ProfileIn(BaseModel):
    info: dict


@router.get("/products/{product_key}/profile", summary="产品基础信息")
async def get_profile(product_key: str, auth: AuthContext = Depends(get_auth_context),
                      db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(text(
        "SELECT product_key, info, updated_at FROM product_profiles"
        " WHERE tenant_id=:t AND product_key=:k"), {"t": tenant_id, "k": product_key})).mappings().first()
    return {"product_key": product_key, "info": dict(row["info"]) if row else {},
            "updated_at": row["updated_at"].isoformat() if row else None}


@router.put("/products/{product_key}/profile", summary="保存产品基础信息")
async def put_profile(product_key: str, body: ProfileIn,
                      auth: AuthContext = Depends(get_auth_context),
                      db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    await db.execute(text(
        "INSERT INTO product_profiles (tenant_id, product_key, info, updated_by)"
        " VALUES (:t,:k,CAST(:info AS jsonb),:by)"
        " ON CONFLICT (tenant_id, product_key) DO UPDATE SET info=EXCLUDED.info,"
        " updated_by=EXCLUDED.updated_by, updated_at=now()"
    ), {"t": tenant_id, "k": product_key, "info": _json_dumps(body.info),
        "by": str(getattr(auth, "user_id", "") or "") or None})
    return await get_profile(product_key, auth, db)


def _json_dumps(obj) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False)


# ── 产品图片 ────────────────────────────────────────────────────────────────

@router.get("/products/{product_key}/media", summary="产品图片列表")
async def list_media(product_key: str, auth: AuthContext = Depends(get_auth_context),
                     db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(text(
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND owner_type='product'"
        " AND owner_id=:k AND kind='product_photo' AND is_current"
        f" ORDER BY {_FILE_ORDER_BY}"), {"t": tenant_id, "k": product_key}
    )).mappings().all()
    return {"items": [_row_to_file(r) for r in rows], "media_kinds": MEDIA_KIND_LABELS}


@router.post("/products/{product_key}/media", status_code=201, summary="上传产品图片")
async def upload_media(product_key: str,
                       file: UploadFile = File(...),
                       name: str = Form(...),
                       media_kind: str = Form(...),
                       auth: AuthContext = Depends(get_auth_context),
                       db: AsyncSession = Depends(get_db_session)):
    """上传产品图：**必须命名**（用户要求）、**必须选类型**（生产/尺寸/重量/成品）。

    产品图**并存**（不互相顶替）：一个产品可以有多张尺寸图。
    """
    tenant_id = tenant_id_of(auth)
    data = await file.read()
    return await _create_file(
        db, auth=auth, tenant_id=tenant_id, owner_type="product", owner_id=product_key,
        kind="product_photo", media_kind=media_kind, name=name, content=data,
        content_type=file.content_type or "", file_name=file.filename, supersede=False,
    )


# ── 文件对象（改名 / 主图 / 下线 / 取本体）─────────────────────────────────

class FilePatch(BaseModel):
    name: Optional[str] = None
    is_primary: Optional[bool] = None
    caption: Optional[str] = None
    sort_order: Optional[int] = None


@router.patch("/file-objects/{file_id}", summary="改名 / 设主图 / 排序")
async def patch_file(file_id: int, body: FilePatch,
                     auth: AuthContext = Depends(get_auth_context),
                     db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(text(
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND id=:id"),
        {"t": tenant_id, "id": file_id})).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})

    if body.name is not None:
        label = body.name.strip()
        if not label:
            raise _fail(FileRuleError("NAME_REQUIRED", "名称不能为空"))
        if len(label) > 80:
            raise _fail(FileRuleError("NAME_TOO_LONG", "名称最长 80 个字符"))
        await db.execute(text("UPDATE file_objects SET name=:n, updated_at=now() WHERE id=:id"),
                         {"n": label, "id": file_id})
    if body.is_primary is not None:
        if body.is_primary:
            # 同一归属 + 用途只能有一张主图：先把其它行降下来，再设自己
            await db.execute(text(
                "UPDATE file_objects SET is_primary=false, updated_at=now()"
                " WHERE tenant_id=:t AND owner_type=:ot AND coalesce(owner_id,'')=coalesce(:oid,'')"
                " AND kind=:k"), {"t": tenant_id, "ot": row["owner_type"],
                                  "oid": row["owner_id"], "k": row["kind"]})
        await db.execute(text("UPDATE file_objects SET is_primary=:p, updated_at=now() WHERE id=:id"),
                         {"p": body.is_primary, "id": file_id})
    if body.sort_order is not None:
        # 排序值是人工维护的展示位次：给个明确上界，防误填天文数字把图排到看不见的地方
        if body.sort_order < 0 or body.sort_order > _MAX_SORT_ORDER:
            raise _fail(FileRuleError(
                "SORT_ORDER_OUT_OF_RANGE",
                f"排序值需在 0 ~ {_MAX_SORT_ORDER} 之间"))
        await db.execute(text("UPDATE file_objects SET sort_order=:s, updated_at=now() WHERE id=:id"),
                         {"s": body.sort_order, "id": file_id})
    return {"ok": True}


@router.delete("/file-objects/{file_id}", status_code=204, summary="下线文件（保留行档）")
async def retire_file(file_id: int, auth: AuthContext = Depends(get_auth_context),
                      db: AsyncSession = Depends(get_db_session)):
    """**不物理删除**：置 `is_current=false` 即从"当前"里消失，行还在（可审计/可回溯）。"""
    tenant_id = tenant_id_of(auth)
    res = await db.execute(text(
        "UPDATE file_objects SET is_current=false, is_primary=false, updated_at=now()"
        " WHERE tenant_id=:t AND id=:id"), {"t": tenant_id, "id": file_id})
    if not res.rowcount:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    return Response(status_code=204)


@router.get("/file-objects/{file_id}/content", summary="取文件本体")
async def get_file_content(file_id: int, auth: AuthContext = Depends(get_auth_context),
                           db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(text(
        "SELECT content_type, file_name, content, object_key, storage FROM file_objects"
        " WHERE tenant_id=:t AND id=:id"), {"t": tenant_id, "id": file_id})).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    data = await _load_bytes(dict(row))
    if data is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_BODY_NOT_FOUND"})
    return Response(content=data,
                    media_type=row["content_type"] or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})


@router.get("/file-objects/{file_id}/url", summary="短时效直链（预签名 GET）")
async def get_file_url(file_id: int, auth: AuthContext = Depends(get_auth_context),
                       db: AsyncSession = Depends(get_db_session)):
    """给外部（货代/客户）或大文件用的**短时效直链**；没配 S3 就明确说不可用。

    为什么不是永久公开链接：文件是业务资料，链接泄露即数据泄露 ——
    所以只发短时效 URL，且仍需登录才能申请。
    """
    tenant_id = tenant_id_of(auth)
    row = (await db.execute(text(
        "SELECT object_key, content_type, file_name FROM file_objects"
        " WHERE tenant_id=:t AND id=:id AND is_current"), {"t": tenant_id, "id": file_id})
    ).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    cfg = _s3()
    if not (cfg and row["object_key"]):
        return {"configured": False, "reason": "该文件不在对象存储里（inline 或未上传）"}
    url = presign_get_url(
        cfg["endpoint"], cfg["bucket"], row["object_key"],
        access_key=cfg["access_key"], secret_key=cfg["secret_key"],
        region=cfg["region"], expires=cfg["expires"])
    return {"configured": True, "url": url, "expires_in": cfg["expires"]}


class PresignIn(BaseModel):
    owner_type: str
    owner_id: Optional[str] = None
    kind: str
    media_kind: Optional[str] = None
    name: str
    content_type: str
    size: int
    sha256: str
    file_name: Optional[str] = None


def _validate_direct(body: "PresignIn") -> str:
    try:
        validate_upload(owner_type=body.owner_type, kind=body.kind, media_kind=body.media_kind,
                        name=body.name, content_type=body.content_type, size=body.size)
    except FileRuleError as exc:
        raise _fail(exc)
    sha = (body.sha256 or "").strip().lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": "SHA256_REQUIRED",
            "detail": "直传必须先算好文件的 sha256（64 位十六进制）"})
    return sha


@router.post("/file-objects/presign", summary="直传预签名（字节不过服务端）")
async def presign_upload(body: PresignIn, auth: AuthContext = Depends(get_auth_context)):
    """返回短时效**预签名 PUT URL**：浏览器直连对象存储上传，字节不经过我们。

    没配 S3 时返回 `{"configured": false}` ⇒ 前端回退到 multipart 代理上传
    （功能不缺，只是字节经服务端中转）。
    """
    sha = _validate_direct(body)
    cfg = _s3()
    if not cfg:
        return {"configured": False}
    key = object_key(
        tenant_id=tenant_id_of(auth), owner_type=body.owner_type, owner_id=body.owner_id,
        kind=body.kind, media_kind=body.media_kind, sha256=sha,
        content_type=body.content_type, file_name=body.file_name)
    url = presign_put_url(
        cfg["endpoint"], cfg["bucket"], key,
        access_key=cfg["access_key"], secret_key=cfg["secret_key"],
        region=cfg["region"], expires=cfg["expires"])
    return {"configured": True, "upload_url": url, "object_key": key,
            "method": "PUT", "expires_in": cfg["expires"]}


class RegisterIn(PresignIn):
    supersede: bool = False


@router.post("/file-objects/register", status_code=201, summary="登记已直传的文件")
async def register_upload(body: RegisterIn, auth: AuthContext = Depends(get_auth_context),
                          db: AsyncSession = Depends(get_db_session)):
    """直传完成后登记元数据（字节已在对象存储，这里不碰字节）。"""
    sha = _validate_direct(body)
    key = object_key(
        tenant_id=tenant_id_of(auth), owner_type=body.owner_type, owner_id=body.owner_id,
        kind=body.kind, media_kind=body.media_kind, sha256=sha,
        content_type=body.content_type, file_name=body.file_name)
    return await _create_file(
        db, auth=auth, tenant_id=tenant_id_of(auth), owner_type=body.owner_type,
        owner_id=body.owner_id, kind=body.kind, media_kind=body.media_kind, name=body.name,
        content=b"", content_type=body.content_type, file_name=body.file_name,
        supersede=body.supersede, pre_uploaded=("s3", key),
    )


# ── 单证挂文件 ──────────────────────────────────────────────────────────────

class DocFileIn(BaseModel):
    file_id: Optional[int] = None
    role: str = "product_photo"
    caption: Optional[str] = None
    sort_order: int = 0


@router.get("/trade-docs/{doc_id}/files", summary="单证挂的文件")
async def list_doc_files(doc_id: int, auth: AuthContext = Depends(get_auth_context),
                         db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    rows = (await db.execute(text(
        f"SELECT t.id AS link_id, t.role AS link_role, t.caption AS link_caption,"
        f" t.sort_order AS link_sort_order, {_FILE_COLS_F}"
        " FROM trade_doc_files t JOIN file_objects f ON f.id = t.file_id"
        " WHERE t.tenant_id=:t AND t.trade_doc_id=:d ORDER BY t.sort_order, t.id"),
        {"t": tenant_id, "d": doc_id})).mappings().all()
    items = []
    for r in rows:
        item = _row_to_file({k: v for k, v in r.items() if not k.startswith("link_")})
        item.update({"link_id": int(r["link_id"]), "role": r["link_role"],
                     "caption": r["link_caption"], "sort_order": int(r["link_sort_order"])})
        items.append(item)
    return {"items": items}


@router.post("/trade-docs/{doc_id}/files", status_code=201, summary="挂文件 / 盖章回传")
async def attach_doc_file(doc_id: int, body: DocFileIn,
                          auth: AuthContext = Depends(get_auth_context),
                          db: AsyncSession = Depends(get_db_session)):
    """把已有文件（产品图 / 已上传的回传件）**引用**到单证上。

    引用而非复制：产品图改一次，引用它的所有单证同步生效。
    `role` 属于**版本化角色**（`stamp_scan` 盖章回传 / `render_pdf` 系统出的 PDF）时，
    旧的"当前件"链接自动让位（改挂 `<role>_superseded`，**不物理删**，历史可回溯）。
    """
    tenant_id = tenant_id_of(auth)
    if body.file_id is None:
        raise HTTPException(status_code=422, detail={"error": "validation", "code": "FILE_REQUIRED"})
    file_row = (await db.execute(text(
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND id=:id"),
        {"t": tenant_id, "id": body.file_id})).mappings().first()
    if file_row is None or not file_row["is_current"]:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})

    if body.role in ("stamp_scan", "render_pdf"):
        # 版本化角色：旧的"当前件"退出当前 —— 改挂 `<role>_superseded`，行保留可追溯。
        # 让位只针对**同一个 role**：盖章件与系统 PDF 各自只留一条"当前"。
        await db.execute(text(
            "UPDATE trade_doc_files SET role=:superseded"
            " WHERE tenant_id=:t AND trade_doc_id=:d AND role=:role"),
            {"superseded": f"{body.role}_superseded", "t": tenant_id, "d": doc_id,
             "role": body.role})

    row = (await db.execute(text(
        "INSERT INTO trade_doc_files (tenant_id, trade_doc_id, file_id, role, caption, sort_order)"
        " VALUES (:t,:d,:f,:r,:c,:s) RETURNING id, role, caption, sort_order"),
        {"t": tenant_id, "d": doc_id, "f": body.file_id, "r": body.role,
         "c": body.caption, "s": body.sort_order})).mappings().first()
    return dict(row)


@router.delete("/trade-docs/{doc_id}/files/{link_id}", status_code=204, summary="摘除引用")
async def detach_doc_file(doc_id: int, link_id: int,
                          auth: AuthContext = Depends(get_auth_context),
                          db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    res = await db.execute(text(
        "DELETE FROM trade_doc_files WHERE tenant_id=:t AND trade_doc_id=:d AND id=:id"),
        {"t": tenant_id, "d": doc_id, "id": link_id})
    if not res.rowcount:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "LINK_NOT_FOUND"})
    return Response(status_code=204)


@router.post("/trade-docs/{doc_id}/files/upload", status_code=201,
             summary="上传并挂到单证（盖章回传 / 扫描件）")
async def upload_doc_file(doc_id: int,
                          file: UploadFile = File(...),
                          role: str = Form("stamp_scan"),
                          name: str = Form(""),
                          caption: Optional[str] = Form(None),
                          auth: AuthContext = Depends(get_auth_context),
                          db: AsyncSession = Depends(get_db_session)):
    """上传文件**并**挂到单证（客户盖章回传走这条）。

    - `role='stamp_scan'`（默认）⇒ **版本化**：新版本上位，旧版本 `is_current=false`
      但**保留**（用户要求"覆盖旧件"同时"留档"）。
    - `name` 留空时回落到文件名（用户要求"上传后给它命名"，先给个可用默认值）。
    """
    tenant_id = tenant_id_of(auth)
    data = await file.read()
    label = (name or "").strip() or (file.filename or "回传件")
    row = await _create_file(
        db, auth=auth, tenant_id=tenant_id, owner_type="trade_doc", owner_id=str(doc_id),
        kind=role, media_kind=None, name=label, content=data,
        content_type=file.content_type or "", file_name=file.filename,
        supersede=role in ("stamp_scan", "render_pdf"),
    )
    link = await attach_doc_file(doc_id, DocFileIn(file_id=row["id"], role=role,
                                                   caption=caption), auth, db)
    return {"file": row, "link": link}


# ── 自动出 PDF（Cloudflare Browser Rendering）→ 复用上面的落档链路 ──────────────
#
# 为什么入参是 HTML 而不是 doc_id：归档件必须与用户看到的那一版**同源**
# （服务端"再渲染一次"= 另写一套排版，正是设计文档 §四 风险 1 要避免的）。
# 安全边界：入参 HTML 会被我们账号里的无头浏览器渲染 ⇒ 必须过
# `kaas_common.files.validate_render_html`（拒脚本/事件属性/外链资源）。

_BROWSER_TIMEOUT = 90.0


class RenderPdfIn(BaseModel):
    html: str
    name: Optional[str] = None


async def _render_pdf_via_rest(cfg: dict, html: str) -> bytes:
    """调 Browser Rendering `/pdf` 拿回 PDF 字节；非 200 → 502（不静默兜底）。"""
    async with httpx.AsyncClient(timeout=_BROWSER_TIMEOUT) as client:
        res = await client.post(
            cfg["url"],
            headers={"Authorization": f"Bearer {cfg['token']}",
                     "Content-Type": "application/json"},
            json={"html": html},
        )
    if res.status_code != 200:
        raise HTTPException(status_code=502, detail={
            "error": "upstream", "code": "PDF_RENDER_FAILED",
            "detail": f"Browser Rendering 返回 {res.status_code}",
        })
    return res.content


@router.post("/trade-docs/{doc_id}/pdf", status_code=201,
             summary="自动出 PDF 并归档（Browser Rendering）")
async def render_doc_pdf(doc_id: int, body: RenderPdfIn,
                         auth: AuthContext = Depends(get_auth_context),
                         db: AsyncSession = Depends(get_db_session)):
    """把预览同源的单证 HTML 交给服务端无头浏览器出 PDF，并**落档**到这张单证上。

    - 出字节后复用盖章回传那套链路：`_create_file(kind='render_pdf', supersede=True)`
      → `attach_doc_file(role='render_pdf')` ⇒ 再归档 = 新版本上位、旧版挂
      `render_pdf_superseded` 留档（**不物理删**，版本让位已在 `attach_doc_file` 内实现）。
    - **未配置渲染器 → 503**（不假装成功）；上游失败 / 返回不是 PDF → 502；
      入参 HTML 含脚本或外链 → 422（见 `kaas_common.files.validate_render_html`）。
    """
    tenant_id = tenant_id_of(auth)
    try:
        validate_render_html(body.html)
    except FileRuleError as exc:
        raise _fail(exc)

    cfg = render_pdf_rest_config(os.environ.get)
    if cfg is None:
        raise HTTPException(status_code=503, detail={
            "error": "unavailable", "code": "PDF_RENDERER_NOT_CONFIGURED",
            "detail": RENDERER_NOT_CONFIGURED_DETAIL,
        })

    data = await _render_pdf_via_rest(cfg, body.html)
    if not looks_like_pdf(data):
        raise HTTPException(status_code=502, detail={
            "error": "upstream", "code": "PDF_RENDER_FAILED",
            "detail": "渲染服务没有返回 PDF 字节（已拒绝把非 PDF 存成 render_pdf）",
        })
    if len(data) > MAX_RENDER_PDF_BYTES:
        raise _fail(FileRuleError(
            "FILE_TOO_LARGE",
            f"生成的 PDF 超过上限 {MAX_RENDER_PDF_BYTES // (1024 * 1024)}MB"
            f"（实际 {len(data)} 字节）"))

    name = (body.name or "").strip() or f"单证 {doc_id} 系统 PDF"
    row = await _create_file(
        db, auth=auth, tenant_id=tenant_id, owner_type="trade_doc", owner_id=str(doc_id),
        kind=RENDER_PDF_KIND, media_kind=None, name=name, content=data,
        content_type="application/pdf", file_name=name, supersede=True,
    )
    link = await attach_doc_file(
        doc_id, DocFileIn(file_id=row["id"], role=RENDER_PDF_KIND), auth, db)
    return {"file": row, "link": link, "renderer": "rest",
            "bytes": len(data), "storage": row["storage"]}


@router.get("/file-objects", summary="文件列表（按归属/用途筛）")
async def list_files(owner_type: str = Query(...), owner_id: Optional[str] = None,
                     kind: Optional[str] = None,
                     auth: AuthContext = Depends(get_auth_context),
                     db: AsyncSession = Depends(get_db_session)):
    tenant_id = tenant_id_of(auth)
    sql = (f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND owner_type=:ot"
           " AND coalesce(owner_id,'')=coalesce(:oid,'') AND is_current")
    params = {"t": tenant_id, "ot": owner_type, "oid": owner_id}
    if kind:
        sql += " AND kind=:k"
        params["k"] = kind
    sql += f" ORDER BY {_FILE_ORDER_BY}"
    rows = (await db.execute(text(sql), params)).mappings().all()
    return {"items": [_row_to_file(r) for r in rows]}
