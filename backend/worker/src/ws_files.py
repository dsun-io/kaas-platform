"""文件 / 产品媒体 API（Worker 镜像 · 生产对齐）

契约真源：`backend/orchestrator/app/api/files.py`。本文件只做**适配**，不改口径。

为什么必须有这个文件
--------------------
生产 API 就是本 Worker（`kaas.powervoy.com` / `api.kaas.powervoy.com` 都指向它），
开发在 orchestrator 里做 —— 两边两套代码，`sync-shared.ps1 -Check` 只保共享内核一致，
**管不到路由面**（见 `docs/ROUTE_PARITY_2026-10-10.md`）。所以新增的路由必须在这里镜像，
否则「本地能上传产品图、线上 404」。

与 orchestrator 的差异（仅适配层，均为不得不改的部分）
----------------------------------------------------
1. 数据访问走 `platform/db.py`（asyncpg 直连，返回 dict）；事务用 `main._acquire`。
2. **文件本体**：生产优先写 **R2 binding**（`from js import FILES`，无需 S3 密钥），
   任何异常**自动回退 inline（写 `file_objects.content`）**并把 `storage` 记成实际落点 ——
   上传是用户的显式动作，不能因为绑定/配置问题直接失败；行内记录了真实位置，可审计。
3. 租户恒为 `DEFAULT_TENANT`（Worker 单租户生产部署）。
4. 所有 UPDATE 显式补 `updated_at=now()`（与 orchestrator ORM 的 onupdate 对齐）。

业务判定**一律调用共享内核** `kaas_common.files`（校验 / key 规划 / 版本化），
不在这里另写一份。
"""
from __future__ import annotations

import hashlib
import json as _json
from typing import Optional

from fastapi import Depends, File, Form, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel

from kaas_common.files import (
    FileRuleError,
    MEDIA_KIND_LABELS,
    current_of,
    next_version,
    object_key,
    validate_upload,
)

import main as _main

# 产品注册表：与 orchestrator 同一份（sync-shared 把 export_quote 整包镜像过来），
# 所以"有哪些产品"两端天然一致，不会出现"本地有、线上没有"的产品清单。
from kaas_common.export_quote.products import get as get_product, keys as product_keys

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db

_META_COLS = (
    "id, tenant_id, team_id, owner_type, owner_id, kind, media_kind, name, storage, "
    "object_key, file_name, content_type, file_size, sha256, version, supersedes_id, "
    "is_current, is_primary, uploaded_by, created_at"
)
_FILE_COLS_F = (
    "f.id, f.tenant_id, f.team_id, f.owner_type, f.owner_id, f.kind, f.media_kind, f.name, "
    "f.storage, f.object_key, f.file_name, f.content_type, f.file_size, f.sha256, f.version, "
    "f.supersedes_id, f.is_current, f.is_primary, f.uploaded_by, f.created_at"
)


