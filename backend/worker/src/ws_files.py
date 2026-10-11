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
    MAX_RENDER_PDF_BYTES,
    MEDIA_KIND_LABELS,
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
    "is_current, is_primary, sort_order, uploaded_by, created_at"
)
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
    if d.get("created_at") is not None and hasattr(d["created_at"], "isoformat"):
        d["created_at"] = d["created_at"].isoformat()
    for k in ("id", "team_id", "file_size", "version", "supersedes_id", "sort_order"):
        if d.get(k) is not None:
            d[k] = int(d[k])
    return d


def _fail(exc: FileRuleError) -> HTTPException:
    return HTTPException(status_code=422, detail={
        "error": "validation", "code": exc.code, "detail": exc.detail})


# ── 文件本体：S3（预签名）优先 → R2 binding → inline ───────────────────────
#
# 三种落点存在的理由：
#   · **S3**（生产 R2 / 本地 MinIO）：与 orchestrator **同一段签名代码**，
#     字节走预签名 PUT/GET，浏览器还能直传（不经服务端）。
#   · **R2 binding**：没配 S3 密钥时的平台直连（同样进 R2，只是访问方式不同）。
#   · **inline**：都没配时的兜底（写库）—— 上传是用户显式动作，不能直接失败。
# 无论走哪条，真实落点都写进 `file_objects.storage`，可审计。

def _s3(request: Request) -> Optional[dict]:
    """读请求期绑定里的 S3 配置（Python Workers 在 import 期读不到绑定）。"""
    return s3_config(lambda key: _main._binding(key, request))


async def _js_fetch_bytes(url: str, method: str,
                          data: Optional[bytes] = None,
                          content_type: str = "") -> Optional[bytes]:
    """用 JS `fetch` 访问对象存储（Pyodide 里没有 httpx/requests）。"""
    from js import Uint8Array, fetch  # type: ignore  (Pyodide / Python Workers)
    from pyodide.ffi import to_js  # type: ignore

    opts = {"method": method}
    if content_type:
        opts["headers"] = to_js({"Content-Type": content_type})
    if data is not None:
        opts["body"] = Uint8Array.new(data)
    res = await fetch(url, to_js(opts))
    if not res.ok:
        raise RuntimeError(f"S3 {method} {res.status}")
    if method.upper() == "GET":
        buf = await res.arrayBuffer()
        return bytes(buf.to_py())
    return None


def _r2_bucket():
    """拿 R2 binding（`FILES`）。不在 Pyodide / 没配 binding 时返回 None。

    不在模块顶层 import：本地 pytest 是 CPython，没有 `js` 模块，顶层导入会直接炸掉整个 Worker。
    """
    try:
        from js import FILES  # type: ignore  (Pyodide / Python Workers)
        return FILES
    except Exception:  # noqa: BLE001
        return None


async def _store_bytes(request: Request, key: str, data: bytes,
                       content_type: str) -> tuple[str, Optional[str], Optional[bytes]]:
    """返回 `(storage, object_key, inline_content)` —— 三者如实反映字节的真实落点。"""
    cfg = _s3(request)
    if cfg:
        try:
            url = presign_put_url(
                cfg["endpoint"], cfg["bucket"], key,
                access_key=cfg["access_key"], secret_key=cfg["secret_key"],
                region=cfg["region"], expires=cfg["expires"])
            await _js_fetch_bytes(url, "PUT", data, content_type)
            return "s3", key, None
        except Exception as exc:  # noqa: BLE001
            print(f"[files] S3 put 失败，回退 binding：{type(exc).__name__}: {exc}")

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


