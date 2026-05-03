"""Kaas v2 · 参数提取器测试 (§5 T14)"""
import pytest
pytestmark = pytest.mark.unit
from app.services.extractor import extract_product_spec, _regex_fallback


class TestRegexFallback:
    """正则兜底提取测试。"""

    def test_extract_mesh_size(self):
        result = _regex_fallback("我要50x50的牛栏网")
        assert result["mesh_size"] == "50x50"

    def test_extract_mesh_with_x_upper(self):
        result = _regex_fallback("规格 80X100 石笼网")
        assert result["mesh_size"] == "80x100"

    def test_extract_mesh_with_multiply(self):
        result = _regex_fallback("网孔 60×60 的")
        assert result["mesh_size"] == "60x60"

    def test_extract_wire_diameter(self):
        result = _regex_fallback("丝径 2.5mm 的牛栏网")
        assert result["wire_diameter"] == 2.5

    def test_extract_wire_diameter_alt_keyword(self):
        result = _regex_fallback("线径 3.0 的")
        assert result["wire_diameter"] == 3.0

    def test_extract_quantity(self):
        result = _regex_fallback("需要100平方米")
        assert result["quantity"] == 100

    def test_extract_multiple_fields(self):
        result = _regex_fallback("50x50 丝径2.5 需要200平方米")
        assert result["mesh_size"] == "50x50"
        assert result["wire_diameter"] == 2.5
        assert result["quantity"] == 200

    def test_no_match_returns_empty(self):
        result = _regex_fallback("你好，我想了解一下产品")
        assert result == {}

    def test_partial_match(self):
        result = _regex_fallback("50x50规格")
        assert result["mesh_size"] == "50x50"
        assert "wire_diameter" not in result


class TestExtractProductSpec:
    """完整提取流程测试。"""

    @pytest.mark.anyio
    async def test_extract_with_stub_llm(self):
        """使用 StubLLM 测试完整提取流程。"""
        result = await extract_product_spec(
            prompt="50x50 丝径2.5 100平方米 牛栏网",
            product_category="牛栏网",
        )
        assert isinstance(result, dict)

    @pytest.mark.anyio
    async def test_extract_fallback_when_llm_empty(self):
        """LLM 返回空时正则兜底。"""
        result = await extract_product_spec(
            prompt="我要60x60的，丝径3.0的",
            product_category="石笼网",
        )
        assert "mesh_size" in result
        assert result["mesh_size"] == "60x60"
        assert result["wire_diameter"] == 3.0