def _row_to_file(row) -> dict:
    d = dict(row)
    if d.get("created_at") is not None and hasattr(d["created_at"], "isoformat"):
        d["created_at"] = d["created_at"].isoformat()
    for k in ("id", "team_id", "file_size", "version", "supersedes_id"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


def _fail(exc: FileRuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


# ── 文件本体：R2 binding 优先，失败回退 inline ─────────────────────────────

def _r2_bucket():
    """拿 R2 binding（`FILES`）。不在 Pyodide / 没配 binding 时返回 None。

    不在模块顶层 import：本地 pytest 是 CPython，没有 `js` 模块，顶层导入会直接炸掉整个 Worker。
    """
    try:
        from js import FILES  # type: ignore  (Pyodide / Python Workers)
        return FILES
    except Exception:  # noqa: BLE001
        return None


async def _store_bytes(key: str, data: bytes, content_type: str) -> tuple[str, Optional[str], Optional[bytes]]:
    """返回 `(storage, object_key, inline_content)` —— 三者如实反映字节的真实落点。"""
    bucket = _r2_bucket()
    if bucket is not None:
        try:
            from js import Uint8Array  # type: ignore

            await bucket.put(key, Uint8Array.new(data), {"httpMetadata": {"contentType": content_type}})
            return "s3", key, None
        except Exception as exc:  # noqa: BLE001
            # 回退：不把用户的上传动作变成一个 500；落库并如实标注 storage='inline'
            print(f"[files] R2 put 失败，回退 inline：{type(exc).__name__}: {exc}")
    return "inline", key, data


async def _load_bytes(row) -> Optional[bytes]:
    if row.get("content") is not None:
        return bytes(row["content"])
    bucket = _r2_bucket()
    if bucket is None or not row.get("object_key"):
        return None
    try:
        obj = await bucket.get(row["object_key"])
        if obj is None:
            return None
        buf = await obj.arrayBuffer()
        return bytes(buf.to_py())
    except Exception as exc:  # noqa: BLE001
        print(f"[files] R2 get 失败：{type(exc).__name__}: {exc}")
        return None


async def _current_file(conn, tenant_id: str, owner_type: str, owner_id: Optional[str],
                        kind: str, media_kind: Optional[str] = None):
    sql = (f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND owner_type=$2"
           " AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4")
    params = [tenant_id, owner_type, owner_id, kind]
    if media_kind is not None:
        sql += " AND coalesce(media_kind,'')=coalesce($5,'')"
        params.append(media_kind)
    sql += " ORDER BY version DESC"
    rows = await conn.fetch(sql, *params)
    return current_of([dict(r) for r in rows])


async def _create_file(*, request: Request, user: dict, owner_type: str, owner_id: Optional[str],
                       kind: str, media_kind: Optional[str], name: str, content: bytes,
                       content_type: str, file_name: Optional[str], supersede: bool) -> dict:
    try:
        validate_upload(owner_type=owner_type, kind=kind, media_kind=media_kind, name=name,
                        content_type=content_type, size=len(content))
    except FileRuleError as exc:
        raise _fail(exc)

    sha = hashlib.sha256(content).hexdigest()
    key = object_key(tenant_id=DEFAULT_TENANT, owner_type=owner_type, owner_id=owner_id,
                     kind=kind, media_kind=media_kind, sha256=sha,
                     content_type=content_type, file_name=file_name)
    storage, object_key_value, inline = await _store_bytes(key, content, content_type)
    actor = str(user.get("id") or "") or None

    async with _main._acquire(request) as conn:
        async with conn.transaction():
            version, supersedes_id = 1, None
            if supersede:
                cur = await _current_file(conn, DEFAULT_TENANT, owner_type, owner_id, kind, media_kind)
                if cur:
                    version, supersedes_id = next_version(cur)
                    await conn.execute(
                        "UPDATE file_objects SET is_current=false, updated_at=now() WHERE id=$1",
                        int(cur["id"]))
            row = await conn.fetchrow(
                "INSERT INTO file_objects (tenant_id, team_id, owner_type, owner_id, kind,"
                " media_kind, name, storage, object_key, content, file_name, content_type,"
                " file_size, sha256, version, supersedes_id, is_current, uploaded_by)"
                " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,$17)"
                f" RETURNING {_META_COLS}",
                DEFAULT_TENANT, user.get("team_id"), owner_type, owner_id, kind, media_kind,
                name.strip(), storage, object_key_value, inline, file_name, content_type,
                len(content), sha, version, supersedes_id, actor)
    return _row_to_file(row)


# ── 产品 ────────────────────────────────────────────────────────────────────

@app.get("/api/v1/products")
async def list_products(request: Request, user: dict = Depends(_get_current_user)):
    """产品来自**代码注册表**（ProductSpec keys），这里只挂租户可编辑的图片数与基础信息。"""
    rows = await db.fetch(
        request,
        "SELECT owner_id, COUNT(*) AS n FROM file_objects WHERE tenant_id=$1"
        " AND owner_type='product' AND kind='product_photo' AND is_current GROUP BY owner_id",
        DEFAULT_TENANT, table=None)
    media = {r["owner_id"]: int(r["n"]) for r in rows}
    profs = await db.fetch(
        request, "SELECT product_key, info FROM product_profiles WHERE tenant_id=$1",
        DEFAULT_TENANT, table="product_profiles")
    profiles = {r["product_key"]: r["info"] for r in profs}
    items = []
    for key in product_keys():
        spec = get_product(key)
        items.append({
            "product_key": key,
            "name": spec.name or key,
            "name_en": spec.name_en,
            "category_code": spec.category_code,
            "media_count": media.get(key, 0),
            "profile": profiles.get(key) or {},
        })
    return {"items": items, "media_kinds": MEDIA_KIND_LABELS}


class ProfileIn(BaseModel):
    info: dict


@app.get("/api/v1/products/{product_key}/profile")
async def get_profile(product_key: str, request: Request, user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request, "SELECT product_key, info, updated_at FROM product_profiles"
        " WHERE tenant_id=$1 AND product_key=$2", DEFAULT_TENANT, product_key,
        table="product_profiles")
    return {"product_key": product_key,
            "info": dict(row["info"]) if row and row.get("info") else {},
            "updated_at": row["updated_at"].isoformat() if row and row.get("updated_at") else None}


@app.put("/api/v1/products/{product_key}/profile")
async def put_profile(product_key: str, body: ProfileIn, request: Request,
                      user: dict = Depends(_get_current_user)):
    await db.execute(
        request,
        "INSERT INTO product_profiles (tenant_id, product_key, info, updated_by)"
        " VALUES ($1,$2,CAST($3 AS jsonb),$4)"
        " ON CONFLICT (tenant_id, product_key) DO UPDATE SET info=EXCLUDED.info,"
        " updated_by=EXCLUDED.updated_by, updated_at=now()",
        DEFAULT_TENANT, product_key, _json.dumps(body.info, ensure_ascii=False),
        str(user.get("id") or "") or None)
    return await get_profile(product_key, request, user)


# ── 产品图片 ────────────────────────────────────────────────────────────────

@app.get("/api/v1/products/{product_key}/media")
async def list_media(product_key: str, request: Request, user: dict = Depends(_get_current_user)):
    rows = await db.fetch(
        request,
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND owner_type='product'"
        " AND owner_id=$2 AND kind='product_photo' AND is_current"
        " ORDER BY is_primary DESC, media_kind, id", DEFAULT_TENANT, product_key,
        table=None)
    return {"items": [_row_to_file(r) for r in rows], "media_kinds": MEDIA_KIND_LABELS}


@app.post("/api/v1/products/{product_key}/media", status_code=201)
async def upload_media(product_key: str, request: Request,
                       file: UploadFile = File(...),
                       name: str = Form(...),
                       media_kind: str = Form(...),
                       user: dict = Depends(_get_current_user)):
    """上传产品图：必须命名 + 必须选类型；产品图**并存**（不互相顶替）。"""
    data = await file.read()
    return await _create_file(
        request=request, user=user, owner_type="product", owner_id=product_key,
        kind="product_photo", media_kind=media_kind, name=name, content=data,
        content_type=file.content_type or "", file_name=file.filename, supersede=False)


# ── 文件对象 ────────────────────────────────────────────────────────────────

class FilePatch(BaseModel):
    name: Optional[str] = None
    is_primary: Optional[bool] = None


@app.patch("/api/v1/file-objects/{file_id}")
async def patch_file(file_id: int, body: FilePatch, request: Request,
                     user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request, f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, file_id, table=None)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    if body.name is not None:
        label = body.name.strip()
        if not label:
            raise _fail(FileRuleError("NAME_REQUIRED", "名称不能为空"))
        if len(label) > 80:
            raise _fail(FileRuleError("NAME_TOO_LONG", "名称最长 80 个字符"))
        await db.execute(request, "UPDATE file_objects SET name=$1, updated_at=now() WHERE id=$2",
                         label, file_id)
    if body.is_primary is not None:
        if body.is_primary:
            await db.execute(
                request,
                "UPDATE file_objects SET is_primary=false, updated_at=now() WHERE tenant_id=$1"
                " AND owner_type=$2 AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4",
                DEFAULT_TENANT, row["owner_type"], row["owner_id"], row["kind"])
        await db.execute(request, "UPDATE file_objects SET is_primary=$1, updated_at=now() WHERE id=$2",
                         body.is_primary, file_id)
    return {"ok": True}


@app.delete("/api/v1/file-objects/{file_id}", status_code=204)
async def retire_file(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    res = await db.execute(
        request,
        "UPDATE file_objects SET is_current=false, is_primary=false, updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2", DEFAULT_TENANT, file_id)
    # 注意：db.execute 返回的是 asyncpg 状态串（'UPDATE 0' 也是真值），不能直接 if not res
    if res.split()[-1] == "0":
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    return Response(status_code=204)


@app.get("/api/v1/file-objects/{file_id}/content")
async def get_file_content(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request,
        "SELECT content_type, file_name, content, object_key, storage FROM file_objects"
        " WHERE tenant_id=$1 AND id=$2", DEFAULT_TENANT, file_id, table=None)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    data = await _load_bytes(dict(row))
    if data is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_BODY_NOT_FOUND"})
    return Response(content=data, media_type=row.get("content_type") or "application/octet-stream",
                    headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/v1/file-objects")
async def list_files(owner_type: str, request: Request, owner_id: Optional[str] = None,
                     kind: Optional[str] = None, user: dict = Depends(_get_current_user)):
    sql = (f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND owner_type=$2"
           " AND coalesce(owner_id,'')=coalesce($3,'') AND is_current")
    params = [DEFAULT_TENANT, owner_type, owner_id]
    if kind:
        sql += " AND kind=$4"
        params.append(kind)
    sql += " ORDER BY is_primary DESC, id"
    rows = await db.fetch(request, sql, *params, table=None)
    return {"items": [_row_to_file(r) for r in rows]}


# ── 单证挂文件 ──────────────────────────────────────────────────────────────

class DocFileIn(BaseModel):
    file_id: Optional[int] = None
    role: str = "product_photo"
    caption: Optional[str] = None
    sort_order: int = 0


@app.get("/api/v1/trade-docs/{doc_id}/files")
async def list_doc_files(doc_id: int, request: Request, user: dict = Depends(_get_current_user)):
    rows = await db.fetch(
        request,
        f"SELECT t.id AS link_id, t.role AS link_role, t.caption AS link_caption,"
        f" t.sort_order AS link_sort_order, {_FILE_COLS_F}"
        " FROM trade_doc_files t JOIN file_objects f ON f.id = t.file_id"
        " WHERE t.tenant_id=$1 AND t.trade_doc_id=$2 ORDER BY t.sort_order, t.id",
        DEFAULT_TENANT, doc_id, table=None)
    items = []
    for r in rows:
        item = _row_to_file({k: v for k, v in dict(r).items() if not k.startswith("link_")})
        item.update({"link_id": int(r["link_id"]), "role": r["link_role"],
                     "caption": r["link_caption"], "sort_order": int(r["link_sort_order"])})
        items.append(item)
    return {"items": items}


@app.post("/api/v1/trade-docs/{doc_id}/files", status_code=201)
async def attach_doc_file(doc_id: int, body: DocFileIn, request: Request,
                          user: dict = Depends(_get_current_user)):
    """引用已有文件到单证；`role='stamp_scan'` 时旧回传件让位（版本化留档）。"""
    if body.file_id is None:
        raise HTTPException(status_code=422, detail={"error": "validation", "code": "FILE_REQUIRED"})
    file_row = await db.fetchrow(
        request, f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, body.file_id, table=None)
    if file_row is None or not file_row["is_current"]:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})

    async with _main._acquire(request) as conn:
        async with conn.transaction():
            if body.role == "stamp_scan":
                await conn.execute(
                    "UPDATE trade_doc_files SET role='stamp_scan_superseded'"
                    " WHERE tenant_id=$1 AND trade_doc_id=$2 AND role='stamp_scan'",
                    DEFAULT_TENANT, doc_id)
            row = await conn.fetchrow(
                "INSERT INTO trade_doc_files (tenant_id, trade_doc_id, file_id, role, caption, sort_order)"
                " VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role, caption, sort_order",
                DEFAULT_TENANT, doc_id, body.file_id, body.role, body.caption, body.sort_order)
    return dict(row)


@app.delete("/api/v1/trade-docs/{doc_id}/files/{link_id}", status_code=204)
async def detach_doc_file(doc_id: int, link_id: int, request: Request,
                          user: dict = Depends(_get_current_user)):
    res = await db.execute(
        request,
        "DELETE FROM trade_doc_files WHERE tenant_id=$1 AND trade_doc_id=$2 AND id=$3",
        DEFAULT_TENANT, doc_id, link_id)
    if res.split()[-1] == "0":
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "LINK_NOT_FOUND"})
    return Response(status_code=204)


@app.post("/api/v1/trade-docs/{doc_id}/files/upload", status_code=201)
async def upload_doc_file(doc_id: int, request: Request,
                          file: UploadFile = File(...),
                          role: str = Form("stamp_scan"),
                          name: str = Form(""),
                          caption: Optional[str] = Form(None),
                          user: dict = Depends(_get_current_user)):
    """上传并挂到单证（客户盖章回传）。`role='stamp_scan'` ⇒ **版本化**：
    新版本上位、旧版本 is_current=false 但**保留**（用户要求覆盖 + 留档）。"""
    data = await file.read()
    label = (name or "").strip() or (file.filename or "回传件")
    row = await _create_file(
        request=request, user=user, owner_type="trade_doc", owner_id=str(doc_id),
        kind=role, media_kind=None, name=label, content=data,
        content_type=file.content_type or "", file_name=file.filename,
        supersede=role in ("stamp_scan", "render_pdf"))
    link = await attach_doc_file(
        doc_id, DocFileIn(file_id=row["id"], role=role, caption=caption), request, user)
    return {"file": row, "link": link}
