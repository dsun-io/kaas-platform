"""Kaas v2 · Admin API 鉴权隔离测试 (§5 T14)

覆盖: admin 端点对 internal 返回 200, customer/free 返回 403。
"""
import pytest
from app.middleware.auth import AuthContextMiddleware
from app.core.auth import AuthContext
from app.main import app
from tests.conftest import _TEST_AUTH_PUBLIC_PATHS

pytestmark = pytest.mark.db


def _install_customer_mock():
    """Override dispatch 返回 customer 角色 + 强制重建中间件栈。"""
    async def _customer_dispatch(self, request, call_next):
        path = request.url.path
        if any(path.startswith(p) for p in _TEST_AUTH_PUBLIC_PATHS):
            return await call_next(request)
        tenant_id = request.headers.get("X-Tenant-Id", "lianjia")
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
    app.middleware_stack = None  # 强制重建中间件栈
    return old


def _restore_dispatch(old):
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None  # 强制重建


class TestAdminAPIAuthIsolation:
    """Admin 端点鉴权隔离测试。"""

    # ── internal: 应正常访问 ──

    async def test_internal_can_list_tenants(self, client):
        """internal → GET /api/v1/admin/tenants → 200。"""
        response = await client.get(
            "/api/v1/admin/tenants",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "tenants" in data

    async def test_internal_can_reload_tenants(self, client):
        """internal → POST /api/v1/admin/tenants/reload → 200。"""
        response = await client.post(
            "/api/v1/admin/tenants/reload",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["message"] == "Tenant cache reloaded"

    async def test_internal_can_clear_cache(self, client):
        """internal → POST /api/v1/admin/cache/clear → 200。"""
        response = await client.post(
            "/api/v1/admin/cache/clear",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "cleared_sessions" in data

    async def test_internal_can_get_metrics_summary(self, client):
        """internal → GET /api/v1/admin/metrics/summary → 200。"""
        response = await client.get(
            "/api/v1/admin/metrics/summary",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "active_sessions" in data

    async def test_internal_can_get_feature_flags(self, client):
        """internal → GET /api/v1/admin/feature_flag → 200。"""
        response = await client.get(
            "/api/v1/admin/feature_flag",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200

    # ── customer: 应被拒绝 ──

    async def test_customer_gets_403_on_list_tenants(self, client):
        """customer → GET /api/v1/admin/tenants → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.get(
                "/api/v1/admin/tenants",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_reload_tenants(self, client):
        """customer → POST /api/v1/admin/tenants/reload → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.post(
                "/api/v1/admin/tenants/reload",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_cache_clear(self, client):
        """customer → POST /api/v1/admin/cache/clear → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.post(
                "/api/v1/admin/cache/clear",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_metrics_summary(self, client):
        """customer → GET /api/v1/admin/metrics/summary → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.get(
                "/api/v1/admin/metrics/summary",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_feature_flags(self, client):
        """customer → GET /api/v1/admin/feature_flag → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.get(
                "/api/v1/admin/feature_flag",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_set_feature_flag(self, client):
        """customer → POST /api/v1/admin/feature_flag → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.post(
                "/api/v1/admin/feature_flag",
                json={"tenant_id": "lianjia", "flag_name": "test", "flag_value": True},
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403

    async def test_customer_gets_403_on_audit_log(self, client):
        """customer → GET /api/v1/admin/deployment_audit → 403。"""
        old = _install_customer_mock()
        try:
            response = await client.get(
                "/api/v1/admin/deployment_audit",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)
        assert response.status_code == 403
