"""C2 文件存储 · 真 PostgreSQL 用例（task-15）。

为什么要有这一档
----------------
`file_objects` / `tenant_company_seals` 的**正确性有一半在 schema 上**：
部分唯一索引（"同一归属同一用途只允许一个当前版本"、"每个产品只能有一张主图"、
"每个租户至多一枚默认章"）与 `bytea` 落库往返，用假 DB 永远验证不了 ——
假 DB 只证明"SQL 长这样"，证明不了"库真的这么约束"。

覆盖（对应 task-15 的 ①②③④）
----------------------------
1. `file_objects.uq_file_current`（部分唯一：`is_current AND kind IN
   ('stamp_scan','render_pdf')`）—— 冲突时的行为；
2. `file_objects.uq_file_primary`（部分唯一：`is_primary AND is_current`）——
   同一归属产品图只能一张主图；
3. 跨租户隔离：`tenant_id` ≠ `default` 的行不会被 worker 的列表/取内容接口看到；
4. `content` bytea 往返：multipart 上传 → inline 落库 → GET content 逐字节一致
   （含 `0x00`/`0xFF` 等非 UTF-8 字节）；
5. `tenant_company_seals`：`(tenant_id,name)` 唯一 + 每租户至多一枚默认章（部分唯一）
   + `png_bytes` bytea 往返。

skip 口径（**无库时必须 skip、不能 fail**，与 `tests/integration/` 既有约定一致）
------------------------------------------------------------------------------
数据库本身由 `tests/integration/conftest.py` 的 `pg_info` 夹具探测：
`TEST_DATABASE_URL` → 本地 PG 二进制（pgserver / PG_BIN / PATH）→ 都找不到就
`pytest.skip`；迁移失败缺 contrib 扩展也 skip。本文件**只额外**加两种"前置 schema
不含该表"的 skip（`file_objects` / `tenant_company_seals`），其余一律让断言硬失败 ——
schema 漂移必须红。

本机跑法（docker PG 的 `kaas_dev` **不能直接指**：conftest 每个用例会 TRUNCATE 全库）::

    docker exec kaas-postgres psql -U kaas -d kaas_dev -c "CREATE DATABASE kaas_it_files;"
    $env:TEST_DATABASE_URL="postgresql+asyncpg://kaas:kaas_dev@127.0.0.1:5432/kaas_it_files"
    cd backend/worker
    uv run --frozen --with pytest --with httpx2 python -m pytest tests/integration -q

跑完删库：`docker exec kaas-postgres psql -U kaas -d kaas_dev -c "DROP DATABASE kaas_it_files;"`。
"""
from __future__ import annotations

import hashlib

import asyncpg
import pytest

pytestmark = pytest.mark.integration

_PASSWORD = "Passw0rd!"
_ADMIN_EMAIL = "files-admin@integration.test"


# ── helpers ──────────────────────────────────────────────────────────────────