async def _load_bytes(request: Request, row) -> Optional[bytes]:
    if row.get("content") is not None:
        return bytes(row["content"])
    if not row.get("object_key"):
        return None
    cfg = _s3(request)
    if cfg:
        try:
            url = presign_get_url(
                cfg["endpoint"], cfg["bucket"], row["object_key"],
                access_key=cfg["access_key"], secret_key=cfg["secret_key"],
                region=cfg["region"], expires=cfg["expires"])
            return await _js_fetch_bytes(url, "GET")
        except Exception as exc:  # noqa: BLE001
            print(f"[files] S3 get 失败，回退 binding：{type(exc).__name__}: {exc}")
    bucket = _r2_bucket()
    if bucket is None:
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
                       content_type: str, file_name: Optional[str], supersede: bool,
                       pre_uploaded: Optional[tuple[str, str]] = None) -> dict:
    try:
        validate_upload(owner_type=owner_type, kind=kind, media_kind=media_kind, name=name,
                        content_type=content_type, size=len(content))
    except FileRuleError as exc:
        raise _fail(exc)

    sha = hashlib.sha256(content).hexdigest()
    key = object_key(tenant_id=DEFAULT_TENANT, owner_type=owner_type, owner_id=owner_id,
                     kind=kind, media_kind=media_kind, sha256=sha,
                     content_type=content_type, file_name=file_name)
    if pre_uploaded is not None:
        # 浏览器已直传对象存储（预签名 PUT）→ 只登记元数据，字节不再经服务端
        storage, object_key_value, inline = pre_uploaded[0], pre_uploaded[1], None
    else:
        storage, object_key_value, inline = await _store_bytes(request, key, content, content_type)
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
        f" ORDER BY {_FILE_ORDER_BY}", DEFAULT_TENANT, product_key,
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
    caption: Optional[str] = None
    sort_order: Optional[int] = None


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
    if body.sort_order is not None:
        # 排序值是人工维护的展示位次：给个明确上界，防误填天文数字把图排到看不见的地方
        if body.sort_order < 0 or body.sort_order > _MAX_SORT_ORDER:
            raise _fail(FileRuleError(
                "SORT_ORDER_OUT_OF_RANGE",
                f"排序值需在 0 ~ {_MAX_SORT_ORDER} 之间"))
        await db.execute(request,
                         "UPDATE file_objects SET sort_order=$1, updated_at=now() WHERE id=$2",
                         body.sort_order, file_id)
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
    data = await _load_bytes(request, dict(row))
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
    sql += f" ORDER BY {_FILE_ORDER_BY}"
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
    """引用已有文件到单证；`role` 属于版本化角色（`stamp_scan` 盖章回传 /
    `render_pdf` 系统出的 PDF）时，旧的"当前件"链接让位（改挂 `<role>_superseded`，
    **不物理删**，历史可回溯）。"""
    if body.file_id is None:
        raise HTTPException(status_code=422, detail={"error": "validation", "code": "FILE_REQUIRED"})
    file_row = await db.fetchrow(
        request, f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND id=$2",
        DEFAULT_TENANT, body.file_id, table=None)
    if file_row is None or not file_row["is_current"]:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})

    async with _main._acquire(request) as conn:
        async with conn.transaction():
            if body.role in ("stamp_scan", "render_pdf"):
                # 版本化角色：旧链接改挂 `<role>_superseded`，行保留可追溯。
                # 让位只针对**同一个 role**：盖章件与系统 PDF 各自只留一条"当前"。
                await conn.execute(
                    "UPDATE trade_doc_files SET role=$1"
                    " WHERE tenant_id=$2 AND trade_doc_id=$3 AND role=$4",
                    f"{body.role}_superseded", DEFAULT_TENANT, doc_id, body.role)
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


# ── 自动出 PDF（Cloudflare Browser Rendering）→ 复用上面的落档链路 ──────────────
#
# 与 orchestrator `app/api/files.py` 同契约、同路径、同字段（route-parity 卡着）。
# 生产优先用 **browser binding**（`BROWSER.quickAction("pdf", …)`，**不需要任何 token**）；
# 没声明 binding 时退到 REST（需配 token）；两者都没有 → **503**（绝不假装成功）。
# 安全：入参 HTML 会被我们账号里的无头浏览器渲染 ⇒ 必过共享内核
# `validate_render_html`（拒脚本/事件属性/外链资源，防把渲染器变成出网代理）。


def _browser_binding(request: Request):
    """拿 browser binding（`BROWSER`）。没声明（或不在 Pyodide 里）返回 None。

    绑定是**对象**不是字符串，所以不能用 `_binding(...) or None` 之外的判断；
    `main._binding` 缺失时返回 `""`，正好可以和绑定对象区分开。
    """
    binding = _main._binding("BROWSER", request)
    return binding if binding else None


