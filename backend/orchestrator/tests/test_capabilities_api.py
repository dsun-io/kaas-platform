"""Kaas v2 · 客户能力 API 测试 (§5 T14)"""
import pytest
pytestmark = pytest.mark.db


class TestCapabilitiesAPI:
    """客户能力 CRUD 端点测试。"""

    async def test_list_capabilities_returns_200(self, client):
        """GET /api/v1/capabilities 返回 200。"""
        response = await client.get(
            "/api/v1/capabilities",
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "capabilities" in data
        assert isinstance(data["capabilities"], list)

    async def test_list_capabilities_with_customer_filter(self, client):
        """按 customer_id 查询过滤。"""
        response = await client.get(
            "/api/v1/capabilities?customer_id=liankai",
            headers={"X-Tenant-Id": "liankai"},
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
            headers={"X-Tenant-Id": "liankai"},
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
            headers={"X-Tenant-Id": "liankai"},
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
            headers={"X-Tenant-Id": "liankai"},
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
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "missing_fields"
