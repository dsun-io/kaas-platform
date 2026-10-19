"""公司公章 API 测试（单证工位独立化 P1 · 去 Pillow 版）

覆盖：
- 后端只收 PNG（内核纯 Python 校验魔数+IHDR）；转换是前端 Canvas 职责
- 首枚章自动默认；默认章唯一；切换默认
- 同名 409、超大 413、坏图 422
- 越权：跨租户取图 404（不泄露存在性）、客户账号 403
- 删除保护：默认章有其他章时需先转移
"""
import struct
import zlib

import pytest

from app.middleware.auth import AuthContextMiddleware
from app.core.auth import AuthContext

# 用户 2026-10-18 裁决：公章/企业抬头**写入** = 团队管理员或平台管理员
# （app/api/company_profile.require_team_admin）。本文件写操作用平台管理员身份跑；
# 客户账号 / 无团队账号一律 403 TEAM_ADMIN_REQUIRED（用例里按需覆盖请求头）。
ADMIN = {"X-Test-Role": "admin"}
from app.main import app
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db


# ─── 测试图片工具（纯 struct 构造，不依赖 PIL）────────────────────────────

def _png_bytes(size=(40, 20), color=(200, 30, 30, 255)):
    """构造一张合法 PNG：魔数 + IHDR + IDAT(纯色) + IEND。"""
    w, h = size
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    raw = b""
    for _ in range(h):
        raw += b"\x00" + bytes(color) * w
    idat = zlib.compress(raw)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def _fake_jpeg() -> bytes:
    return b"\xff\xd8\xff\xe0" + b"\x00" * 64   # JPEG 魔数，非 PNG


def _is_png(data: bytes) -> bool:
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def _install_customer_mock(tenant_id="lianjia"):
    async def _customer_dispatch(self, request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
            return await call_next(request)
        request.state.auth = AuthContext(
            user_id=2,
            account_type="customer",
            customer_id=1,
            customer_code=tenant_id,
            customer_name=tenant_id,
            tenant_id=tenant_id,
        )
        return await call_next(request)

    old = AuthContextMiddleware.dispatch
    AuthContextMiddleware.dispatch = _customer_dispatch
    app.middleware_stack = None
    return old


def _restore_dispatch(old):
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None


# ─── 上传与格式转换 ──────────────────────────────────────────────────────────

class TestSealUpload:
    async def test_upload_png_auto_default(self, client):
        """首枚章上传成功且自动成为默认。"""
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", _png_bytes(), "image/png")},
            data={"name": "公章"},
            headers=ADMIN)
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "公章"
        assert data["mime"] == "image/png"
        assert data["is_default"] is True
        assert data["preview_url"].endswith(f"/{data['id']}/image")

    async def test_non_png_rejected_with_hint(self, client):
        """非 PNG 拒绝并提示用前端转换（后端不做图像处理）。"""
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.jpg", _fake_jpeg(), "image/jpeg")},
            data={"name": "财务章"},
            headers=ADMIN)
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "BAD_IMAGE"

    async def test_png_stored_byte_exact(self, client):
        """PNG 原样字节入库（转换已在前端完成，后端零处理）。"""
        src = _png_bytes()
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("seal.png", src, "image/png")},
            data={"name": "透明测试章"},
            headers=ADMIN)
        assert resp.status_code == 201
        img = await client.get(resp.json()["preview_url"])
        assert img.status_code == 200
        assert img.content == src   # 字节级一致

    async def test_duplicate_name_conflict(self, client):
        """同名章 → 409。"""
        await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "公章"},
            headers=ADMIN)
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("b.png", _png_bytes(), "image/png")},
            data={"name": "公章"},
            headers=ADMIN)
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "SEAL_NAME_TAKEN"

    async def test_bad_image_rejected(self, client):
        """坏图 → 422。"""
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("bad.png", b"not-an-image", "image/png")},
            data={"name": "坏图"},
            headers=ADMIN)
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "BAD_IMAGE"

    async def test_file_too_large(self, client):
        """超大 → 413（body-limit 中间件或接口层，两层任一即合规）。"""
        big = b"\x89PNG\r\n\x1a\n" + b"\x00" * (6 * 1024 * 1024)
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("big.png", big, "image/png")},
            data={"name": "超大章"},
            headers=ADMIN)
        assert resp.status_code == 413


# ─── 默认章管理 ──────────────────────────────────────────────────────────────

class TestSealDefault:
    async def test_default_is_unique(self, client):
        """两枚章切换默认后，列表里只有一枚 is_default。"""
        r1 = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "章一"},
            headers=ADMIN)
        r2 = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("b.png", _png_bytes(), "image/png")},
            data={"name": "章二"},
            headers=ADMIN)
        id1, id2 = r1.json()["id"], r2.json()["id"]

        resp = await client.put(f"/api/v1/tenant/company-seals/{id2}/default", headers=ADMIN)
        assert resp.status_code == 200

        items = (await client.get("/api/v1/tenant/company-seals")).json()["items"]
        defaults = [i for i in items if i["is_default"]]
        assert len(defaults) == 1
        assert defaults[0]["id"] == id2

    async def test_delete_default_guarded(self, client):
        """默认章且存在其他章时删除 → 409（需先转移默认）。"""
        r1 = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "默认章"},
            headers=ADMIN)
        await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("b.png", _png_bytes(), "image/png")},
            data={"name": "备用章"},
            headers=ADMIN)
        resp = await client.delete(f"/api/v1/tenant/company-seals/{r1.json()['id']}", headers=ADMIN)
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "DEFAULT_SEAL"

    async def test_delete_non_default_ok(self, client):
        """非默认章可直接删。"""
        r1 = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "默认章"},
            headers=ADMIN)
        r2 = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("b.png", _png_bytes(), "image/png")},
            data={"name": "备用章"},
            headers=ADMIN)
        resp = await client.delete(f"/api/v1/tenant/company-seals/{r2.json()['id']}", headers=ADMIN)
        assert resp.status_code == 200
        assert resp.json()["deleted"] is True


# ─── 越权隔离 ────────────────────────────────────────────────────────────────

class TestSealIsolation:
    async def test_cross_tenant_image_404(self, client):
        """跨租户取图 → 404（不泄露存在性）。conftest header 机制切换租户。"""
        r = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "甲的章"},
            headers=ADMIN)
        assert r.status_code == 201, r.text
        seal_id = r.json()["id"]

        resp = await client.get(
            f"/api/v1/tenant/company-seals/{seal_id}/image",
            headers={"X-Tenant-Id": "client_b"},
        )
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "SEAL_NOT_FOUND"

    async def test_customer_account_forbidden(self, client):
        """customer 账号（无团队）管理公章 → 403（用户 2026-10-18 裁决：写=团队管理员/平台管理员）。"""
        resp = await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "客户想上传"},
            headers={"X-Account-Type": "customer"},
        )
        assert resp.status_code == 403
        # 口径变更（2026-10-18）：从 INTERNAL_ONLY 收紧为「仅团队管理员可改」
        assert resp.json()["detail"]["code"] == "TEAM_ADMIN_REQUIRED"

    async def test_list_returns_meta_not_bytes(self, client):
        """列表只回元数据 + preview_url，不回裸字节。"""
        await client.post(
            "/api/v1/tenant/company-seals",
            files={"file": ("a.png", _png_bytes(), "image/png")},
            data={"name": "公章"},
            headers=ADMIN)
        resp = await client.get("/api/v1/tenant/company-seals")
        assert resp.status_code == 200
        items = resp.json()["items"]
        assert items
        assert "png_bytes" not in items[0]
        assert "preview_url" in items[0]
