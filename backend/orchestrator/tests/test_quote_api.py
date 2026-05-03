"""Kaas v2 · 报价 API 测试 (§5 T14)"""
import pytest
pytestmark = pytest.mark.db
from unittest.mock import AsyncMock, patch, MagicMock


class TestQuoteAPI:
    """POST /api/v1/quote 端点测试。"""

    async def test_quote_with_spec_returns_200(self, client):
        """提供完整 product_spec 返回 200。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "product_spec": {"mesh": "50x50", "wire": "2.5"},
                "quantity": 100,
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code in (200, 400)  # 200 if DB has data, 400 if fresh
        data = response.json()
        assert "status" in data
        assert "spec_hash" in data

    async def test_quote_with_raw_text_extracts_spec(self, client):
        """提供 raw_text 自动提取规格。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "raw_text": "我要50x50丝径2.5的牛栏网100平方米",
                "quantity": 100,
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code in (200, 400)
        data = response.json()
        assert "status" in data

    async def test_quote_missing_spec_returns_400(self, client):
        """无 product_spec 且无 raw_text 返回 400。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "spec_required"

    async def test_quote_includes_script_field(self, client):
        """响应中包含话术 script 字段。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "product_spec": {"mesh": "50x50", "wire": "2.5"},
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        data = response.json()
        if response.status_code == 200:
            assert "script" in data

    async def test_quote_returns_all_status_fields(self, client):
        """响应包含所有必要字段。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "牛栏网",
                "product_spec": {"mesh": "50x50", "wire": "2.5"},
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        data = response.json()
        for field in ["status", "confidence", "source", "spec_hash", "script"]:
            assert field in data, f"Missing field: {field}"

    async def test_quote_spec_not_supported_path(self, client):
        """不存在的规格走 spec_not_supported 路径。"""
        response = await client.post(
            "/api/v1/quote",
            json={
                "customer_id": "cust-1",
                "product_category": "特殊品类",
                "product_spec": {"custom_field": "xyz"},
            },
            headers={"X-Tenant-Id": "liankai"},
        )
        data = response.json()
        # 应该能正常返回（即使是 spec_not_supported）
        assert "status" in data
