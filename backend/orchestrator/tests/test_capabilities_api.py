"""Kaas v2 · 客户能力 API 测试 (§5 T14)

覆盖: CRUD + tenant_id 隔离。
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
    app.middleware_stack = None
    return old


def _restore_dispatch(old):
    AuthContextMiddleware.dispatch = old
    app.middleware_stack = None


class TestCapabilitiesAPI:
    """客户能力 CRUD 端点测试。"""

    async def test_list_capabilities_returns_200(self, client):
        """GET /api/v1/capabilities 返回 200。"""
        response = await client.get(
            "/api/v1/capabilities",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "capabilities" in data
        assert isinstance(data["capabilities"], list)

    async def test_list_capabilities_with_customer_filter(self, client):
        """按 customer_id 查询过滤。"""
        response = await client.get(
            "/api/v1/capabilities?customer_id=lianjia",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "capabilities" in data

    async def test_upsert_new_capability(self, client):
        """POST 新增能力返回 200。"""
        response = await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "test_cust",
                "customer_name": "测试客户",
                "product_category": "牛栏网",
                "spec_constraints": {"mesh": "50x50-100x100", "wire": "2.0-4.0"},
                "notes": "测试数据",
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["customer_id"] == "test_cust"
        assert data["product_category"] == "牛栏网"
        assert data["spec_constraints"] == {"mesh": "50x50-100x100", "wire": "2.0-4.0"}

    async def test_upsert_existing_capability(self, client):
        """POST 更新已存在的能力返回 200。"""
        # 先创建
        await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "test_cust2",
                "customer_name": "测试客户2",
                "product_category": "石笼网",
                "spec_constraints": {"mesh": "80x100"},
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        # 再更新
        response = await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "test_cust2",
                "customer_name": "测试客户2-更新",
                "product_category": "石笼网",
                "spec_constraints": {"mesh": "80x100-120x150"},
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["customer_name"] == "测试客户2-更新"
        assert data["spec_constraints"] == {"mesh": "80x100-120x150"}

    async def test_upsert_without_required_fields(self, client):
        """缺少必填字段返回 400。"""
        response = await client.post(
            "/api/v1/capabilities",
            json={"customer_id": "x"},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "missing_fields"


class TestCapabilitiesTenantIsolation:
    """客户能力 tenant_id 隔离测试。"""

    async def test_customer_sees_only_own_tenant(self, client, db_session):
        """customer 只看到自己租户的能力，看不到同 ID 跨租户数据。"""
        from app.repositories.capabilities_repo import get_capabilities

        # 用 internal 在 tenant lianjia 创建 customer_id="lianjia" 的能力
        await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "lianjia",
                "customer_name": "联佳",
                "product_category": "牛栏网",
                "spec_constraints": {"mesh": "50x50"},
                "tenant_id": "lianjia",
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        # 用 internal 在 tenant client_b 创建同 customer_id="lianjia" 的能力（跨租户）
        await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "lianjia",
                "customer_name": "联佳",
                "product_category": "牛栏网",
                "spec_constraints": {"mesh": "80x100"},
                "tenant_id": "client_b",
            },
            headers={"X-Tenant-Id": "client_b"},
        )

        # customer 身份 (lianjia): 只查到自己的 tenant 的数据
        old = _install_customer_mock(tenant_id="lianjia")
        try:
            response = await client.get(
                "/api/v1/capabilities",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        caps = data["capabilities"]
        # 应只看到 lianjia tenant 的记录（由 tenant_id 过滤）
        lianjia_records = [c for c in caps if c["customer_id"] == "lianjia"]
        assert len(lianjia_records) >= 1
        for c in lianjia_records:
            assert c["spec_constraints"] == {"mesh": "50x50"}  # lianjia 的内容，不是 client_b 的

        # client_b 下同 customer_id 的记录不可见
        client_b_records = await get_capabilities(
            db_session, customer_id="lianjia", tenant_id="client_b",
        )
        assert len(client_b_records) >= 1

    async def test_upsert_sets_tenant_id_for_internal(self, client, db_session):
        """internal: upsert 使用 body 传入的 tenant_id。"""
        from app.repositories.capabilities_repo import get_capabilities

        response = await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "tenant_test",
                "customer_name": "自定义租户",
                "product_category": "牛栏网",
                "spec_constraints": {"test": "value"},
                "tenant_id": "client_b",
            },
            headers={"X-Tenant-Id": "client_b"},
        )
        assert response.status_code == 200

        caps = await get_capabilities(
            db_session, customer_id="tenant_test", tenant_id="client_b",
        )
        assert len(caps) == 1
        assert caps[0].tenant_id == "client_b"

    async def test_upsert_sets_tenant_id_for_customer(self, client, db_session):
        """customer: upsert 使用 auth.tenant_id，忽略 body 的 tenant_id。"""
        from app.repositories.capabilities_repo import get_capabilities

        old = _install_customer_mock(tenant_id="client_b")
        try:
            response = await client.post(
                "/api/v1/capabilities",
                json={
                    "customer_id": "client_b",  # 必须匹配 auth.customer_code
                    "customer_name": "客户租户测试",
                    "product_category": "牛栏网",
                    "spec_constraints": {"test": "yes"},
                    # 不传 tenant_id（require_tenant_match 允许空）
                },
                headers={"X-Tenant-Id": "client_b"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200

        caps = await get_capabilities(
            db_session, customer_id="client_b", tenant_id="client_b",
        )
        assert len(caps) >= 1
        found = [c for c in caps if c.product_category == "牛栏网"]
        assert len(found) == 1
        assert found[0].tenant_id == "client_b"

    async def test_path_based_get_respects_tenant(self, client):
        """GET /api/v1/customer/{id}/capabilities: customer 只能读自己的数据。"""
        # 先创建一个能力（customer_code = "lianjia" 的数据）
        await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "lianjia",
                "customer_name": "联佳",
                "product_category": "牛栏网",
                "spec_constraints": {"mesh": "75x75"},
                "tenant_id": "lianjia",
            },
            headers={"X-Tenant-Id": "lianjia"},
        )

        # customer 身份读自己的数据（path customer_id = auth.customer_code）
        old = _install_customer_mock(tenant_id="lianjia")
        try:
            response = await client.get(
                "/api/v1/customer/lianjia/capabilities",
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 1
        assert data[0]["customer_id"] == "lianjia"

    async def test_patch_respects_tenant(self, client):
        """PATCH /api/v1/customer/{id}/capabilities: 正常更新同租户能力。"""
        # 先创建（customer_id = auth.customer_code 的值）
        resp = await client.post(
            "/api/v1/capabilities",
            json={
                "customer_id": "lianjia",
                "customer_name": "联佳",
                "product_category": "牛栏网",
                "spec_constraints": {"mesh": "60x60"},
                "tenant_id": "lianjia",
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        cap_id = resp.json()["id"]

        # customer 更新自己的能力（path customer_id = auth.customer_code）
        old = _install_customer_mock(tenant_id="lianjia")
        try:
            response = await client.patch(
                "/api/v1/customer/lianjia/capabilities",
                json={
                    "id": cap_id,
                    "spec_constraints": {"mesh": "60x60-80x80"},
                },
                headers={"X-Tenant-Id": "lianjia"},
            )
        finally:
            _restore_dispatch(old)

        assert response.status_code == 200
        data = response.json()
        assert data["capability"]["spec_constraints"] == {"mesh": "60x60-80x80"}
