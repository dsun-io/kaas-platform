"""Kaas v2 · 报价查询 API 测试 (§5 T14)"""
import pytest
pytestmark = pytest.mark.db


class TestQuotationAPI:
    """GET /api/v1/quotations 端点测试。"""

    async def test_list_quotations_returns_200(self, client):
        """GET /api/v1/quotations 返回 200。"""
        response = await client.get(
            "/api/v1/quotations",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "quotations" in data
        assert "total" in data
        assert isinstance(data["quotations"], list)

    async def test_list_quotations_with_filters(self, client):
        """带过滤条件查询。"""
        response = await client.get(
            "/api/v1/quotations?product_category=牛栏网&limit=10",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["limit"] == 10

    async def test_quotation_fields_complete(self, client):
        """返回的报价记录包含所有必要字段。"""
        # 先创建一个报价
        await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "product_spec": {"mesh": "50x50", "wire": "2.5"},
            },
            headers={"X-Tenant-Id": "lianjia"},
        )

        response = await client.get(
            "/api/v1/quotations?customer_id=cust-1",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        if data["quotations"]:
            q = data["quotations"][0]
            required = [
                "id", "customer_id", "product_category", "product_spec",
                "spec_hash", "currency", "unit", "source", "created_at",
            ]
            for field in required:
                assert field in q, f"Missing field: {field}"

    async def test_limit_capped_at_500(self, client):
        """limit 参数上限 500。"""
        response = await client.get(
            "/api/v1/quotations?limit=1000",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["limit"] <= 500  # 实际取 min(1000, 500) = 500

    async def test_empty_result_for_unknown_category(self, client):
        """不存在的品类返回空列表。"""
        response = await client.get(
            "/api/v1/quotations?product_category=nonexistent_category",
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["quotations"] == []
        assert data["total"] == 0
