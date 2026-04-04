"""
牛栏网报价计算引擎（纯计算器模式 v3.0）

职责：
- 接收 FastGPT 传入的精确数值参数
- 执行纯数学计算：乘法 + 运费公式 + 开票加税
- 返回结构化报价结果

设计原则：
- 代码不查表：所有产品定价参数由 FastGPT 通过 API 传入
- 只加载运费费率表（shipping_rates.json）
- 100%确定性计算，无LLM参与

API 请求格式：
{
    "items": [
        {
            "name": "牛栏网",
            "pricing_method": "per_kg",  // per_kg / per_sqm / per_piece
            "unit_price": 8.5,           // FastGPT 从知识库查到的单价
            "billing_qty": 45.2,         // 计费数量（重量kg / 面积㎡ / 件数）
            "weight_kg": 45.2,           // 单件重量（用于运费计算）
            "count": 10                  // 数量
        }
    ],
    "shipping": {
        "carrier": "sf_ltl",             // sf_ltl / sf_ganpei / yuantong / jd
        "province": "广东",
        "total_weight_kg": 452           // 可选，默认汇总 items 重量
    },
    "need_invoice": false
}
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, List, Dict, Any, Literal


# ============================================================
# 数据模型
# ============================================================

PricingMethod = Literal["per_kg", "per_sqm", "per_piece"]
CarrierType = Literal["sf_ltl", "sf_ganpei", "yuantong", "jd"]


@dataclass
class QuoteItem:
    """报价明细项"""
    name: str
    pricing_method: PricingMethod
    unit_price: float          # FastGPT 传入的单价（元/kg 或 元/㎡ 或 元/件）
    billing_qty: float         # 计费数量（重量/面积/件数）
    weight_kg: float = 0.0     # 单件重量（用于运费计算）
    count: int = 1             # 数量
    
    @property
    def subtotal(self) -> float:
        """单项小计 = 单价 × 计费数量 × 数量"""
        return self.unit_price * self.billing_qty * self.count
    
    @property
    def total_weight(self) -> float:
        """单项总重量 = 单件重量 × 数量"""
        return self.weight_kg * self.count


@dataclass
class ShippingInfo:
    """运费信息"""
    carrier: CarrierType
    province: str
    total_weight_kg: Optional[float] = None  # 可选，不传则自动汇总


@dataclass
class QuoteRequest:
    """报价请求（纯计算器模式）"""
    items: List[QuoteItem]
    shipping: ShippingInfo
    need_invoice: bool = False


@dataclass
class QuoteSummary:
    """报价汇总"""
    items_total: float = 0.0        # 商品总价
    shipping_cost: float = 0.0      # 运费
    subtotal_before_tax: float = 0.0  # 税前小计
    invoice_tax: float = 0.0        # 开票加税金额
    total: float = 0.0              # 最终总价


@dataclass
class QuoteResult:
    """报价结果"""
    status: str  # success / error
    items: List[Dict[str, Any]] = field(default_factory=list)
    summary: Optional[QuoteSummary] = None
    error_message: str = ""
    
    def to_dict(self) -> dict:
        """转换为字典（用于JSON返回）"""
        result = {
            "status": self.status,
            "items": self.items,
        }
        if self.summary:
            result["summary"] = {
                "items_total": round(self.summary.items_total, 2),
                "shipping_cost": round(self.summary.shipping_cost, 2),
                "subtotal_before_tax": round(self.summary.subtotal_before_tax, 2),
                "invoice_tax": round(self.summary.invoice_tax, 2),
                "total": round(self.summary.total, 2)
            }
        if self.error_message:
            result["error_message"] = self.error_message
        return result


# ============================================================
# 报价计算引擎（纯计算器）
# ============================================================

class QuotationEngine:
    """
    牛栏网报价计算引擎（纯计算器模式）
    
    核心原则：
    - 不读取产品定价数据（price_catalog.json, roll_weight_catalog.json）
    - 只加载运费费率表（shipping_rates.json）
    - 所有产品价格/重量由 FastGPT 传入
    """
    
    def __init__(self, data_dir: Optional[Path] = None):
        """
        初始化引擎
        
        Args:
            data_dir: 数据文件目录，默认为 msg-router/data/
        """
        if data_dir is None:
            data_dir = Path(__file__).parent.parent / "data"
        
        self.data_dir = data_dir
        self.shipping_rates = self._load_shipping_rates()
    
    def _load_shipping_rates(self) -> dict:
        """加载运费费率表"""
        filepath = self.data_dir / "shipping_rates.json"
        if not filepath.exists():
            raise FileNotFoundError(f"运费费率表不存在: {filepath}")
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def calculate(self, request_dict: dict) -> QuoteResult:
        """
        计算报价（入口方法）
        
        Args:
            request_dict: FastGPT 传入的 JSON 格式请求
            
        Returns:
            QuoteResult: 报价结果
        """
        try:
            # 解析请求
            items = self._parse_items(request_dict.get("items", []))
            shipping = self._parse_shipping(request_dict.get("shipping", {}))
            need_invoice = request_dict.get("need_invoice", False)
            
            if not items:
                return QuoteResult(
                    status="error",
                    error_message="items 不能为空"
                )
            
            # 计算商品总价
            items_total = sum(item.subtotal for item in items)
            items_detail = [self._item_to_dict(item) for item in items]
            
            # 计算运费
            total_weight = shipping.total_weight_kg
            if total_weight is None:
                total_weight = sum(item.total_weight for item in items)
            
            shipping_cost = self._calculate_shipping(
                shipping.carrier, 
                shipping.province, 
                total_weight
            )
            
            # 计算税前小计
            subtotal_before_tax = items_total + shipping_cost
            
            # 计算开票加税
            invoice_tax = 0.0
            if need_invoice:
                invoice_tax = subtotal_before_tax * (self.shipping_rates["tax"]["invoice_surcharge_rate"] - 1)
            
            # 计算最终总价
            total = subtotal_before_tax + invoice_tax
            
            # 组装结果
            summary = QuoteSummary(
                items_total=items_total,
                shipping_cost=shipping_cost,
                subtotal_before_tax=subtotal_before_tax,
                invoice_tax=invoice_tax,
                total=total
            )
            
            return QuoteResult(
                status="success",
                items=items_detail,
                summary=summary
            )
            
        except Exception as e:
            return QuoteResult(
                status="error",
                error_message=f"计算失败: {str(e)}"
            )
    
    def _parse_items(self, items_data: list) -> List[QuoteItem]:
        """解析商品列表"""
        items = []
        for item_dict in items_data:
            item = QuoteItem(
                name=item_dict.get("name", "未命名商品"),
                pricing_method=item_dict.get("pricing_method", "per_kg"),
                unit_price=float(item_dict.get("unit_price", 0)),
                billing_qty=float(item_dict.get("billing_qty", 0)),
                weight_kg=float(item_dict.get("weight_kg", 0)),
                count=int(item_dict.get("count", 1))
            )
            items.append(item)
        return items
    
    def _parse_shipping(self, shipping_data: dict) -> ShippingInfo:
        """解析运费信息"""
        return ShippingInfo(
            carrier=shipping_data.get("carrier", "sf_ltl"),
            province=shipping_data.get("province", "河北"),
            total_weight_kg=shipping_data.get("total_weight_kg")
        )
    
    def _item_to_dict(self, item: QuoteItem) -> dict:
        """转换商品为字典"""
        return {
            "name": item.name,
            "pricing_method": item.pricing_method,
            "unit_price": item.unit_price,
            "billing_qty": item.billing_qty,
            "weight_kg": item.weight_kg,
            "count": item.count,
            "subtotal": round(item.subtotal, 2)
        }
    
    def _calculate_shipping(self, carrier: str, province: str, total_weight_kg: float) -> float:
        """
        计算运费
        
        Args:
            carrier: 物流公司（sf_ltl / sf_ganpei / yuantong / jd）
            province: 目的省份
            total_weight_kg: 总重量（kg）
            
        Returns:
            运费（元）
        """
        carrier_data = self.shipping_rates.get(carrier)
        if not carrier_data:
            raise ValueError(f"不支持的物流公司: {carrier}")
        
        # 圆通：固定公式
        if carrier == "yuantong":
            min_weight = carrier_data.get("min_weight_kg", 5)
            if total_weight_kg < min_weight:
                return 0  # 未达起送重量
            # weight_kg * 1.8 + 4
            return total_weight_kg * 1.8 + 4
        
        # 京东：首重+续重
        if carrier == "jd":
            first_weight = carrier_data.get("first_weight_kg", 20)
            first_price = carrier_data.get("first_price", 31)
            per_kg = carrier_data.get("per_kg_after_first", 1.3)
            extra_weight = max(0, total_weight_kg - first_weight)
            return first_price + extra_weight * per_kg
        
        # 顺丰零担/干配：按省份费率
        rates = carrier_data.get("rates", {})
        province_rate = rates.get(province)
        if not province_rate:
            # 默认使用河北的费率
            province_rate = rates.get("河北", {"first_price": 20, "per_kg": 1.1})
        
        first_weight = carrier_data.get("first_weight_kg", 20)
        first_price = province_rate.get("first_price", 20)
        per_kg = province_rate.get("per_kg", 1.1)
        
        extra_weight = max(0, total_weight_kg - first_weight)
        shipping_cost = first_price + extra_weight * per_kg
        
        # 顺丰零担加保险费
        if carrier == "sf_ltl":
            insurance = carrier_data.get("insurance", {})
            if total_weight_kg < 100:
                shipping_cost += insurance.get("under_100kg", 5)
            else:
                shipping_cost += insurance.get("over_100kg", 10)
        
        return shipping_cost


# ============================================================
# 快速测试
# ============================================================

if __name__ == "__main__":
    engine = QuotationEngine()
    
    # 测试用例1：按重量计价 + 顺丰零担 + 开票
    test_request_1 = {
        "items": [
            {
                "name": "牛栏网 2.0×1.8 105cm 15cm 50m",
                "pricing_method": "per_kg",
                "unit_price": 8.5,      # FastGPT 从知识库查到的每公斤单价
                "billing_qty": 45.2,    # 卷重（FastGPT 从知识库查到）
                "weight_kg": 45.2,      # 同上
                "count": 10
            }
        ],
        "shipping": {
            "carrier": "sf_ltl",
            "province": "广东"
        },
        "need_invoice": True
    }
    
    result1 = engine.calculate(test_request_1)
    print("=" * 60)
    print("测试用例1：按重量计价 + 顺丰零担 + 开票")
    print("=" * 60)
    print(json.dumps(result1.to_dict(), ensure_ascii=False, indent=2))
    
    # 测试用例2：按面积计价 + 顺丰干配 + 不开票
    test_request_2 = {
        "items": [
            {
                "name": "均孔网 6×6cm 2.0mm",
                "pricing_method": "per_sqm",
                "unit_price": 3.15,     # FastGPT 查到的每平米单价
                "billing_qty": 52.5,    # 面积：1.05m × 50m = 52.5㎡
                "weight_kg": 38,        # 估算重量
                "count": 5
            }
        ],
        "shipping": {
            "carrier": "sf_ganpei",
            "province": "浙江"
        },
        "need_invoice": False
    }
    
    result2 = engine.calculate(test_request_2)
    print("\n" + "=" * 60)
    print("测试用例2：按面积计价 + 顺丰干配 + 不开票")
    print("=" * 60)
    print(json.dumps(result2.to_dict(), ensure_ascii=False, indent=2))
    
    # 测试用例3：多商品 + 圆通
    test_request_3 = {
        "items": [
            {
                "name": "立柱 Y型直边 1.8m",
                "pricing_method": "per_piece",
                "unit_price": 6.3,      # FastGPT 查到的单价
                "billing_qty": 1,       # 按件计价
                "weight_kg": 1.44,      # 单根重量
                "count": 50
            },
            {
                "name": "立柱 Y型花边 2.0m",
                "pricing_method": "per_piece",
                "unit_price": 9.8,
                "billing_qty": 1,
                "weight_kg": 2.2,
                "count": 30
            }
        ],
        "shipping": {
            "carrier": "yuantong",
            "province": "江苏"
        },
        "need_invoice": False
    }
    
    result3 = engine.calculate(test_request_3)
    print("\n" + "=" * 60)
    print("测试用例3：多商品 + 圆通 + 不开票")
    print("=" * 60)
    print(json.dumps(result3.to_dict(), ensure_ascii=False, indent=2))
