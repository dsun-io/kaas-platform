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
    allowed_html_hosts,
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

from kaas_common.workstation.product_scope import REASON_NO_TEAM, product_info_access
from kaas_common.workstation.scope import is_admin_role

app = _main.app
_get_current_user = _main._get_current_user
DEFAULT_TENANT = _main.DEFAULT_TENANT
db = _main.db


# ── Q6 的行级团队谓词（与 orchestrator 侧同一口径，走同一把尺）────────────────

def _team_scope(user: dict, next_index: int, *, col: str = "team_id") -> tuple[str, list]:
    """返回 `(SQL 片段, 追加参数)`：**用户创建的业务数据仅团队内部可见**（Q6）。

    asyncpg 用**位置占位符**，所以约定：片段里用 `$next_index`，参数**追加到列表末尾** ——
    与「片段拼在 WHERE 末尾」严格对应。调用方先算 `next_index = len(params) + 1`。

    - **管理员** ⇒ `("", [])`：不加谓词，看得见全部（含历史 `team_id IS NULL` 行，D3/D4）；
    - **有团队** ⇒ `AND <col>=$n` + `[team]`；
    - **无团队** ⇒ **403 `NO_TEAM`**（§1.5 的次序）。

    角色判定用共享内核 `is_admin_role`，与 orchestrator 的 `_team_scope` 是同一把尺。
    """
    if is_admin_role(user.get("role")):
        return "", []
    team = user.get("team_id")
    if team is None:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "code": "NO_TEAM"})
    return f" AND {col}=${next_index}", [team]


def _team_scope_soft(user: dict, next_index: int, *, col: str = "team_id") -> tuple[str, list]:
    """不抛错版：**只给「公开层 + 私有层混在一起」的端点**用（如产品列表：定义人人可读）。

    无团队 ⇒ 谓词为 `= NULL`（恒不成立）⇒ 私有部分为空，**公开层照旧返回**
    （Q6 两层不许压平）。与 orchestrator 的 `_team_scope_soft` 同口径。
    """
    if is_admin_role(user.get("role")):
        return "", []
    return f" AND {col}=${next_index}", [user.get("team_id")]


def _require_profile_visible(user: dict, row) -> None:
    """产品基础信息的可见性判定（与 orchestrator 的 `_require_profile_visible` 同语义）。

    复用共享内核 `product_info_access`（task-19 那把尺）：本团队 / 管理员 ⇒ 放行；
    别团队、历史 NULL（非管理员）⇒ **404**（同一个错误码，对外不可区分）；
    访问者无团队 ⇒ **403 `NO_TEAM`**。
    """
    decision = product_info_access(
        role=user.get("role"), viewer_team_id=user.get("team_id"),
        row_team_id=(row.get("team_id") if row is not None else None))
    if decision.allowed:
        return
    if decision.reason == REASON_NO_TEAM:
        raise HTTPException(status_code=403, detail={"error": "forbidden", "code": "NO_TEAM"})
    raise HTTPException(status_code=404,
                        detail={"error": "not_found", "code": "PROFILE_NOT_FOUND"})

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


def _r2_bucket(request=None):
    """拿 R2 binding（`FILES`）。

    2026-10-17 实测：Python Workers 的绑定**不在 `js` 全局**（`from js import FILES` 报
    ImportError），而是挂在 ASGI scope 的 `env` 上（`request.scope["env"].FILES`）。
    因此优先从请求里取；取不到再退回旧的 `js` 全局（兼容旧 runtime）。

    不在模块顶层 import：本地 pytest 是 CPython，没有 `js` 模块，顶层导入会直接炸掉整个 Worker。
    """
    try:
        env = request.scope.get("env") if request is not None else None
        bucket = getattr(env, "FILES", None) if env is not None else None
        if bucket is not None:
            return bucket
    except Exception:  # noqa: BLE001
        pass
    try:
        from js import FILES  # type: ignore  (旧 runtime 的全局绑定)
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

    bucket = _r2_bucket(request)
    if bucket is not None:
        try:
            # Pyodide（真实 Workers 是 sys.platform == "emscripten"）：bytes → Uint8Array
            # 用 to_js 最稳；本地 CPython 即使装了 pyodide 包也不能走这条（to_js 返回 bytes），
            # 所以按平台判定，测试环境仍走 Uint8Array.new。
            import sys as _sys
            if _sys.platform == "emscripten":
                from pyodide.ffi import to_js  # type: ignore

                body = to_js(data)
                opts = to_js({"httpMetadata": {"contentType": content_type}})
            else:
                from js import Uint8Array  # type: ignore

                body = Uint8Array.new(data)
                opts = {"httpMetadata": {"contentType": content_type}}
            await bucket.put(key, body, opts)
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
    bucket = _r2_bucket(request)
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


