"""S5 预览前缀规则（kaas_common.preview）单测。

核心口径（README §2.3 规则 5）：PR_SLUG 空/未设置 = 生产行为不变（前缀空串）；
非法值宁可降级为 None 也不写错前缀（污染事故 > 静默无前缀）。
"""
import pytest

from kaas_common.preview import (
    apply_storage_prefix,
    kv_key,
    normalize_pr_slug,
    storage_prefix,
)

pytestmark = pytest.mark.unit


class TestNormalizePrSlug:
    @pytest.mark.parametrize("raw", ["42", " 42 ", "000123456"])
    def test_valid_digits(self, raw: str):
        assert normalize_pr_slug(raw) == raw.strip()

    @pytest.mark.parametrize("raw", [None, "", "   "])
    def test_empty_is_production(self, raw):
        assert normalize_pr_slug(raw) is None

    @pytest.mark.parametrize("raw", [
        "abc", "pr-42", "42a", "-1", "1.5", "42/..", "４２",
        "9999999999",  # 超 9 位
        "42; DROP TABLE users;--",
    ])
    def test_dirty_values_degrade_to_none(self, raw: str):
        # 宁可无前缀，绝不写错前缀（防注入/防污染）
        assert normalize_pr_slug(raw) is None


class TestStoragePrefix:
    def test_slug_gives_prefix(self):
        assert storage_prefix("42") == "pr-42/"

    def test_none_gives_empty(self):
        assert storage_prefix(None) == ""

    def test_apply_prefix(self):
        key = "t/default/product/7/product_photo/size/ab12cd34ef56.jpg"
        assert apply_storage_prefix(key, "42") == "pr-42/" + key

    def test_apply_prefix_idempotent(self):
        key = "pr-42/t/default/x.png"
        assert apply_storage_prefix(key, "42") == key

    def test_apply_prefix_none_unchanged(self):
        key = "t/default/x.png"
        assert apply_storage_prefix(key, None) == key


class TestKvKey:
    def test_preview_prefixes(self):
        assert kv_key("session:abc", "42") == "pr-42:session:abc"

    def test_production_unchanged(self):
        assert kv_key("session:abc", None) == "session:abc"
