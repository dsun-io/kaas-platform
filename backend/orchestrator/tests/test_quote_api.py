"""Kaas v2 · 报价 V2 API 测试 (INT-R3)"""
import pytest
pytestmark = pytest.mark.db


class TestQuoteV2API:
    """POST /api/v1/quote 新引擎端点测试。"""

    async def test_quote_matched_returns_200(self, client):
        """匹配完整规格 → 200 + matched 状态。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 10,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "matched"
        assert data["product_category"] == "niulanwang"
        assert data["main_line"]["quantity"] == 10
        assert len(data["main_line"]["tiers"]) >= 1
        assert "copyable_script" in data

    async def test_quote_no_match_returns_200(self, client):
        """不存在的规格 → 200 + no_match 状态（非 500）。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "wire_diameter": "99.9",
                "height": 99.9,
                "quantity": 1,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "no_match"
        assert "copyable_script" in data

    async def test_quote_unsupported_category(self, client):
        """支持品类之外的品类 → unsupported_category 状态。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "钢板网",
                "quantity": 1,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "unsupported_category"

    async def test_quote_returns_v2_fields(self, client):
        """V2 响应包含所有必要字段。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 1,
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        v2_fields = [
            "status", "product_category", "main_line",
            "accessory_lines", "freight", "totals", "notes", "copyable_script",
        ]
        for field in v2_fields:
            assert field in data, f"Missing V2 field: {field}"
        assert "tiers" in data["main_line"]
        assert "spec_summary" in data["main_line"]

    async def test_quote_with_accessories(self, client):
        """含配件（立柱）请求返回配件行。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 5,
                "accessories": [
                    {"product_category": "立柱", "product_type": "直边", "height": 1.8, "quantity": 10},
                ],
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "accessory_lines" in data

    async def test_quote_with_freight(self, client):
        """含省份参数返回运费信息。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "product_type": "上疏下密",
                "wire_diameter": "2.0x1.8",
                "height": 1.5,
                "mesh_width": 15,
                "roll_length": 50,
                "quantity": 10,
                "province": "四川",
            },
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 200
        data = response.json()
        assert data["freight"] is not None
        assert data["freight"]["province"] == "四川"
        assert len(data["freight"]["options"]) > 0

    async def test_quote_no_tenant_returns_401(self, client):
        """无 X-Tenant-Id → 401。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "product_category": "牛栏网",
                "quantity": 1,
            },
        )
        assert response.status_code == 401

    async def test_quote_validation_error(self, client):
        """缺少必填字段 → 422。"""
        response = await client.post(
            "/api/v1/quote",
            json={},
            headers={"X-Tenant-Id": "lianjia"},
        )
        assert response.status_code == 422