async def _current_file(conn, user: dict, tenant_id: str, owner_type: str, owner_id: Optional[str],
                        kind: str, media_kind: Optional[str] = None):
    sql = (f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND owner_type=$2"
           " AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4")
    params = [tenant_id, owner_type, owner_id, kind]
    if media_kind is not None:
        sql += " AND coalesce(media_kind,'')=coalesce($5,'')"
        params.append(media_kind)
    frag, extra = _team_scope(user, len(params) + 1)     # Q6：只在本团队内找"当前件"
    sql += frag
    params.extend(extra)
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
                cur = await _current_file(conn, user, DEFAULT_TENANT, owner_type, owner_id,
                                          kind, media_kind)
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
    # ⚠️ 本端点混着"人人可读的定义"与"仅团队可见的信息" ⇒ 用 **soft** 版：
    # 无团队时**不能** 403（否则把 Q6 两层压平），而是私有部分为空、定义照旧返回。
    media_frag, media_extra = _team_scope_soft(user, 2)
    rows = await db.fetch(
        request,
        "SELECT owner_id, COUNT(*) AS n FROM file_objects WHERE tenant_id=$1"
        " AND owner_type='product' AND kind='product_photo' AND is_current"
        + media_frag + " GROUP BY owner_id",
        DEFAULT_TENANT, *media_extra, table=None)
    media = {r["owner_id"]: int(r["n"]) for r in rows}
    prof_frag, prof_extra = _team_scope_soft(user, 2)
    profs = await db.fetch(
        request, "SELECT product_key, info FROM product_profiles WHERE tenant_id=$1"
        + prof_frag,
        DEFAULT_TENANT, *prof_extra, table="product_profiles")
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
        request, "SELECT product_key, info, updated_at, team_id FROM product_profiles"
        " WHERE tenant_id=$1 AND product_key=$2", DEFAULT_TENANT, product_key,
        table="product_profiles")
    # 行存在 ⇒ 按团队判可见性（Q1=B：用户创建的产品基础信息一律团队私有）；
    # 与 orchestrator 的 `_require_profile_visible` 同一语义（同一个错误码，对外不可区分）。
    if row is not None:
        _require_profile_visible(user, row)
    # `info` 有两种形状：登记过 jsonb 的列会被 dbjson 解码成 dict；漏登记/未来新增的读取点
    # 可能拿到 **JSON 字符串** —— 那时 `dict(str)` 会抛 500（一个只读探针把整页打成错误页，
    # 代价与收益完全不成比例）。**根因已由 dbjson 登记修复**（`product_profiles.info` 进了
    # `JSONB_COLS`）；这里是**防御**：两种形状都收，坏值回落 `{}` 而不是 500。
    info = row.get("info") if row else None
    if isinstance(info, str):
        try:
            info = _json.loads(info)
        except (TypeError, ValueError):
            info = {}
    return {"product_key": product_key,
            "info": dict(info) if isinstance(info, dict) else {},
            "updated_at": row["updated_at"].isoformat() if row and row.get("updated_at") else None}


@app.put("/api/v1/products/{product_key}/profile")
async def put_profile(product_key: str, body: ProfileIn, request: Request,
                      user: dict = Depends(_get_current_user)):
    # P9：唯一键按团队收敛为 (tenant_id, COALESCE(team_id,0), product_key)
    # ⇒ 写入必须带 team（否则都落进 team_key=0 桶），且 ON CONFLICT 目标要与
    #    索引表达式逐字一致、表达式要加括号（PG16 文法）。
    await db.execute(
        request,
        "INSERT INTO product_profiles (tenant_id, team_id, product_key, info, updated_by)"
        " VALUES ($1,$2,$3,CAST($4 AS jsonb),$5)"
        " ON CONFLICT (tenant_id, (COALESCE(team_id, 0)), product_key) DO UPDATE"
        " SET info=EXCLUDED.info,"
        " updated_by=EXCLUDED.updated_by, updated_at=now()",
        DEFAULT_TENANT, user.get("team_id"), product_key,
        _json.dumps(body.info, ensure_ascii=False),
        str(user.get("id") or "") or None)
    return await get_profile(product_key, request, user)


# ── 产品图片 ────────────────────────────────────────────────────────────────

