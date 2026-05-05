"""Kaas v2 · 定价引擎测试 (§5 T14)

覆盖两条路径: matched / spec_not_supported。
铁律4: FastGPT 不参与报价决策。Path 2 (KB 估算) 已移除。
"""
import pytest
pytestmark = pytest.mark.unit
from unittest.mock import AsyncMock, MagicMock, patch
from app.services.pricing import get_price, PricingResult


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
    async def test_path3_spec_not_supported(self):
        """DB 未命中 → spec_not_supported（无 KB 估算）。"""
        mock_session = AsyncMock()

        with patch(
            "app.services.pricing.get_latest_price", new_callable=AsyncMock
        ) as mock_get_price:
            mock_get_price.return_value = None
            result = await get_price(
                db=mock_session,
                customer_id="cust-1",
                product_category="牛栏网",
                product_spec={"mesh": "999x999"},
            )

        assert result.status == "spec_not_supported"
        assert result.unit_price is None
        assert result.confidence == "low"
        assert result.source == "kb_estimated"

    @pytest.mark.anyio
    async def test_no_fastgpt_import(self):
        """验证 pricing 模块不依赖 FastGPT。"""
        import app.services.pricing as pricing_mod
        source = open(pricing_mod.__file__).read()
        assert "kb_client" not in source
        assert "build_dataset_ids" not in source
        assert "get_kb_client" not in source
