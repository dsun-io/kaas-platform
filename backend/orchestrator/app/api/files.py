"""文件 / 产品媒体 API（orchestrator 侧 —— 契约源头）

端点：
- GET    /api/v1/products                          产品列表（ProductSpec 注册表 + 图片数 + 基础信息）
- GET    /api/v1/products/{key}/profile            产品基础信息
- PUT    /api/v1/products/{key}/profile            保存基础信息
- GET    /api/v1/products/{key}/media              产品图片列表
- POST   /api/v1/products/{key}/media              上传图片（multipart：file + name + media_kind）
- PATCH  /api/v1/file-objects/{id}                 改名 / 设主图
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
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from kaas_common.files import (
    FileRuleError,
    current_of,
    next_version,
    object_key,
    validate_upload,
)
from kaas_common.files import MEDIA_KIND_LABELS

from app.core.auth import AuthContext, get_auth_context
from app.db.session import get_db_session
from app.api.ws_common import tenant_id_of
from app.services.export_quote.products import get as get_product, keys as product_keys

router = APIRouter(prefix="/api/v1", tags=["files"])

# 本侧（本地/开发）字节直接入库；生产 Worker 用 R2 binding（storage='s3'）
LOCAL_STORAGE = "inline"

_META_COLS = (
    "id, tenant_id, team_id, owner_type, owner_id, kind, media_kind, name, storage, "
    "object_key, file_name, content_type, file_size, sha256, version, supersedes_id, "
    "is_current, is_primary, uploaded_by, created_at"
)

# 联表查询用：列名必须显式带前缀，否则 `id` 在 t 与 f 上都有、SQL 直接报歧义
_FILE_COLS_F = (
    "f.id, f.tenant_id, f.team_id, f.owner_type, f.owner_id, f.kind, f.media_kind, f.name, "
    "f.storage, f.object_key, f.file_name, f.content_type, f.file_size, f.sha256, f.version, "
    "f.supersedes_id, f.is_current, f.is_primary, f.uploaded_by, f.created_at"
)


def _row_to_file(row) -> dict:
    d = dict(row)
    d["id"] = int(d["id"]) if d.get("id") is not None else None
    d["created_at"] = d["created_at"].isoformat() if d.get("created_at") else None
    for k in ("team_id", "file_size", "version", "supersedes_id"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


def _fail(exc: FileRuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


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
        "k": kind, "mk": media_kind, "name": name.strip(), "storage": LOCAL_STORAGE,
        "okey": key, "content": content, "fname": file_name, "ctype": content_type,
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
        " ORDER BY is_primary DESC, media_kind, id"), {"t": tenant_id, "k": product_key}
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


@router.patch("/file-objects/{file_id}", summary="改名 / 设主图")
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
        "SELECT content_type, file_name, content FROM file_objects"
        " WHERE tenant_id=:t AND id=:id"), {"t": tenant_id, "id": file_id})).mappings().first()
    if row is None or row["content"] is None:
        # storage='s3' 的字节在对象存储里，由 Worker 侧从 R2 binding 取
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_BODY_NOT_LOCAL"})
    return Response(content=bytes(row["content"]),
                    media_type=row["content_type"] or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})


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
    `role='stamp_scan'` 时**旧的当前盖章件自动让位**（版本化留档）。
    """
    tenant_id = tenant_id_of(auth)
    if body.file_id is None:
        raise HTTPException(status_code=422, detail={"error": "validation", "code": "FILE_REQUIRED"})
    file_row = (await db.execute(text(
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=:t AND id=:id"),
        {"t": tenant_id, "id": body.file_id})).mappings().first()
    if file_row is None or not file_row["is_current"]:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})

    if body.role == "stamp_scan":
        # 盖章回传：旧的那张"当前回传件"退出当前，但行保留（历史版本可追溯）
        await db.execute(text(
            "UPDATE trade_doc_files SET role='stamp_scan_superseded'"
            " WHERE tenant_id=:t AND trade_doc_id=:d AND role='stamp_scan'"),
            {"t": tenant_id, "d": doc_id})

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
    sql += " ORDER BY is_primary DESC, id"
    rows = (await db.execute(text(sql), params)).mappings().all()
    return {"items": [_row_to_file(r) for r in rows]}
