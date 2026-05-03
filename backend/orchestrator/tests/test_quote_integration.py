"""Kaas v2 · 报价全链路集成测试 (§13 T9)

LLM + KB 均 mock，验证整个报价链路不中断。
"""
import json
import pytest
pytestmark = pytest.mark.db
import httpx
import respx
from unittest.mock import AsyncMock, patch, MagicMock


class TestQuoteIntegration:
    """报价全链路集成测试（LLM + KB mock）。"""

    @pytest.fixture(autouse=True)
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("LLM_PROVIDER", "stub")
        monkeypatch.setenv("KB_PROVIDER", "stub")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

    async def test_full_chain_matched_path(self, client):
        """LLM 提参成功 + L4 命中 → matched（零 LLM 话术）。"""
        mock_quotation = MagicMock()
        mock_quotation.unit_price = 12.5
        mock_quotation.currency = "CNY"
        mock_quotation.unit = "m²"
        mock_quotation.discount = None

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price:
            mock_price.return_value = mock_quotation

            response = await client.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "product_category": "牛栏网",
                    "product_spec": {"mesh": "50x50", "wire": "2.5"},
                    "quantity": 50,
                },
                headers={"X-Tenant-Id": "liankai"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "matched"
        assert data["confidence"] == "high"
        assert data["source"] == "quotations_db"
        assert "script" in data

    async def test_full_chain_estimated_path(self, client):
        """LLM 提参 + L4 未命中 + KB 检索 → estimated。"""
        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price:
            mock_price.return_value = None

            response = await client.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "product_category": "牛栏网",
                    "product_spec": {"mesh": "60x60", "wire": "3.0"},
                    "quantity": 100,
                },
                headers={"X-Tenant-Id": "liankai"},
            )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] in ("estimated", "spec_not_supported")
        assert "script" in data

    async def test_raw_text_extraction_falls_back_to_regex(self, client):
        """LLM 提参失败 → 正则兜底 → 继续走定价链路。"""
        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price:
            mock_price.return_value = None

            response = await client.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "product_category": "牛栏网",
                    "raw_text": "50x50 丝径2.5 100平方米",
                    "quantity": 100,
                },
                headers={"X-Tenant-Id": "liankai"},
            )

        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "spec_hash" in data

    async def test_kb_failure_still_returns_response(self, client):
        """LLM + KB 全挂 → 降级模板 → 仍返回结构化响应（不 500）。"""
        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price, patch(
            "app.services.kb_client.get_kb_client"
        ) as mock_kb_factory:
            mock_price.return_value = None
            mock_kb = MagicMock()
            mock_kb.search = AsyncMock(side_effect=Exception("KB unavailable"))
            mock_kb_factory.return_value = mock_kb

            response = await client.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "product_category": "牛栏网",
                    "product_spec": {"mesh": "50x50", "wire": "2.5"},
                },
                headers={"X-Tenant-Id": "liankai"},
            )

        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "script" in data

    async def test_response_includes_all_required_fields(self, client):
        """响应包含所有结构化字段 + 话术。"""
        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_price:
            mock_price.return_value = None

            response = await client.post(
                "/api/v1/quote",
                json={
                    "customer_id": "cust-1",
                    "product_category": "石笼网",
                    "product_spec": {"mesh": "80x100", "wire": "2.7"},
                },
                headers={"X-Tenant-Id": "liankai"},
            )

        assert response.status_code == 200
        data = response.json()
        required_fields = [
            "status", "unit_price", "currency", "unit",
            "confidence", "source", "spec_hash", "script",
        ]
        for field in required_fields:
            assert field in data, f"Missing: {field}"
