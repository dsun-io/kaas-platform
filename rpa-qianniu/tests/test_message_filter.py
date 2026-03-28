"""
系统/订单消息过滤测试
覆盖验收标准：
1. 不误杀买家消息（问句保护）
2. 正确过滤系统通知消息
3. 正确过滤订单号碎片
"""

import pytest
from app.message_parser import (
    is_system_message,
    is_ocr_noise_message,
    _looks_like_buyer_question,
)


class TestBuyerQuestionProtection:
    """测试买家问句保护 - 这些消息不应被过滤"""

    def test_refund_question_not_filtered(self):
        """退款怎么办？→ 不被过滤"""
        msg = "退款怎么办？"
        assert not is_system_message(msg)
        assert _looks_like_buyer_question(msg)

    def test_logistics_question_not_filtered(self):
        """物流到哪了？→ 不被过滤（带问号）"""
        msg = "物流到哪了？"
        assert not is_system_message(msg)
        assert _looks_like_buyer_question(msg)

    def test_order_question_not_filtered(self):
        """订单什么时候发货？→ 不被过滤"""
        msg = "订单什么时候发货？"
        assert not is_system_message(msg)
        assert _looks_like_buyer_question(msg)

    def test_after_sales_question_not_filtered(self):
        """售后怎么处理→ 不被过滤"""
        msg = "售后怎么处理"
        assert not is_system_message(msg)
        assert _looks_like_buyer_question(msg)

    def test_tracking_number_question_not_filtered(self):
        """快递单号是多少→ 不被过滤"""
        msg = "快递单号是多少"
        assert not is_system_message(msg)
        assert _looks_like_buyer_question(msg)

    def test_simple_question_with_order_keyword(self):
        """简单问句含订单关键词→ 不被过滤"""
        assert not is_system_message("这个订单怎么退款？")
        assert not is_system_message("物流显示已发货了吗？")
        assert not is_system_message("退款什么时候到账？")


class TestSystemNotificationFiltering:
    """测试系统通知消息过滤 - 这些消息应该被过滤"""

    def test_transaction_created_filtered(self):
        """交易创建成功→ 被过滤"""
        assert is_system_message("交易创建成功")
        assert is_system_message("您的订单已创建")

    def test_buyer_paid_filtered(self):
        """买家已付款→ 被过滤"""
        assert is_system_message("买家已付款")

    def test_seller_shipped_filtered(self):
        """卖家已发货→ 被过滤"""
        assert is_system_message("卖家已发货")
        assert is_system_message("订单已发货")

    def test_transaction_success_filtered(self):
        """交易成功→ 被过滤"""
        assert is_system_message("交易成功")

    def test_transaction_closed_filtered(self):
        """交易关闭→ 被过滤"""
        assert is_system_message("交易关闭")

    def test_refund_success_filtered(self):
        """退款成功→ 被过滤"""
        assert is_system_message("退款成功")
        assert is_system_message("退款已到账")

    def test_express_delivered_filtered(self):
        """快递已签收→ 被过滤"""
        assert is_system_message("快递已签收")
        assert is_system_message("快递已揽收")
        assert is_system_message("快递已派送")

    def test_package_delivery_filtered(self):
        """包裹派送→ 被过滤"""
        assert is_system_message("包裹正在派送中")

    def test_service_evaluation_filtered(self):
        """服务评价邀请→ 被过滤"""
        assert is_system_message("请对本次服务做出评价")
        assert is_system_message("邀请您对我的服务进行评价")

    def test_system_message_markers_filtered(self):
        """系统消息标记→ 被过滤"""
        assert is_system_message("以下为系统消息")
        assert is_system_message("这是系统消息")
        assert is_system_message("系统提示")
        assert is_system_message("系统通知")

    def test_auto_reply_filtered(self):
        """自动回复→ 被过滤"""
        assert is_system_message("自动回复")

    def test_robot_filtered(self):
        """机器人→ 被过滤"""
        assert is_system_message("机器人")


class TestOrderNumberNoiseFiltering:
    """测试订单号碎片过滤"""

    def test_pure_long_number_filtered(self):
        """纯长数字（12位以上）→ 被过滤"""
        assert is_ocr_noise_message("2851234567890123")
        assert is_ocr_noise_message("123456789012")  # 12位
        assert is_ocr_noise_message("12345678901234567890")  # 20位

    def test_short_number_filtered_as_price(self):
        """短数字（价格格式）→ 被视为 OCR 噪声（订单卡片中的金额）"""
        # 10位数字会被视为订单卡片中的价格/金额碎片
        assert is_ocr_noise_message("1234567890")  # 10位纯数字
        assert is_ocr_noise_message("12345")  # 5位纯数字

    def test_order_number_prefix_filtered(self):
        """订单号：xxx → 被过滤"""
        assert is_ocr_noise_message("订单号：2851234567890123")
        assert is_ocr_noise_message("订单号: 1234567890")
        assert is_ocr_noise_message("订单号285123456789")

    def test_tracking_number_prefix_filtered(self):
        """运单号/快递单号/物流单号 → 被过滤"""
        assert is_ocr_noise_message("运单号：SF1234567890")
        assert is_ocr_noise_message("快递单号: 285123456789")
        assert is_ocr_noise_message("物流单号：JD1234567890")
        assert is_ocr_noise_message("运单号2851234567890123")


class TestEdgeCases:
    """边界情况测试"""

    def test_empty_string_is_system(self):
        """空字符串→ 视为系统消息（过滤）"""
        assert is_system_message("")
        assert is_system_message("   ")

    def test_empty_string_is_ocr_noise(self):
        """空字符串→ 视为 OCR 噪声（过滤）"""
        assert is_ocr_noise_message("")
        assert is_ocr_noise_message("   ")

    def test_price_like_is_ocr_noise(self):
        """价格格式→ 视为 OCR 噪声"""
        assert is_ocr_noise_message("¥123.45")
        assert is_ocr_noise_message("￥99.00")
        # "价格：123.45" 包含中文前缀，不由 is_ocr_noise_message 处理
        # 而由 is_system_message 中的 _SYSTEM_HINTS 处理

    def test_pure_number_is_ocr_noise(self):
        """纯数字（金额）→ 视为 OCR 噪声"""
        assert is_ocr_noise_message("123.45")
        assert is_ocr_noise_message("99.00")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
