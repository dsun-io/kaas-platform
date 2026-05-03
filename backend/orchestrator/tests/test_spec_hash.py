"""Kaas v2 · spec_hash 单元测试 (§5 T14)"""
import pytest
pytestmark = pytest.mark.unit
from app.domain.spec_hash import compute_spec_hash


class TestSpecHash:
    """spec_hash 确定性哈希算法测试。"""

    def test_same_input_produces_same_hash(self):
        """相同输入产生相同哈希。"""
        spec = {"mesh": "50x50", "wire": "2.5"}
        h1 = compute_spec_hash(spec)
        h2 = compute_spec_hash(spec)
        assert h1 == h2
        assert len(h1) == 16

    def test_different_input_produces_different_hash(self):
        """不同输入产生不同哈希。"""
        h1 = compute_spec_hash({"mesh": "50x50", "wire": "2.5"})
        h2 = compute_spec_hash({"mesh": "60x60", "wire": "3.0"})
        assert h1 != h2

    def test_key_order_independent(self):
        """键顺序不影响哈希结果（sort_keys=True）。"""
        h1 = compute_spec_hash({"mesh": "50x50", "wire": "2.5"})
        h2 = compute_spec_hash({"wire": "2.5", "mesh": "50x50"})
        assert h1 == h2

    def test_nested_dict_stable(self):
        """嵌套字典哈希稳定。"""
        spec = {"mesh": "50x50", "dimensions": {"width": 1.5, "height": 2.0}}
        h1 = compute_spec_hash(spec)
        h2 = compute_spec_hash(spec)
        assert h1 == h2

    def test_empty_spec_returns_hash(self):
        """空 spec 也能正常返回哈希。"""
        h = compute_spec_hash({})
        assert isinstance(h, str)
        assert len(h) == 16

    def test_chinese_characters_stable(self):
        """中文字段名和值稳定哈希。"""
        spec = {"网孔": "50x50", "丝径": 2.5}
        h1 = compute_spec_hash(spec)
        h2 = compute_spec_hash(spec)
        assert h1 == h2