async def _binding_quick_action_pdf(binding, html: str) -> bytes:
    """用 binding 调 Quick Action `pdf`，拿回字节。

    照抄仓库既有的 Pyodide 互操作写法（见 `_js_fetch_bytes`）：JS Promise 直接 await，
    `arrayBuffer()` 之后 `.to_py()` 才是 Python bytes。
    """
    from pyodide.ffi import to_js  # type: ignore  (Pyodide / Python Workers)

    res = await binding.quickAction("pdf", to_js({"html": html}))
    buf = await res.arrayBuffer()
    return bytes(buf.to_py())


async def _rest_quick_action_pdf(cfg: dict, html: str) -> bytes:
    """REST 兜底（与 orchestrator 的 `_render_pdf_via_rest` 同形状）。"""
    from js import fetch  # type: ignore  (Pyodide / Python Workers)
    from pyodide.ffi import to_js  # type: ignore

    opts = {
        "method": "POST",
        "headers": to_js({"Authorization": f"Bearer {cfg['token']}",
                          "Content-Type": "application/json"}),
        "body": _json.dumps({"html": html}),
    }
    res = await fetch(cfg["url"], to_js(opts))
    status = int(res.status)
    if status != 200:
        raise HTTPException(status_code=502, detail={
            "error": "upstream", "code": "PDF_RENDER_FAILED",
            "detail": f"Browser Rendering 返回 {status}",
        })
    buf = await res.arrayBuffer()
    return bytes(buf.to_py())


async def _render_pdf_bytes(request: Request, html: str) -> tuple[bytes, str]:
    """返回 `(pdf_bytes, renderer)`；`renderer` 是 `binding` | `rest`（如实记录用哪条路）。"""
    binding = _browser_binding(request)
    if binding is not None:
        try:
            return await _binding_quick_action_pdf(binding, html), "binding"
        except Exception as exc:  # noqa: BLE001
            # binding 已声明却失败 ⇒ 如实 502；不再偷偷换 REST（那会掩盖真实故障）
            print(f"[files] browser binding 出 PDF 失败：{type(exc).__name__}: {exc}")
            raise HTTPException(status_code=502, detail={
                "error": "upstream", "code": "PDF_RENDER_FAILED",
                "detail": f"Browser Rendering（binding）失败：{type(exc).__name__}",
            }) from exc

    cfg = render_pdf_rest_config(lambda key: _main._binding(key, request))
    if cfg is None:
        raise HTTPException(status_code=503, detail={
            "error": "unavailable", "code": "PDF_RENDERER_NOT_CONFIGURED",
            "detail": RENDERER_NOT_CONFIGURED_DETAIL,
        })
    return await _rest_quick_action_pdf(cfg, html), "rest"


class RenderPdfIn(BaseModel):
    html: str
    name: Optional[str] = None


@app.post("/api/v1/trade-docs/{doc_id}/pdf", status_code=201)
async def render_doc_pdf(doc_id: int, body: RenderPdfIn, request: Request,
                         user: dict = Depends(_get_current_user)):
    """把预览同源的单证 HTML 交给无头浏览器出 PDF，并**落档**到这张单证上。

    - 复用盖章回传那套链路：`_create_file(kind='render_pdf', supersede=True)`
      → `attach_doc_file(role='render_pdf')` ⇒ 再归档 = 新版本上位、旧版挂
      `render_pdf_superseded` 留档（**不物理删**）。
    - 未配置渲染器 → 503；上游失败/不是 PDF → 502；HTML 含脚本或外链 → 422。
    """
    try:
        validate_render_html(body.html)
    except FileRuleError as exc:
        raise _fail(exc)

    data, renderer = await _render_pdf_bytes(request, body.html)
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
        request=request, user=user, owner_type="trade_doc", owner_id=str(doc_id),
        kind=RENDER_PDF_KIND, media_kind=None, name=name, content=data,
        content_type="application/pdf", file_name=name, supersede=True)
    link = await attach_doc_file(
        doc_id, DocFileIn(file_id=row["id"], role=RENDER_PDF_KIND), request, user)
    return {"file": row, "link": link, "renderer": renderer,
            "bytes": len(data), "storage": row["storage"]}