@app.get("/api/v1/products/{product_key}/media")
async def list_media(product_key: str, request: Request, user: dict = Depends(_get_current_user)):
    rows = await db.fetch(
        request,
        f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND owner_type='product'"
        " AND owner_id=$2 AND kind='product_photo' AND is_current"
        + _team_scope(user, 3)[0]
        + f" ORDER BY {_FILE_ORDER_BY}", DEFAULT_TENANT, product_key,
        *_team_scope(user, 3)[1], table=None)
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
        request, f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND id=$2"
        f"{_team_scope(user, 3, col='team_id')[0]}",
        DEFAULT_TENANT, file_id, *_team_scope(user, 3, col='team_id')[1], table=None)
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    if body.name is not None:
        label = body.name.strip()
        if not label:
            raise _fail(FileRuleError("NAME_REQUIRED", "名称不能为空"))
        if len(label) > 80:
            raise _fail(FileRuleError("NAME_TOO_LONG", "名称最长 80 个字符"))
        _frag, _extra = _team_scope(user, 3)
        await db.execute(request,
                         "UPDATE file_objects SET name=$1, updated_at=now()"
                         f" WHERE id=$2{_frag}",
                         label, file_id, *_extra)
    if body.is_primary is not None:
        if body.is_primary:
            # 只降**本团队**的其它主图（别团队的图不该被我们顶掉）
            _frag, _extra = _team_scope(user, 5)
            await db.execute(
                request,
                "UPDATE file_objects SET is_primary=false, updated_at=now() WHERE tenant_id=$1"
                " AND owner_type=$2 AND coalesce(owner_id,'')=coalesce($3,'') AND kind=$4"
                + _frag,
                DEFAULT_TENANT, row["owner_type"], row["owner_id"], row["kind"], *_extra)
        _frag, _extra = _team_scope(user, 3)
        await db.execute(request,
                         "UPDATE file_objects SET is_primary=$1, updated_at=now()"
                         f" WHERE id=$2{_frag}",
                         body.is_primary, file_id, *_extra)
    if body.sort_order is not None:
        # 排序值是人工维护的展示位次：给个明确上界，防误填天文数字把图排到看不见的地方
        if body.sort_order < 0 or body.sort_order > _MAX_SORT_ORDER:
            raise _fail(FileRuleError(
                "SORT_ORDER_OUT_OF_RANGE",
                f"排序值需在 0 ~ {_MAX_SORT_ORDER} 之间"))
        _frag, _extra = _team_scope(user, 3)
        await db.execute(request,
                         "UPDATE file_objects SET sort_order=$1, updated_at=now()"
                         f" WHERE id=$2{_frag}",
                         body.sort_order, file_id, *_extra)
    return {"ok": True}


@app.delete("/api/v1/file-objects/{file_id}", status_code=204)
async def retire_file(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    _frag, _extra = _team_scope(user, 3)
    res = await db.execute(
        request,
        "UPDATE file_objects SET is_current=false, is_primary=false, updated_at=now()"
        " WHERE tenant_id=$1 AND id=$2" + _frag, DEFAULT_TENANT, file_id, *_extra)
    # 注意：db.execute 返回的是 asyncpg 状态串（'UPDATE 0' 也是真值），不能直接 if not res
    if res.split()[-1] == "0":
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    return Response(status_code=204)


@app.get("/api/v1/file-objects/{file_id}/content")
async def get_file_content(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    row = await db.fetchrow(
        request,
        "SELECT content_type, file_name, content, object_key, storage FROM file_objects"
        " WHERE tenant_id=$1 AND id=$2" + _team_scope(user, 3)[0],
        DEFAULT_TENANT, file_id, *_team_scope(user, 3)[1], table=None)
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
    _frag, _extra = _team_scope(user, len(params) + 1)
    sql += _frag
    params.extend(_extra)
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
        " WHERE t.tenant_id=$1 AND t.trade_doc_id=$2"
        + _team_scope(user, 3, col="f.team_id")[0]
        + " ORDER BY t.sort_order, t.id",
        DEFAULT_TENANT, doc_id, *_team_scope(user, 3, col="f.team_id")[1], table=None)
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
        request, f"SELECT {_META_COLS} FROM file_objects WHERE tenant_id=$1 AND id=$2"
        + _team_scope(user, 3)[0],
        DEFAULT_TENANT, body.file_id, *_team_scope(user, 3)[1], table=None)
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
        # 外链白名单请求期读（`PDF_HTML_ALLOWED_HOSTS`，默认自家域名）。
        # Python Worker 在 import 期读不到 vars/绑定 ⇒ 必须走 `main._binding`。
        validate_render_html(
            body.html, allowed_html_hosts(lambda key: _main._binding(key, request)))
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


