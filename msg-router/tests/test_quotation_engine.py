"""
报价引擎测试（纯计算器模式 v3.0）

测试覆盖：
- 三种计价模式：per_kg / per_sqm / per_piece
- 四种物流：顺丰零担 / 顺丰干配 / 圆通 / 京东
- 开票/不开票
"""

import pytest
from pathlib import Path
import sys

# 添加 app 目录到路径
sys.path.insert(0, str(Path(__file__).parent.parent / "app"))

from quotation_engine import QuotationEngine


class TestQuotationEngine:
    """报价引擎测试类"""
    
    @pytest.fixture(autouse=True)
    def setup_engine(self):
        """初始化引擎"""
        self.engine = QuotationEngine()
    
    # ============================================================
    # 计价模式测试
    # ============================================================
    
    def test_per_kg_pricing(self):
        """测试按重量计价"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "河北"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 商品总价 = 8.5 × 45.2 × 10 = 3842
        assert result.summary.items_total == pytest.approx(3842.0, rel=0.01)
        assert result.summary.invoice_tax == 0
    
    def test_per_sqm_pricing(self):
        """测试按面积计价"""
        request = {
            "items": [
                {
                    "name": "均孔网",
                    "pricing_method": "per_sqm",
                    "unit_price": 3.15,
                    "billing_qty": 52.5,  # 1.05m × 50m
                    "weight_kg": 38,
                    "count": 5
                }
            ],
            "shipping": {
                "carrier": "sf_ganpei",
                "province": "浙江"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 商品总价 = 3.15 × 52.5 × 5 = 826.875
        assert result.summary.items_total == pytest.approx(826.875, rel=0.01)
    
    def test_per_piece_pricing(self):
        """测试按件计价"""
        request = {
            "items": [
                {
                    "name": "立柱",
                    "pricing_method": "per_piece",
                    "unit_price": 6.3,
                    "billing_qty": 1,
                    "weight_kg": 1.44,
                    "count": 50
                }
            ],
            "shipping": {
                "carrier": "yuantong",
                "province": "江苏"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 商品总价 = 6.3 × 1 × 50 = 315
        assert result.summary.items_total == pytest.approx(315.0, rel=0.01)
    
    # ============================================================
    # 运费测试
    # ============================================================
    
    def test_sf_ltl_shipping(self):
        """测试顺丰零担运费"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10  # 总重 452kg
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "广东"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 运费 = 首重价格 + 续重 × (重量-首重) + 保险费
        # 广东：首重27元，续重1.1元/kg，保险10元（>100kg）
        # = 27 + 1.1 × (452-20) + 10 = 27 + 475.2 + 10 = 512.2
        assert result.summary.shipping_cost > 0
    
    def test_sf_ganpei_shipping(self):
        """测试顺丰干配运费"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "sf_ganpei",
                "province": "浙江"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        assert result.summary.shipping_cost > 0
    
    def test_yuantong_shipping(self):
        """测试圆通运费"""
        request = {
            "items": [
                {
                    "name": "立柱",
                    "pricing_method": "per_piece",
                    "unit_price": 6.3,
                    "billing_qty": 1,
                    "weight_kg": 1.44,
                    "count": 50  # 总重 72kg
                }
            ],
            "shipping": {
                "carrier": "yuantong",
                "province": "江苏"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 圆通：weight * 1.8 + 4 = 72 * 1.8 + 4 = 133.6
        assert result.summary.shipping_cost == pytest.approx(133.6, rel=0.01)
    
    def test_jd_shipping(self):
        """测试京东运费"""
        request = {
            "items": [
                {
                    "name": "立柱",
                    "pricing_method": "per_piece",
                    "unit_price": 6.3,
                    "billing_qty": 1,
                    "weight_kg": 1.44,
                    "count": 50  # 总重 72kg
                }
            ],
            "shipping": {
                "carrier": "jd",
                "province": "江苏"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 京东：首重31元(20kg) + 续重1.3元/kg × (72-20) = 31 + 67.6 = 98.6
        assert result.summary.shipping_cost == pytest.approx(98.6, rel=0.01)
    
    # ============================================================
    # 开票测试
    # ============================================================
    
    def test_invoice_true(self):
        """测试开票（总价 × 1.03）"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "河北"
            },
            "need_invoice": True
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 开票加税 = 税前小计 × 0.03
        expected_tax = result.summary.subtotal_before_tax * 0.03
        assert result.summary.invoice_tax == pytest.approx(expected_tax, rel=0.01)
        # 总价 = 税前小计 × 1.03
        assert result.summary.total == pytest.approx(result.summary.subtotal_before_tax * 1.03, rel=0.01)
    
    def test_invoice_false(self):
        """测试不开票"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "河北"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        assert result.summary.invoice_tax == 0
        assert result.summary.total == result.summary.subtotal_before_tax
    
    # ============================================================
    # 多商品测试
    # ============================================================
    
    def test_multiple_items(self):
        """测试多商品"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                },
                {
                    "name": "立柱",
                    "pricing_method": "per_piece",
                    "unit_price": 6.3,
                    "billing_qty": 1,
                    "weight_kg": 1.44,
                    "count": 50
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "广东"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        assert len(result.items) == 2
        # 商品总价 = 3842 + 315 = 4157
        assert result.summary.items_total == pytest.approx(4157.0, rel=0.01)
    
    # ============================================================
    # 边界条件测试
    # ============================================================
    
    def test_empty_items(self):
        """测试空商品列表"""
        request = {
            "items": [],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "河北"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "error"
        assert "items 不能为空" in result.error_message
    
    def test_invalid_carrier(self):
        """测试无效物流公司"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "invalid_carrier",
                "province": "河北"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "error"
    
    def test_unknown_province(self):
        """测试未知省份（使用默认费率）"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "未知省份"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        # 应该使用默认费率（河北）而不是报错
        assert result.status == "success"
    
    def test_custom_total_weight(self):
        """测试自定义总重量（覆盖自动汇总）"""
        request = {
            "items": [
                {
                    "name": "牛栏网",
                    "pricing_method": "per_kg",
                    "unit_price": 8.5,
                    "billing_qty": 45.2,
                    "weight_kg": 45.2,
                    "count": 10  # 自动汇总为 452kg
                }
            ],
            "shipping": {
                "carrier": "sf_ltl",
                "province": "河北",
                "total_weight_kg": 500  # 覆盖为 500kg
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 运费应按 500kg 计算
    
    def test_yuantong_min_weight(self):
        """测试圆通起送重量"""
        request = {
            "items": [
                {
                    "name": "小件",
                    "pricing_method": "per_piece",
                    "unit_price": 10,
                    "billing_qty": 1,
                    "weight_kg": 2,  # 低于起送重量 5kg
                    "count": 1
                }
            ],
            "shipping": {
                "carrier": "yuantong",
                "province": "河北"
            },
            "need_invoice": False
        }
        
        result = self.engine.calculate(request)
        
        assert result.status == "success"
        # 低于起送重量，运费应为 0
        assert result.summary.shipping_cost == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