def _bootstrap_admin(client, setup_token: str) -> dict:
    resp = client.post(
        "/api/v1/auth/bootstrap-admin",
        json={
            "email": _ADMIN_EMAIL,
            "password": _PASSWORD,
            "display_name": "文件域集成测试管理员",
        },
        headers={"Authorization": f"Bearer {setup_token}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _table_exists(db, name: str) -> bool:
    return bool(db.fetchval("SELECT to_regclass($1) IS NOT NULL", f"public.{name}"))


def _require_table(db, name: str) -> None:
    if not _table_exists(db, name):
        pytest.skip(f"测试库缺少表 {name}（前置 schema 不含该表，跳过本档用例）")


def _insert_file(
    db,
    *,
    tenant_id: str = "default",
    owner_type: str = "product",
    owner_id: str | None = "field_fence",
    kind: str = "product_photo",
    media_kind: str | None = "production",
    name: str = "测试图",
    is_current: bool = True,
    is_primary: bool = False,
    content: bytes | None = None,
) -> int:
    """直接 INSERT 一行文件元数据（只给断言需要的列，其它列走 DDL 默认值）。"""
    return int(
        db.fetchval(
            "INSERT INTO file_objects"
            " (tenant_id, owner_type, owner_id, kind, media_kind, name,"
            "  storage, content, is_current, is_primary)"
            " VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id",
            tenant_id,
            owner_type,
            owner_id,
            kind,
            media_kind,
            name,
            "inline" if content is not None else "s3",
            content,
            is_current,
            is_primary,
        )
    )


# ── ① file_objects · 部分唯一索引 ────────────────────────────────────────────


def test_file_current_unique_blocks_second_current_for_versioned_kind(db):
    """`uq_file_current`：同一归属 + 版本化用途（stamp_scan/render_pdf）只允许一个当前件。"""
    _require_table(db, "file_objects")

    first = _insert_file(
        db,
        owner_type="trade_doc",
        owner_id="1",
        kind="stamp_scan",
        media_kind="scan",  # 显式非 NULL：见下一个用例（NULL 的边界）
        name="v1",
    )

    # 同租户 + 同归属 + 同 kind + 同 media_kind 的第二条"当前件"必须被唯一索引挡下。
    with pytest.raises(asyncpg.UniqueViolationError):
        _insert_file(
            db,
            owner_type="trade_doc",
            owner_id="1",
            kind="stamp_scan",
            media_kind="scan",
            name="v2",
        )

    # 旧件让位（is_current=false）后，新当前件可以插入 —— 这正是"版本链"的写法。
    db.execute("UPDATE file_objects SET is_current=false WHERE id=$1", first)
    second = _insert_file(
        db,
        owner_type="trade_doc",
        owner_id="1",
        kind="stamp_scan",
        media_kind="scan",
        name="v2",
    )
    assert second != first

    # 不同 media_kind / 不同 owner / 非版本化 kind 都不受这条索引约束。
    _insert_file(db, owner_type="trade_doc", owner_id="1", kind="stamp_scan",
                 media_kind="other-angle", name="侧面")
    _insert_file(db, owner_type="trade_doc", owner_id="2", kind="stamp_scan",
                 media_kind="scan", name="另一张单证")
    _insert_file(db, owner_type="product", owner_id="field_fence",
                 kind="product_photo", media_kind="production", name="产品图")


def test_file_current_unique_covers_null_media_kind(db):
    """C22：`media_kind=NULL` 的第二条"当前件"也必须被唯一约束拒绝。

    背景：真实盖章回传就是 `media_kind=None`（`ws_files.py` 的 `upload_doc_file`
    → `_create_file(..., media_kind=None)`）。PostgreSQL 唯一索引默认 **NULLS DISTINCT**
    ⇒ 旧索引对 NULL 行不生效，两条同归属"当前 stamp_scan"可以并存（task-15 发现、
    C22 登记）。迁移 `202610200005` 给 `uq_file_current` 加了 **NULLS NOT DISTINCT**
    （PG15+），NULL 与 NULL 视为相等 ⇒ 现在第二条必须被拒。

    这条用例在 C22 之前是"characterization（断言可并存）"，现已**反转**成回归守卫：
    若哪天索引又退回 NULLS DISTINCT，它会红。
    """
    _require_table(db, "file_objects")

    first = _insert_file(db, owner_type="trade_doc", owner_id="9",
                         kind="stamp_scan", media_kind=None, name="回传 v1")

    # 同归属 + 同 kind + 都 media_kind=NULL + 都 is_current ⇒ 唯一约束拒绝
    with pytest.raises(asyncpg.UniqueViolationError):
        _insert_file(db, owner_type="trade_doc", owner_id="9",
                     kind="stamp_scan", media_kind=None, name="回传 v2")

    # 版本链的正常写法仍成立：旧件让位（is_current=false）后，新当前件可以插入
    db.execute("UPDATE file_objects SET is_current=false WHERE id=$1", first)
    second = _insert_file(db, owner_type="trade_doc", owner_id="9",
                          kind="stamp_scan", media_kind=None, name="回传 v2")
    assert second != first
    assert db.fetchval(
        "SELECT count(*) FROM file_objects"
        " WHERE owner_id='9' AND kind='stamp_scan' AND is_current"
    ) == 1

    # 其它归属不受影响（约束是"同一归属唯一"，不是全局唯一）
    _insert_file(db, owner_type="trade_doc", owner_id="10",
                 kind="stamp_scan", media_kind=None, name="另一张单证")


def test_file_primary_unique_one_primary_photo_per_owner(db):
    """`uq_file_primary`：同一归属产品图最多一张 `is_primary AND is_current`。"""
    _require_table(db, "file_objects")

    _insert_file(db, owner_id="field_fence", kind="product_photo",
                 media_kind="production", name="主图", is_primary=True)

    # 第二张"主图"必须被挡住 —— 哪怕 media_kind 不同（索引里不含 media_kind）。
    with pytest.raises(asyncpg.UniqueViolationError):
        _insert_file(db, owner_id="field_fence", kind="product_photo",
                     media_kind="size", name="又想当主图", is_primary=True)

    # 非主图可以并存（产品图本来就允许多张）
    _insert_file(db, owner_id="field_fence", kind="product_photo",
                 media_kind="size", name="尺寸图", is_primary=False)
    # 旧主图让位后，新的可以上位
    db.execute(
        "UPDATE file_objects SET is_current=false"
        " WHERE owner_id='field_fence' AND is_primary"
    )
    _insert_file(db, owner_id="field_fence", kind="product_photo",
                 media_kind="finished", name="新主图", is_primary=True)
    assert db.fetchval(
        "SELECT count(*) FROM file_objects"
        " WHERE owner_id='field_fence' AND is_primary AND is_current"
    ) == 1


# ── ② 跨租户隔离 ─────────────────────────────────────────────────────────────


def test_cross_tenant_files_not_visible_through_worker_queries(
    client, db, admin_setup_token
):
    """A 租户查不到 B 租户的 file（列表 + 取内容两条读路径都要带 tenant 谓词）。"""
    _require_table(db, "file_objects")
    body = _bootstrap_admin(client, admin_setup_token)
    headers = _auth(body["access_token"])

    mine = _insert_file(db, tenant_id="default", owner_id="field_fence",
                        name="本租户图", content=b"\x89PNG-mine")
    other = _insert_file(db, tenant_id="tenant-b", owner_id="field_fence",
                         name="别租户图", content=b"\x89PNG-other")

    listed = client.get(
        "/api/v1/file-objects",
        params={"owner_type": "product", "owner_id": "field_fence"},
        headers=headers,
    )
    assert listed.status_code == 200, listed.text
    ids = [item["id"] for item in listed.json()["items"]]
    assert mine in ids
    assert other not in ids, "别租户的文件出现在本租户列表里（tenant 谓词失效）"

    # 按 id 直接取内容也一样：tenant 条件挡住 → 404（而不是把字节吐出来）
    blocked = client.get(f"/api/v1/file-objects/{other}/content", headers=headers)
    assert blocked.status_code == 404, blocked.text
    assert blocked.json()["detail"]["code"] == "FILE_NOT_FOUND"

    # sanity：行确实在库里，只是被 tenant 谓词过滤掉了（不是"没写进去"）
    assert db.fetchval("SELECT count(*) FROM file_objects WHERE id=$1", other) == 1
    # 本租户那条能正常读到
    ok = client.get(f"/api/v1/file-objects/{mine}/content", headers=headers)
    assert ok.status_code == 200, ok.text
    assert ok.content == b"\x89PNG-mine"


# ── ③ bytea 往返 ────────────────────────────────────────────────────────────


def test_file_content_bytea_roundtrip_via_upload_and_get(client, db, admin_setup_token):
    """上传（无 S3/R2 ⇒ inline 落库）→ 库里 bytea → GET content 逐字节一致。

    刻意用**非 UTF-8 / 含 NUL / 0xFF** 的字节：任何"先 decode 再 encode"的写法
    （latent 的 mojibake / 截断）都会在这里露馅。

    2026-10-21 C36：`POST /file-objects/upload` 已按用户批准删除（C1 授权不做），
    改用**仍在役**的单证回传 multipart 上传 `POST /trade-docs/{id}/files/upload`
    —— 同一条 `_create_file` → inline bytea 落库链路，覆盖不降级。
    """
    _require_table(db, "file_objects")
    body = _bootstrap_admin(client, admin_setup_token)
    headers = _auth(body["access_token"])

    payload = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) + b"\x00\xff\x00tail"
    # 单证上传要挂到一张单证上；直接插一张最小 draft 单证（本用例只关心文件字节）
    doc_id = int(db.fetchval(
        "INSERT INTO trade_docs (tenant_id, doc_no, doc_type, status, raw_payload)"
        " VALUES ($1,$2,$3,'draft','{}'::jsonb) RETURNING id",
        "default", "IT-FILES-BYTEAL-1", "ci",
    ))

    resp = client.post(
        f"/api/v1/trade-docs/{doc_id}/files/upload",
        files={"file": ("roundtrip.png", payload, "image/png")},
        data={"name": "bytea 往返", "role": "stamp_scan"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    file_id = resp.json()["file"]["id"]

    row = db.fetchrow(
        "SELECT storage, content, file_size, sha256 FROM file_objects WHERE id=$1",
        file_id,
    )
    assert row is not None, "上传返回 201 但 file_objects 没有落库"
    # 测试 env 没有 S3_* / FILES binding ⇒ _store_bytes 走 inline 兜底
    assert row["storage"] == "inline", row["storage"]
    assert bytes(row["content"]) == payload, "bytea 入库后与上传字节不一致"
    assert row["file_size"] == len(payload)
    assert row["sha256"] == hashlib.sha256(payload).hexdigest()

    got = client.get(f"/api/v1/file-objects/{file_id}/content", headers=headers)
    assert got.status_code == 200, got.text
    assert got.content == payload, "GET content 读回与上传字节不一致"
    assert got.headers["content-type"].startswith("image/png")

    # 再读一次也必须一致（证明不是靠请求内缓存碰巧对）
    again = client.get(f"/api/v1/file-objects/{file_id}/content", headers=headers)
    assert again.content == payload


# ── ④ 公章唯一约束 + bytea ──────────────────────────────────────────────────


def _insert_seal(db, *, tenant_id="default", name="公章", is_default=True,
                 png: bytes = b"\x89PNG-seal") -> int:
    return int(
        db.fetchval(
            "INSERT INTO tenant_company_seals"
            " (tenant_id, name, png_bytes, is_default) VALUES ($1,$2,$3,$4)"
            " RETURNING id",
            tenant_id, name, png, is_default,
        )
    )


def test_company_seal_unique_name_and_single_default(db):
    """`tenant_company_seals`：同租户名称唯一 + 每租户至多一枚默认章。"""
    _require_table(db, "tenant_company_seals")

    seal_id = _insert_seal(db, name="公章", is_default=True)
    assert seal_id > 0

    # 同名（同租户）→ 唯一约束
    with pytest.raises(asyncpg.UniqueViolationError):
        _insert_seal(db, name="公章", is_default=False)

    # 同租户第二枚默认章 → 部分唯一索引
    with pytest.raises(asyncpg.UniqueViolationError):
        _insert_seal(db, name="财务章", is_default=True)

    # 非默认章可以多枚
    _insert_seal(db, name="财务章", is_default=False)
    _insert_seal(db, name="法人章", is_default=False)
    assert db.fetchval(
        "SELECT count(*) FROM tenant_company_seals WHERE tenant_id='default'"
    ) == 3

    # 另一个租户可以有同名章、也可以有默认章（约束按租户隔离）
    other = _insert_seal(db, tenant_id="tenant-b", name="公章", is_default=True)
    assert other != seal_id
    assert db.fetchval(
        "SELECT count(*) FROM tenant_company_seals WHERE tenant_id='tenant-b'"
    ) == 1


def test_company_seal_png_bytes_roundtrip(db):
    """公章是图片资产：`png_bytes` bytea 必须逐字节往返（含非 UTF-8）。"""
    _require_table(db, "tenant_company_seals")

    png = b"\x89PNG\r\n\x1a\n" + bytes(reversed(range(256)))
    seal_id = _insert_seal(db, tenant_id="tenant-b", name="测试章", is_default=True,
                           png=png)
    row = db.fetchrow(
        "SELECT mime, png_bytes FROM tenant_company_seals WHERE id=$1", seal_id
    )
    assert row is not None
    assert row["mime"] == "image/png"          # DDL 默认值（不是 API 层补的）
    assert bytes(row["png_bytes"]) == png, "png_bytes bytea 往返不一致"
    assert db.fetchval(
        "SELECT octet_length(png_bytes) FROM tenant_company_seals WHERE id=$1",
        seal_id,
    ) == len(png)
