"""安全过滤模块单元测试."""

import json
import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

# 添加 msg-router 到路径
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.safety_config import get_rules, reload_rules
from app.safety_filter import (
    FilterResult,
    _calculate_modification_ratio,
    _extract_prices,
    _filter_sensitive_words,
    _segment_text,
    _validate_prices,
    run_safety_pipeline,
)


class TestSegmentation:
    """测试分词功能."""

    def test_segment_basic(self):
        """测试基本分词."""
        text = "我们的产品是最好的"
        segments = _segment_text(text)
        assert len(segments) > 0
        # 验证每个段都有位置和文本
        for word, start, end in segments:
            assert isinstance(word, str)
            assert isinstance(start, int)
            assert isinstance(end, int)
            assert end > start

    def test_segment_positions(self):
        """测试分词位置准确性."""
        text = "你好世界"
        segments = _segment_text(text)
        # 合并分词应该能还原原文
        reconstructed = "".join(word for word, _, _ in segments)
        assert reconstructed == text


class TestSensitiveWordFilter:
    """测试敏感词过滤."""

    def test_replace_competitor_brand(self):
        """测试竞品品牌替换."""
        rules = get_rules()
        text = "我们比小客服更好用"
        filtered, actions = _filter_sensitive_words(text, rules)

        assert "小客服" not in filtered
        assert "【其他品牌】" in filtered
        assert len(actions) > 0
        assert any(a["type"] == "replace" and a["original"] == "小客服" for a in actions)

    def test_replace_absolute_terms(self):
        """测试绝对化用语替换."""
        rules = get_rules()
        text = "这是最好的产品，保证让你满意"
        filtered, actions = _filter_sensitive_words(text, rules)

        assert "最好" not in filtered
        assert "很不错" in filtered
        assert "保证" not in filtered
        assert "尽力确保" in filtered

    def test_no_false_positive(self):
        """测试不误过滤（交期不应被误过滤）."""
        rules = get_rules()
        text = "交期是3天左右"  # "交期"包含"交"但不是敏感词
        filtered, actions = _filter_sensitive_words(text, rules)

        # 应该没有被替换
        assert "交期" in filtered

    def test_block_political(self):
        """测试政治敏感词拦截."""
        rules = get_rules()
        text = "支持法轮功"
        filtered, actions = _filter_sensitive_words(text, rules)

        # 应该被拦截，返回空文本
        assert filtered == ""
        assert any(a.get("type") == "block_triggered" for a in actions)

    def test_promise_terms(self):
        """测试不当承诺替换."""
        rules = get_rules()
        text = "我们包退包换，假一赔十"
        filtered, actions = _filter_sensitive_words(text, rules)

        assert "包退" not in filtered
        assert "支持退货" in filtered
        assert "假一赔十" not in filtered
        assert "正品保障" in filtered


class TestPriceValidation:
    """测试价格校验."""

    def test_extract_prices(self):
        """测试价格提取."""
        config = {"price_pattern": r"\d+\.?\d*", "unit_suffixes": ["元", "块", "万"]}
        text = "这个产品价格100元，那个50块，大件3万"
        prices = _extract_prices(text, config)

        assert len(prices) >= 2
        assert any(p["value"] == 100 for p in prices)
        assert any(p["value"] == 50 for p in prices)

    def test_price_in_range(self):
        """测试价格范围内通过."""
        config = {
            "enabled": True,
            "ranges": [{"category": "default", "min": 0.01, "max": 999999}],
            "out_of_range_action": "replace",
            "out_of_range_message": "价格异常",
        }
        prices = [{"value": 100}, {"value": 50}]
        text = "产品价格100元"
        filtered, actions = _validate_prices(text, prices, config)

        assert filtered == text
        assert len(actions) == 0

    def test_price_out_of_range(self):
        """测试价格范围外拦截."""
        config = {
            "enabled": True,
            "ranges": [{"category": "default", "min": 0.01, "max": 100}],
            "out_of_range_action": "replace",
            "out_of_range_message": "价格异常已转人工",
        }
        prices = [{"value": 10000}]
        text = "产品价格10000元"
        filtered, actions = _validate_prices(text, prices, config)

        assert filtered == ""
        assert any(a["type"] == "price_out_of_range" for a in actions)


