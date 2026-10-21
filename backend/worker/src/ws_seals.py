"""公司公章（租户级）—— 单证签章区盖章用（Worker 镜像 · 生产对齐）。

与 orchestrator 的 `app/api/company_seals.py` 对齐，但用 asyncpg 直连
（Worker 的 Hyperdrive 连接模式）。

为什么这个模块能直接移植
------------------------
2026-09-30 的设计裁决把**图像处理全部挪到前端 Canvas**，后端只剩「收 PNG 字节
+ 校验 + 落库」；校验用共享内核 `kaas_common.trade_doc.png` 的**纯 Python**
IHDR 解析。所以 orchestrator 与 Worker 行为天然一致 —— 不需要 Pillow，
Pyodide 环境也不用装任何 C 扩展。

铁律（与 orchestrator 逐条一致）
--------------------------------
- **权限**：仅 internal / admin 可管理；客户端账号一律 403 `INTERNAL_ONLY`。
- **取图先校验 tenant_id**：别家的章一律 404，不泄露存在性（防 ID 枚举越权）。
- **默认章唯一**：部分唯一索引兜底，切换时先清后设；默认章不许直接删
  （要先转移默认，避免单证突然没章可盖）。

端点：
- POST   /api/v1/tenant/company-seals                上传（multipart；PNG）
- GET    /api/v1/tenant/company-seals                列表（元数据 + preview_url）
- GET    /api/v1/tenant/company-seals/{id}/image     取 PNG（校验 tenant 后回字节）
- PUT    /api/v1/tenant/company-seals/{id}/default   设为默认章
- DELETE /api/v1/tenant/company-seals/{id}           删除（默认章需先转移）
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response

from kaas_common.trade_doc import PngError, validate_seal_image

import main as _main

app = _main.app
_get_current_user = _main._get_current_user
_acquire = _main._acquire
DEFAULT_TENANT = _main.DEFAULT_TENANT

MAX_UPLOAD_BYTES = 5 * 1024 * 1024      # 5MB 足够印章图
ALLOWED_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/bmp", "image/x-ms-bmp"}

# 公章是公司资产，只有内部账号可管 —— 与 AuthContext.is_internal()/is_admin() 同口径
_INTERNAL_ACCOUNT = "internal"
_ADMIN_ROLES = ("system_admin", "admin")


# ── Helpers ─────────────────────────────────────────────────────────────────

def _require_internal(user: dict) -> None:
    """公章是公司资产，只有内部账号可管；客户账号一律拒绝。"""
    if not (user.get("account_type") == _INTERNAL_ACCOUNT or user.get("role") in _ADMIN_ROLES):
        raise HTTPException(status_code=403, detail={
            "error": "forbidden", "code": "INTERNAL_ONLY",
            "detail": "公章管理仅限内部账号",
        })


def _tenant_of(user: dict) -> str:
    tid = user.get("tenant_id")
    return tid if isinstance(tid, str) and tid else DEFAULT_TENANT


async def _require_seal_reader(request: Request, user: dict) -> None:
    """C27（F4）：公章**读**收紧为「团队管理员 或 internal」。

    - internal（含非管理员，D1/D4）⇒ 放行；
    - customer 团队管理员（团队创建者）⇒ 放行；
    - 普通成员 / 无团队 / 别团队客户 ⇒ 403 `TEAM_ADMIN_REQUIRED`。
    写侧继续用 `_main._require_team_admin`（口径不变）；签名 `render-content`
    走令牌校验、不受角色影响。
    """
    from kaas_common.workstation.scope import is_admin_role

    if user.get("account_type") == _INTERNAL_ACCOUNT or is_admin_role(user.get("role")):
        return
    await _main._require_team_admin(request, user)


def _validate_png(data: bytes) -> tuple[int, int]:
    """公章图校验（内核纯 Python）：非空、≤5MB、PNG 魔数 + IHDR 尺寸。"""
    try:
        return validate_seal_image(data)
    except PngError as exc:
        raise HTTPException(status_code=422, detail={
            "error": "validation", "code": exc.code, "detail": exc.detail,
        })


def _to_meta(row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "mime": row["mime"],
        "width": row["width"],
        "height": row["height"],
        "is_default": bool(row["is_default"]),
        "created_by": row["created_by"],
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
        "preview_url": f"/api/v1/tenant/company-seals/{row['id']}/image",
    }


async def _get_or_404(conn, tenant_id: str, seal_id: int):
    """取章并强制租户过滤 —— 越权防线：别家的章一律 404（不泄露存在性）。"""
    row = await conn.fetchrow(
        "SELECT * FROM tenant_company_seals WHERE tenant_id=$1 AND id=$2",
        tenant_id, seal_id,
    )
    if row is None:
        raise HTTPException(status_code=404, detail={
            "error": "not_found", "code": "SEAL_NOT_FOUND",
        })
    return row


_META_COLS = "id, tenant_id, name, mime, width, height, is_default, created_by, created_at"


# ── 端点 ─────────────────────────────────────────────────────────────────────

@app.post("/api/v1/tenant/company-seals", status_code=201)
async def upload_seal(
    request: Request,
    file: UploadFile = File(...),
    name: str = Form(...),
    set_default: bool = Form(False),
    user: dict = Depends(_get_current_user),
):
    """上传公章：前端 Canvas 已归一化为 PNG，后端纯校验 + 落库。"""
    # 用户 2026-10-18：公章归企业抬头，只有团队管理员可改。
    await _main._require_team_admin(request, user)
    tenant_id = _tenant_of(user)

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

    width, height = _validate_png(data)
    row_id: Optional[int] = None

    async with _acquire(request) as conn:
        async with conn.transaction():
            exists = await conn.fetchval(
                "SELECT id FROM tenant_company_seals WHERE tenant_id=$1 AND name=$2",
                tenant_id, name,
            )
            if exists is not None:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "SEAL_NAME_TAKEN",
                    "detail": f"已存在同名章「{name}」，请改名或先删除",
                })

            # 显式 set_default → 先清后设（部分唯一索引要求同一事务内唯一）
            if set_default:
                await conn.execute(
                    "UPDATE tenant_company_seals SET is_default=false, updated_at=now()"
                    " WHERE tenant_id=$1", tenant_id)
                is_default = True
            else:
                # 首枚章自动成为默认
                any_default = await conn.fetchval(
                    "SELECT 1 FROM tenant_company_seals WHERE tenant_id=$1 AND is_default",
                    tenant_id)
                is_default = any_default is None

            row_id = await conn.fetchval(
                "INSERT INTO tenant_company_seals"
                " (tenant_id, name, mime, png_bytes, width, height, is_default, created_by)"
                " VALUES ($1,$2,'image/png',$3,$4,$5,$6,$7) RETURNING id",
                tenant_id, name, data, width, height, is_default, str(user.get("id")),
            )
            row = await conn.fetchrow(
                f"SELECT {_META_COLS} FROM tenant_company_seals WHERE id=$1", row_id)
    return _to_meta(row)


@app.get("/api/v1/tenant/company-seals")
async def list_seals(
    request: Request,
    user: dict = Depends(_get_current_user),
):
    """列表只回元数据 + 预览 URL，不回裸字节（取图走专用端点，便于缓存与鉴权）。"""
    await _require_seal_reader(request, user)
    tenant_id = _tenant_of(user)
    async with _acquire(request) as conn:
        rows = await conn.fetch(
            f"SELECT {_META_COLS} FROM tenant_company_seals WHERE tenant_id=$1"
            f" ORDER BY is_default DESC, id",
            tenant_id,
        )
    return {"items": [_to_meta(r) for r in rows]}


@app.get("/api/v1/tenant/company-seals/{seal_id}/image")
async def get_seal_image(
    request: Request,
    seal_id: int,
    user: dict = Depends(_get_current_user),
):
    """回 PNG 字节。tenant 校验在 _get_or_404 内 —— 越权看图 = 404。"""
    await _require_seal_reader(request, user)
    tenant_id = _tenant_of(user)
    async with _acquire(request) as conn:
        row = await _get_or_404(conn, tenant_id, seal_id)
    return Response(
        content=bytes(row["png_bytes"]),
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": f'inline; filename="seal-{seal_id}.png"',
        },
    )


@app.get("/api/v1/tenant/company-seals/{seal_id}/render-content")
async def get_seal_render_content(
    request: Request,
    seal_id: int,
    t: str = Query(""),
):
    """A4：给渲染器用的短期直链（令牌即授权，`<img>` 不带登录头也能加载）。

    令牌由装配层（`main._apply_default_seal` → `ws_files._asset_url`）在**已授权**
    渲染数据请求里签发，TTL 900s；`seal_id` 与令牌绑定，换 id 即签名不符 → 401。
    """
    from kaas_common.files import verify_asset_token

    try:
        secret = _main._jwt_secret(request)
    except Exception:  # noqa: BLE001 - 有意兜底：无密钥环境按空 secret 处理，后续验签一律拒绝
        secret = ""
    if not verify_asset_token(secret, "seal", seal_id, t):
        raise HTTPException(status_code=401, detail={
            "error": "unauthorized", "code": "RENDER_TOKEN_INVALID",
            "message": "渲染资源令牌无效或已过期"})
    async with _acquire(request) as conn:
        row = await _get_or_404(conn, DEFAULT_TENANT, seal_id)
    return Response(
        content=bytes(row["png_bytes"]),
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=900",
            "Content-Disposition": f'inline; filename="seal-{seal_id}.png"',
        },
    )


@app.put("/api/v1/tenant/company-seals/{seal_id}/default")
async def set_default_seal(
    request: Request,
    seal_id: int,
    user: dict = Depends(_get_current_user),
):
    """设为默认章（单证渲染时自动盖默认章）。事务内先清后设，保证唯一。"""
    await _main._require_team_admin(request, user)
    tenant_id = _tenant_of(user)
    async with _acquire(request) as conn:
        async with conn.transaction():
            await _get_or_404(conn, tenant_id, seal_id)
            await conn.execute(
                "UPDATE tenant_company_seals SET is_default=false, updated_at=now()"
                " WHERE tenant_id=$1", tenant_id)
            row = await conn.fetchrow(
                "UPDATE tenant_company_seals SET is_default=true, updated_at=now()"
                f" WHERE tenant_id=$1 AND id=$2 RETURNING {_META_COLS}",
                tenant_id, seal_id)
    return _to_meta(row)


@app.delete("/api/v1/tenant/company-seals/{seal_id}")
async def delete_seal(
    request: Request,
    seal_id: int,
    user: dict = Depends(_get_current_user),
):
    """删除公章。默认章不允许直接删（先转移默认，避免单证突然没章可盖）。"""
    await _main._require_team_admin(request, user)
    tenant_id = _tenant_of(user)
    async with _acquire(request) as conn:
        row = await _get_or_404(conn, tenant_id, seal_id)
        if row["is_default"]:
            others = await conn.fetchval(
                "SELECT 1 FROM tenant_company_seals WHERE tenant_id=$1 AND id<>$2 LIMIT 1",
                tenant_id, seal_id)
            if others is not None:
                raise HTTPException(status_code=409, detail={
                    "error": "conflict", "code": "DEFAULT_SEAL",
                    "detail": "这是默认章，请先把其他章设为默认再删除",
                })
        await conn.execute(
            "DELETE FROM tenant_company_seals WHERE tenant_id=$1 AND id=$2",
            tenant_id, seal_id)
    return {"deleted": True, "id": seal_id}
