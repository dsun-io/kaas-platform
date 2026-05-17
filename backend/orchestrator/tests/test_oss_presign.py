"""Kaas v2 · OSS Presign API 鉴权隔离测试 (§5 T14)

覆盖:
- internal: tenant_id 必须显式传入 body
- customer: 自动绑定 auth.tenant_id
- 跨租户隔离: customer 无法上传到其他租户
- minio mock: 不依赖真实 OSS
"""
import pytest
from app.middleware.auth import AuthContextMiddleware
from app.core.auth import AuthContext
from app.main import app
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db


def _install_customer_mock(tenant_id="lianjia"):
    """Override dispatch 返回 customer 角色 + 强制重建中间件栈。"""
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
    app.middleware_stack = None  # 强制重建
    return old


def _restore_dispatch(old):
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None  # 强制重建


class TestOSSPresignAuth:
    """OSS Presign 鉴权隔离测试。

    默认 client fixture 注入 internal auth（来自 _auto_mock_auth）。
    minio_mock fixture 拦截 _get_minio_client 避免真实 OSS 调用。
    """

    # ── internal ──

    async def test_internal_presign_requires_tenant_id(self, client, minio_mock):
        """internal: 缺少 tenant_id → 400。"""
        response = await client.post(
            "/api/v1/oss/presign",
            json={"purpose": "event_payload"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "missing_tenant"

    async def test_internal_presign_with_tenant_id(self, client, minio_mock):
        """internal: 传入 tenant_id → 200，key 包含该 tenant 前缀。"""
        response = await client.post(
            "/api/v1/oss/presign",
            json={
                "tenant_id": "client_b",
                "purpose": "event_payload",
                "event_type": "chat.turn",
                "content_type": "application/json",
                "size_bytes": 1024,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "client_b" in data["oss_key"]
        assert data["oss_key"].startswith("events-archive/client_b/")
        assert data["method"] == "PUT"
        assert data["expires_in"] == 600

    async def test_internal_presign_invalid_purpose(self, client, minio_mock):
        """internal: 无效 purpose → 400。"""
        response = await client.post(
            "/api/v1/oss/presign",
            json={"tenant_id": "lianjia", "purpose": "invalid_purpose"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "invalid_purpose"

    async def test_internal_presign_size_too_large(self, client, minio_mock):
        """internal: 超过大小限制 → 400。"""
        response = await client.post(
            "/api/v1/oss/presign",
            json={
                "tenant_id": "lianjia",
                "purpose": "event_payload",
                "size_bytes": 20 * 1024 * 1024,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        data = response.json()
        assert data["error"] == "size_too_large"

    # ── customer ──

    async def test_customer_presign_auto_binds_tenant(self, client, minio_mock):
        """customer: 自动使用 auth.tenant_id，key 包含该 tenant。"""
        old = _install_customer_mock(tenant_id="lianjia")
        try:
            response = await client.post(
                "/api/v1/oss/presign",
                json={
                    "purpose": "event_payload",
                    "event_type": "chat.turn",
                },
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        assert data["oss_key"].startswith("events-archive/lianjia/")

    async def test_customer_presign_key_contains_own_tenant(self, client, minio_mock):
        """customer: body 中 tenant_id 被忽略，key 始终用 auth.tenant_id。"""
        old = _install_customer_mock(tenant_id="lianjia")
        try:
            response = await client.post(
                "/api/v1/oss/presign",
                json={
                    "tenant_id": "client_b",
                    "purpose": "event_payload",
                },
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        # 即使 body 传了 client_b，key 仍使用 customer 的 tenant_id (lianjia)
        assert data["oss_key"].startswith("events-archive/lianjia/")

    async def test_customer_presign_no_body_tenant_id(self, client, minio_mock):
        """customer: body 不传 tenant_id 也正常返回 200。"""
        old = _install_customer_mock(tenant_id="client_b")
        try:
            response = await client.post(
                "/api/v1/oss/presign",
                json={"purpose": "event_payload"},
                headers={"X-Tenant-Id": "client_b"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        assert data["oss_key"].startswith("events-archive/client_b/")

    # ── customer with no tenant binding ──

    async def test_customer_no_tenant_binding_returns_403(self, client, minio_mock):
        """customer: 无 tenant_id → 403。"""
        async def _no_tenant_dispatch(self, request, call_next):
            path = request.url.path
            if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
                return await call_next(request)
            request.state.auth = AuthContext(
                user_id=3,
                account_type="customer",
                customer_id=2,
                customer_code="orphan",
                customer_name="Orphan",
                tenant_id=None,
            )
            return await call_next(request)

        old = AuthContextMiddleware.dispatch
        AuthContextMiddleware.dispatch = _no_tenant_dispatch
        app.middleware_stack = None
        try:
            response = await client.post(
                "/api/v1/oss/presign",
                json={"purpose": "event_payload"},
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            AuthContextMiddleware.dispatch = old
            app.middleware_stack = None

        assert response.status_code == 403
        data = response.json()
        assert data["error"] == "forbidden"
