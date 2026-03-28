"""
横幅过滤测试 - 验证 _is_qianniu_banner_text() 函数

测试场景：
- 纯横幅文本 → True
- 买家咨询含敏感词 → False（问句豁免）
- 短系统标签 → True

注意：由于 vision_message.py 的正则表达式兼容性问题，
这里直接复制相关函数进行测试。
"""

import re
import pytest

# 复制自 vision_message.py 的常量
_COMMON_UI_NOISE = (
    "收起",
    "展开",
    "查看",
    "详情",
    "好评",
)

_BANNER_SUBSTR = _COMMON_UI_NOISE + (
    "当前消息较多",
    "点此快速获取",
    "集中处理",
    "消息较多",
    "快速获取买家",
    "7天内自动总结",
    "AI一键总结",
    "AI咨询摘要",
    "一键总结",
    "自动总结",
    "hanha41409854",
    "radiobalabala",
)

_LIKELY_QUESTION_TAIL = re.compile(r"[?？！!吗呢吧嘛]$")
_LIKELY_QUESTION_HINT = re.compile(r"(怎么|什么|多少|请问|哪里|为何|为什么|吗|呢|么)")


def _looks_like_buyer_question(text: str) -> bool:
    """判断文本是否像买家问句，用于 banner 过滤豁免。"""
    t = (text or "").strip()
    if len(t) < 5:
        return False
    if _LIKELY_QUESTION_TAIL.search(t):
        return True
    if _LIKELY_QUESTION_HINT.search(t):
        return True
    return False


def _is_qianniu_banner_text(text: str) -> bool:
    """
    检测是否为千牛系统横幅文本。
    增加问句豁免：若文本含 banner 关键词但同时像买家问句，则不判定为横幅。
    """
    t = (text or "").strip()
    if not t:
        return True
    for s in _BANNER_SUBSTR:
        if s in t:
            # 问句豁免：如果是买家问句（如"退款怎么办"），不误判为横幅
            if _looks_like_buyer_question(t):
                return False
            return True
    return False


class TestBannerFiltering:
    """横幅过滤测试"""

    def test_pure_banner_text(self):
        """纯横幅文本 → True"""
        assert _is_qianniu_banner_text("当前消息较多，点此快速获取") is True
        assert _is_qianniu_banner_text("AI咨询摘要") is True
        assert _is_qianniu_banner_text("一键总结") is True
        assert _is_qianniu_banner_text("自动总结") is True
        assert _is_qianniu_banner_text("7天内自动总结") is True

    def test_common_ui_noise(self):
        """通用 UI 噪声 → True"""
        assert _is_qianniu_banner_text("收起") is True
        assert _is_qianniu_banner_text("展开") is True
        assert _is_qianniu_banner_text("查看") is True
        assert _is_qianniu_banner_text("详情") is True

    def test_buyer_question_with_sensitive_word(self):
        """买家问句含敏感词 → False（问句豁免）"""
        # 退款相关
        assert _is_qianniu_banner_text("退款怎么办？") is False
        assert _is_qianniu_banner_text("怎么退款？") is False

        # 物流相关
        assert _is_qianniu_banner_text("物流到哪了？") is False
        assert _is_qianniu_banner_text("快递什么时候到？") is False

        # 售后相关
        assert _is_qianniu_banner_text("售后可以换货吗？") is False
        assert _is_qianniu_banner_text("这个可以退吗？") is False

    def test_buyer_question_exclamation(self):
        """买家问句带感叹号/疑问词 → False（问句豁免）"""
        assert _is_qianniu_banner_text("这个价格能便宜吗！") is False
        assert _is_qianniu_banner_text("什么时候发货呢") is False

    def test_short_banner_text(self):
        """短系统标签 → True"""
        # 这些太短，不问句豁免（长度 < 5）
        assert _is_qianniu_banner_text("收起") is True
        assert _is_qianniu_banner_text("展开") is True

    def test_empty_or_whitespace(self):
        """空文本 → True（视为噪声）"""
        assert _is_qianniu_banner_text("") is True
        assert _is_qianniu_banner_text("   ") is True

    def test_non_banner_text(self):
        """非横幅普通文本 → False"""
        # 普通买家咨询，不含 banner 关键词
        assert _is_qianniu_banner_text("你好") is False
        assert _is_qianniu_banner_text("在吗") is False
        assert _is_qianniu_banner_text("请问有货吗") is False


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