async def resolve_photo_refs(request: Request, data: dict, user: dict = None) -> dict:
    """把单证 `product_photos` 里的 `{file_id}` 引用解析成 data URI。

    由 `main.get_trade_doc_render_data` 在**装配层**调用：渲染器的图片白名单只认
    `data:` 与 `http(s)`（防注入设计，不放开），而 `{file_id}` 不是图片源 ——
    在这里解析，渲染器一行都不用改。取不到字节（未上线/R2 读失败）就跳过该条，不印坏图。

    团队谓词（2026-10-12，task-6）：把 `user` 传进来，按 `file_objects.team_id` 过滤
    —— 本团队取图，别团队跳过不印坏图。`user=None` 时跳过团队判定（兼容旧调用方）。
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
        # 团队谓词：user=None 时跳过判定（兼容旧调用方）
        team_frag, team_extra = _team_scope(user, 3) if user is not None else ("", [])
        row = await db.fetchrow(
            request,
            "SELECT name, content_type, file_name, content, object_key, storage FROM file_objects"
            " WHERE tenant_id=$1 AND id=$2 AND is_current" + team_frag,
            DEFAULT_TENANT, int(entry["file_id"]), *team_extra,
            table=None)
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


@app.get("/api/v1/file-objects/_r2_debug")
async def r2_debug(request: Request, user: dict = Depends(_get_current_user)):
    """线上自检：R2 binding 是否可见 + 一次测试 put 的真实错误（排查完可删）。"""
    import sys as _sys
    out = {"platform": _sys.platform, "binding": False, "put_ok": False}
    try:
        from js import FILES  # type: ignore
        out["binding"] = True
        out["bucket_type"] = str(type(FILES))
        try:
            if _sys.platform == "emscripten":
                from pyodide.ffi import to_js  # type: ignore
                body = to_js(b"kaas-debug")
                opts = to_js({"httpMetadata": {"contentType": "text/plain"}})
            else:
                body = b"kaas-debug"
                opts = {}
            await FILES.put("_debug/r2-test.txt", body, opts)
            out["put_ok"] = True
        except Exception as exc:  # noqa: BLE001
            out["put_error"] = f"{type(exc).__name__}: {exc}"
    except Exception as exc:  # noqa: BLE001
        out["import_error"] = f"{type(exc).__name__}: {exc}"
    return out


@app.post("/api/v1/file-objects/upload", status_code=201)
async def upload_file_object(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    owner_type: str = Form("customer"),
    owner_id: Optional[str] = Form(None),
    kind: str = Form("other"),
    media_kind: Optional[str] = Form(None),
    user: dict = Depends(_get_current_user),
):
    """通用 multipart 上传（2026-10-17 新增，供客户流失拒绝文件等使用）。

    字节落点与产品图/印章同一套：**S3 预签名 → R2 binding（`FILES`）→ inline 回退**，
    行里如实记录 `storage`。R2 无需 S3 密钥即可工作（用户口径：R2 能实现就优先 R2）。
    """
    content = await file.read()
    return await _create_file(
        request=request, user=user, owner_type=owner_type,
        owner_id=(owner_id or None), kind=kind, media_kind=media_kind or None,
        name=name, content=content,
        content_type=file.content_type or "application/octet-stream",
        file_name=file.filename, supersede=False,
    )


@app.get("/api/v1/file-objects/{file_id}/url")
async def get_file_url(file_id: int, request: Request, user: dict = Depends(_get_current_user)):
    """短时效直链（预签名 GET）；没配 S3 就明确说不可用。"""
    row = await db.fetchrow(
        request,
        "SELECT object_key, content_type, file_name FROM file_objects"
        " WHERE tenant_id=$1 AND id=$2 AND is_current" + _team_scope(user, 3)[0],
        DEFAULT_TENANT, file_id, *_team_scope(user, 3)[1])
    if row is None:
        raise HTTPException(status_code=404, detail={"error": "not_found", "code": "FILE_NOT_FOUND"})
    cfg = _s3(request)
    if not (cfg and row.get("object_key")):
        return {"configured": False, "reason": "该文件不在对象存储里（inline 或未上传）"}
    url = presign_get_url(
        cfg["endpoint"], cfg["bucket"], row["object_key"], access_key=cfg["access_key"],
        secret_key=cfg["secret_key"], region=cfg["region"], expires=cfg["expires"])
    return {"configured": True, "url": url, "expires_in": cfg["expires"]}
