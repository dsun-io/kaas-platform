"""Kaas v2 · 定价引擎测试 (§5 T14)

覆盖三条路径: matched / estimated / spec_not_supported。
"""
import pytest
pytestmark = pytest.mark.unit
from unittest.mock import AsyncMock, patch, MagicMock
from app.services.pricing import get_price, PricingResult, _assess_confidence


class TestConfidenceAssessment:
    """代码规则置信度评估测试（铁律1: 非 AI）。"""

    def test_exact_match_high(self):
        assert _assess_confidence(
            {"mesh": "50x50"}, {"mesh": "50x50"}
        ) == "high"

    def test_mesh_match_medium(self):
        assert _assess_confidence(
            {"mesh": "50x50", "wire": "2.5"},
            {"mesh": "50x50", "wire": "3.0"},
        ) == "medium"

    def test_wire_close_medium(self):
        assert _assess_confidence(
            {"wire_diameter": "2.5"},
            {"wire_diameter": "2.7"},
        ) == "medium"

    def test_no_match_low(self):
        assert _assess_confidence(
            {"mesh": "50x50"},
            {"mesh": "100x100"},
        ) == "low"

    def test_empty_specs_low(self):
        assert _assess_confidence({}, {}) == "high"  # both empty → equal


class TestPricingService:
    """定价引擎单元测试。"""

    @pytest.mark.anyio
    async def test_path1_matched_exact_hash(self):
        """精确 spec_hash 匹配 → matched / high / quotations_db。"""
        mock_session = AsyncMock()
        mock_quotation = MagicMock()
        mock_quotation.unit_price = 12.5
        mock_quotation.currency = "CNY"
        mock_quotation.unit = "m²"
        mock_quotation.discount = None

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price:
            mock_get_price.return_value = mock_quotation
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "50x50", "wire": "2.5"},
                quantity=50,
            )

        assert result.status == "matched"
        assert result.unit_price == 12.5
        assert result.confidence == "high"
        assert result.source == "quotations_db"

    @pytest.mark.anyio
    async def test_path1_with_discount(self):
        """精确匹配时折扣生效。"""
        mock_session = AsyncMock()
        mock_quotation = MagicMock()
        mock_quotation.unit_price = 100.0
        mock_quotation.currency = "CNY"
        mock_quotation.unit = "m²"
        mock_quotation.discount = 0.1

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price:
            mock_get_price.return_value = mock_quotation
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "50x50", "wire": "2.5"},
            )

        assert result.status == "matched"
        assert result.unit_price == 90.0  # 100 * 0.9

    @pytest.mark.anyio
    async def test_path2_estimated_from_kb(self):
        """DB 未命中 → KB 估算 → estimated / medium。"""
        mock_session = AsyncMock()
        mock_kb = MagicMock()
        mock_kb.search = AsyncMock(return_value=[
            {"spec": {"mesh": "50x50", "wire": "3.0"}, "unit_price": 14.0, "unit": "m²"}
        ])

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price, patch(
            "app.services.pricing.get_kb_client"
        ) as mock_kb_client:
            mock_get_price.return_value = None
            mock_kb_client.return_value = mock_kb
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "50x50", "wire": "3.0"},
            )

        assert result.status == "estimated"
        assert result.unit_price == 14.0
        assert result.source == "kb_estimated"

    @pytest.mark.anyio
    async def test_path2_large_quantity_discount(self):
        """KB 估算时大批量折扣（>100 打 95 折）。"""
        mock_session = AsyncMock()
        mock_kb = MagicMock()
        mock_kb.search = AsyncMock(return_value=[
            {"spec": {"mesh": "50x50"}, "unit_price": 10.0, "unit": "m²"}
        ])

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price, patch(
            "app.services.pricing.get_kb_client"
        ) as mock_kb_client:
            mock_get_price.return_value = None
            mock_kb_client.return_value = mock_kb
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "50x50"},
                quantity=200,
            )

        assert result.unit_price == 9.5  # 10 * 0.95

    @pytest.mark.anyio
    async def test_path3_spec_not_supported(self):
        """DB 未命中 + KB 相似度过低 → spec_not_supported。"""
        mock_session = AsyncMock()
        mock_kb = MagicMock()
        mock_kb.search = AsyncMock(return_value=[])

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price, patch(
            "app.services.pricing.get_kb_client"
        ) as mock_kb_client:
            mock_get_price.return_value = None
            mock_kb_client.return_value = mock_kb
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "999x999"},
            )

        assert result.status == "spec_not_supported"
        assert result.unit_price is None
        assert result.confidence == "low"

    @pytest.mark.anyio
    async def test_path3_low_confidence_kb(self):
        """KB 返回结果但相似度过低 → spec_not_supported。"""
        mock_session = AsyncMock()
        mock_kb = MagicMock()
        mock_kb.search = AsyncMock(return_value=[
            {"spec": {"mesh": "200x200"}, "unit_price": 5.0, "unit": "m²"}
        ])

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price, patch(
            "app.services.pricing.get_kb_client"
        ) as mock_kb_client:
            mock_get_price.return_value = None
            mock_kb_client.return_value = mock_kb
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "50x50"},
            )

        assert result.status == "spec_not_supported"