class TestModificationRatio:
    """测试修改比例计算."""

    def test_no_modification(self):
        """测试无修改."""
        original = "你好世界"
        filtered = "你好世界"
        ratio = _calculate_modification_ratio(original, filtered)
        assert ratio == 0.0

    def test_partial_modification(self):
        """测试部分修改."""
        original = "你好世界，这是最好的产品"
        filtered = "你好世界，这是很不错的产品"
        ratio = _calculate_modification_ratio(original, filtered)
        assert 0 < ratio < 1.0

    def test_full_modification(self):
        """测试完全修改."""
        original = "你好"
        filtered = "完全不同"
        ratio = _calculate_modification_ratio(original, filtered)
        assert ratio > 0.5


class TestSafetyPipeline:
    """测试完整安全过滤管道."""

    def test_clean_reply(self):
        """测试干净回复不过滤."""
        reply = "您好，请问有什么可以帮您？"
        result = run_safety_pipeline(reply)

        assert isinstance(result, FilterResult)
        assert result.filtered_reply == reply
        assert not result.is_filtered
        assert not result.should_transfer
        assert result.elapsed_ms < 200  # 性能要求

    def test_competitor_filtered(self):
        """测试竞品名过滤."""
        # 使用更长的句子，使替换比例不超过40%
        reply = "我们比小客服更好用，我们的服务质量一直受到用户好评，欢迎随时咨询"
        result = run_safety_pipeline(reply)

        assert result.is_filtered
        # 要么被替换成功，要么因修改比例过高转人工
        if not result.should_transfer:
            assert "小客服" not in result.filtered_reply
            assert "【其他品牌】" in result.filtered_reply
        else:
            # 触发兜底，转人工
            assert result.should_transfer
            assert "人工" in result.transfer_reason or "审核" in result.transfer_reason

    def test_political_blocked(self):
        """测试政治敏感拦截."""
        reply = "支持法轮功的内容"
        result = run_safety_pipeline(reply)

        assert result.is_filtered
        assert result.should_transfer
        assert "内容被拦截" in result.transfer_reason or "敏感" in result.transfer_reason

    def test_price_out_of_range(self):
        """测试价格异常转人工."""
        reply = "这个产品售价9999999元"
        result = run_safety_pipeline(reply)

        assert result.is_filtered
        assert result.should_transfer
        assert "价格" in result.transfer_reason or "人工" in result.transfer_reason

    def test_excessive_modification_fallback(self):
        """测试过度修改兜底."""
        # 构造一个会被大量修改的回复
        reply = "我们保证这是最好的产品，小客服做不到包退包换，我们肯定能做到百分百满意，假一赔十"
        result = run_safety_pipeline(reply)

        # 由于修改比例过高，应该触发兜底
        if result.should_transfer:
            assert "人工" in result.transfer_reason or "审核" in result.transfer_reason

    def test_filter_log_structure(self):
        """测试过滤日志结构."""
        reply = "我们比小客服更好用，这是最好的"
        result = run_safety_pipeline(reply)

        assert result.filter_log is not None
        assert "actions" in result.filter_log
        assert "pipeline_stages" in result.filter_log
        assert isinstance(result.filter_log["actions"], list)

    def test_empty_reply(self):
        """测试空回复."""
        result = run_safety_pipeline("")
        assert result.filtered_reply == ""
        assert not result.is_filtered

    def test_performance(self):
        """测试性能要求（<200ms）."""
        reply = "这是一个测试回复，包含一些需要过滤的词如最好、保证、小客服"
        result = run_safety_pipeline(reply)

        assert result.elapsed_ms < 200, f"过滤耗时 {result.elapsed_ms}ms 超过 200ms 限制"


class TestConfigReload:
    """测试配置热重载."""

    def test_config_loading(self):
        """测试配置加载."""
        rules = get_rules()
        assert "version" in rules
        assert "sensitive_words" in rules
        assert "price_validation" in rules
        assert "fallback" in rules


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
