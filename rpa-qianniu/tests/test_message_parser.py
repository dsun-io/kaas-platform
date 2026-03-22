"""读消息前置过滤：订单/侧栏 stub 与真实买家句的区分（反复跑：python -m unittest discover -s tests -v）。"""

from __future__ import annotations

import unittest

from app.message_parser import (
    has_substantive_buyer_text,
    is_ocr_noise_message,
    is_panel_colon_stub,
    is_short_buyer_keyword_noise,
    is_system_message,
)


class TestPanelColonStub(unittest.TestCase):
    def test_order_field_colon_only_rejected(self) -> None:
        for s in (
            "实收：",
            "实付：",
            "应收：",
            "合计：",
            "运费：",
            "优惠：",
            "价保：",
            "买家：",
            "卖家：",
        ):
            with self.subTest(s=s):
                self.assertTrue(is_panel_colon_stub(s), f"stub {s!r}")
                self.assertTrue(is_system_message(s), f"system {s!r}")

    def test_buyer_like_kept(self) -> None:
        for s in (
            "测试问句",
            "实收是多少",
            "请问实付多少钱",
            "你好，有货吗",
            "价保怎么算",
        ):
            with self.subTest(s=s):
                self.assertFalse(is_system_message(s), f"keep {s!r}")
                self.assertTrue(has_substantive_buyer_text(s))


class TestOcrNoise(unittest.TestCase):
    def test_price_only(self) -> None:
        self.assertTrue(is_ocr_noise_message("102.00"))
        self.assertTrue(is_system_message("102.00"))

    def test_evaluated(self) -> None:
        self.assertTrue(is_system_message("已评价"))


class TestShortNoise(unittest.TestCase):
    def test_single_char_and_panel_fragments(self) -> None:
        self.assertFalse(has_substantive_buyer_text("共"))
        self.assertTrue(is_short_buyer_keyword_noise("共"))
        self.assertTrue(is_system_message("共"))
        self.assertTrue(is_short_buyer_keyword_noise("共1件"))
        self.assertTrue(is_system_message("共1件"))

    def test_short_keyword_without_question(self) -> None:
        self.assertTrue(is_short_buyer_keyword_noise("库存"))
        self.assertTrue(is_system_message("库存"))

    def test_real_questions_kept(self) -> None:
        self.assertFalse(is_short_buyer_keyword_noise("有库存吗"))
        self.assertFalse(is_system_message("有库存吗"))
        self.assertFalse(is_short_buyer_keyword_noise("订单什么时候发"))
        self.assertFalse(is_system_message("订单什么时候发"))


if __name__ == "__main__":
    unittest.main()