async def resolve_photo_refs(request: Request, data: dict) -> dict:
    """把单证 `product_photos` 里的 `{file_id}` 引用解析成 data URI。

    由 `main.get_trade_doc_render_data` 在**装配层**调用：渲染器的图片白名单只认
    `data:` 与 `http(s)`（防注入设计，不放开），而 `{file_id}` 不是图片源 ——
    在这里解析，渲染器一行都不用改。取不到字节（未上线/R2 读失败）就跳过该条，不印坏图。
    """
    from kaas_common.files import is_file_ref, to_data_uri

    photos = data.get("product_photos")
    if not isinstance(photos, list) or not photos:
        return data
    resolved = []
    for entry in photos:
        if not is_file_ref(entry):
            resolved.append(entry)
            continue
        row = await db.fetchrow(
            request,
            "SELECT name, content_type, file_name, content, object_key, storage FROM file_objects"
            " WHERE tenant_id=$1 AND id=$2 AND is_current",
            DEFAULT_TENANT, int(entry["file_id"]))
        if not row:
            continue
        blob = await _load_bytes(request, row)
        if blob is None:
            continue
        resolved.append({
            "image": to_data_uri(row.get("content_type"), blob, row.get("file_name")),
            "caption": entry.get("caption") or row.get("name") or "",
        })
    data["product_photos"] = resolved
    return data


# ── 直传（预签名）：字节不过服务端 ────────────────────────────────────────
# 与 orchestrator 同契约（`app/api/files.py`）：配好 S3 时返回预签名 PUT，
# 浏览器直连对象存储；没配就 `{"configured": false}`，前端回退 multipart 代理上传。

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


class RegisterIn(PresignIn):
    supersede: bool = False


def _validate_direct(body: PresignIn) -> str:
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


@app.post("/api/v1/file-objects/presign")
async def presign_upload(body: PresignIn, request: Request, user: dict = Depends(_get_current_user)):
    sha = _validate_direct(body)
    cfg = _s3(request)
    if not cfg:
        return {"configured": False}
    key = object_key(tenant_id=DEFAULT_TENANT, owner_type=body.owner_type, owner_id=body.owner_id,
                     kind=body.kind, media_kind=body.media_kind, sha256=sha,
                     content_type=body.content_type, file_name=body.file_name)
    url = presign_put_url(
        cfg["endpoint"], cfg["bucket"], key, access_key=cfg["access_key"],
        secret_key=cfg["secret_key"], region=cfg["region"], expires=cfg["expires"])
    return {"configured": True, "upload_url": url, "object_key": key,
            "method": "PUT", "expires_in": cfg["expires"]}


@app.post("/api/v1/file-objects/register", status_code=201)
async def register_upload(body: RegisterIn, request: Request, user: dict = Depends(_get_current_user)):
    sha = _validate_direct(body)
    key = object_key(tenant_id=DEFAULT_TENANT, owner_type=body.owner_type, owner_id=body.owner_id,
                     kind=body.kind, media_kind=body.media_kind, sha256=sha,
                     content_type=body.content_type, file_name=body.file_name)
    return await _create_file(
        request=request, user=user, owner_type=body.owner_type, owner_id=body.owner_id,
        kind=body.kind, media_kind=body.media_kind, name=body.name, content=b"",
        content_type=body.content_type, file_name=body.file_name, supersede=body.supersede,
        pre_uploaded=("s3", key))


@app.get("/api/v1/file-objects/{file_id}/url")
async def get_file_url(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    """短时效直链（预签名 GET）；没配 S3 就明确说不可用。"""
    row = await db.fetchrow(
        request,
        "SELECT object_key, content_type, file_name FROM file_objects"
        " WHERE tenant_id=$1 AND id=$2 AND is_current", DEFAULT_TENANT, file_id)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    cfg = _s3(request)
    if not (cfg and row.get("object_key")):
        return {"configured": False, "reason": "该文件不在对象存储里（inline 或未上传）"}
    url = presign_get_url(
        cfg["endpoint"], cfg["bucket"], row["object_key"], access_key=cfg["access_key"],
        secret_key=cfg["secret_key"], region=cfg["region"], expires=cfg["expires"])
    return {"configured": True, "url": url, "expires_in": cfg["expires"]}
