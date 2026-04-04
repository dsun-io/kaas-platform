"""
牛栏网报价计算引擎（Pricing Service Core）

职责：
- 根据规格参数计算卷重、成本、FOB/CIF价格
- 返回结构化报价数据（JSON）
- 100%确定性计算，无LLM参与

设计原则：
- 数据与逻辑分离（JSON配置 + Python计算）
- 所有计算路径可追溯、可测试
- 支持内贸/外贸两种场景
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ============================================================
# 数据模型
# ============================================================

@dataclass
class QuoteRequest:
    """报价请求参数"""
    wire_diameter: str           # 丝径 "2.0×1.8"
    height: int                  # 高度(cm) 90/105/120/150/180
    mesh_width: str              # 网孔宽度 "5cm"/"10cm"/"15cm"
    roll_length: int             # 卷长(m) 50或100
    quantity: int                # 数量(卷)
    mesh_type: str = "上疏下密"  # 网孔类型
    surface_treatment: str = "热镀锌"  # 表面处理
    packaging: str = "标准简包"  # 包装方式
    trade_type: str = "内贸"     # 内贸/外贸FOB/外贸CIF
    destination: Optional[str] = None  # 目的地（外贸必填）
    exchange_rate: float = 7.25  # 汇率（默认中间价）
    profit_margin: float = 0.18  # 利润率（默认18%）


@dataclass
class CostBreakdown:
    """成本明细"""
    roll_weight: float = 0.0          # 单卷重量(kg)
    production_cost: float = 0.0      # 生产成本
    surface_treatment_cost: float = 0.0  # 表面处理费
    processing_fee: float = 0.0       # 加工费
    packaging_cost: float = 0.0       # 包装费
    inland_freight: float = 0.0       # 国内运费
    customs_fee: float = 0.0          # 报关费
    
    @property
    def total_cost_per_roll(self) -> float:
        """单卷总成本"""
        return (self.roll_weight + self.production_cost + 
                self.surface_treatment_cost + self.processing_fee + 
                self.packaging_cost + self.inland_freight + self.customs_fee)
    
    @property
    def total_cost_all(self) -> float:
        """全部总成本（含数量）"""
        return self.total_cost_per_roll * self.quantity if hasattr(self, 'quantity') else self.total_cost_per_roll


@dataclass
class QuoteResult:
    """报价结果"""
    status: str                          # success/incomplete/error
    request: QuoteRequest                # 原始请求
    cost: CostBreakdown                  # 成本明细
    fob_price_per_roll: float = 0.0      # FOB单价(USD/卷)
    cif_price_per_roll: float = 0.0      # CIF单价(USD/卷)
    total_fob_price: float = 0.0         # FOB总价(USD)
    total_cif_price: float = 0.0         # CIF总价(USD)
    tax_rebate_per_roll: float = 0.0     # 退税(USD/卷)
    actual_profit_rate: float = 0.0      # 实际利润率
    missing_params: list = field(default_factory=list)  # 缺失参数
    error_message: str = ""              # 错误信息
    
    def to_dict(self) -> dict:
        """转换为字典（用于JSON返回）"""
        return {
            "status": self.status,
            "quote_data": {
                "wire_diameter": self.request.wire_diameter,
                "height": self.request.height,
                "mesh_width": self.request.mesh_width,
                "roll_length": self.request.roll_length,
                "mesh_type": self.request.mesh_type,
                "surface_treatment": self.request.surface_treatment,
                "packaging": self.request.packaging,
                "roll_weight_kg": self.cost.roll_weight,
                "production_cost_rmb": round(self.cost.production_cost, 2),
                "surface_treatment_cost_rmb": round(self.cost.surface_treatment_cost, 2),
                "processing_fee_rmb": round(self.cost.processing_fee, 2),
                "packaging_cost_rmb": round(self.cost.packaging_cost, 2),
                "total_cost_per_roll_rmb": round(self.cost.total_cost_per_roll, 2),
                "fob_price_per_roll_usd": round(self.fob_price_per_roll, 2),
                "cif_price_per_roll_usd": round(self.cif_price_per_roll, 2) if self.cif_price_per_roll else None,
                "margin_percent": round(self.request.profit_margin * 100, 1),
                "quantity": self.request.quantity,
                "total_fob_price_usd": round(self.total_fob_price, 2),
                "tax_rebate_per_roll_usd": round(self.tax_rebate_per_roll, 2),
            },
            "missing_params": self.missing_params,
            "error_message": self.error_message
        }


# ============================================================
# 报价计算引擎
# ============================================================

class QuotationEngine:
    """牛栏网报价计算引擎"""
    
    def __init__(self, data_dir: Optional[Path] = None):
        """
        初始化引擎
        
        Args:
            data_dir: 数据文件目录，默认为 msg-router/data/
        """
        if data_dir is None:
            data_dir = Path(__file__).parent.parent / "data"
        
        self.data_dir = data_dir
        self.roll_weight_catalog = self._load_json("roll_weight_catalog.json")
        self.price_catalog = self._load_json("price_catalog.json")
    
    def _load_json(self, filename: str) -> dict:
        """加载JSON配置文件"""
        filepath = self.data_dir / filename
        if not filepath.exists():
            raise FileNotFoundError(f"配置文件不存在: {filepath}")
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def calculate(self, request: QuoteRequest) -> QuoteResult:
        """
        计算报价
        
        Args:
            request: 报价请求参数
            
        Returns:
            QuoteResult: 报价结果
        """
        # 1. 校验必填参数
        missing = self._validate_request(request)
        if missing:
            return QuoteResult(
                status="incomplete",
                request=request,
                cost=CostBreakdown(),
                missing_params=missing,
                error_message=f"缺少必要参数: {', '.join(missing)}"
            )
        
        try:
            # 2. 查询卷重
            roll_weight = self._lookup_roll_weight(request)
            if roll_weight is None:
                return QuoteResult(
                    status="error",
                    request=request,
                    cost=CostBreakdown(),
                    error_message=f"未找到匹配的规格: {request.wire_diameter}/{request.height}cm/{request.mesh_width}/{request.roll_length}m"
                )
            
            # 3. 计算各项成本
            cost = self._calculate_costs(request, roll_weight)
            
            # 4. 计算FOB价格
            fob_price = self._calculate_fob(cost.total_cost_per_roll, request)
            
            # 5. 计算CIF价格（如需要）
            cif_price = 0.0
            if request.trade_type == "外贸CIF":
                cif_price = self._calculate_cif(cost.total_cost_per_roll, fob_price, request)
            
            # 6. 计算退税
            tax_rebate = self._calculate_tax_rebate(cost.total_cost_per_roll, request)
            
            # 7. 计算实际利润率
            actual_profit_rate = self._calculate_actual_profit_rate(
                cost.total_cost_per_roll, fob_price, tax_rebate, request
            )
            
            # 8. 组装结果
            result = QuoteResult(
                status="success",
                request=request,
                cost=cost,
                fob_price_per_roll=fob_price,
                cif_price_per_roll=cif_price,
                total_fob_price=fob_price * request.quantity,
                total_cif_price=cif_price * request.quantity if cif_price else 0.0,
                tax_rebate_per_roll=tax_rebate,
                actual_profit_rate=actual_profit_rate
            )
            
            return result
            
        except Exception as e:
            return QuoteResult(
                status="error",
                request=request,
                cost=CostBreakdown(),
                error_message=f"计算失败: {str(e)}"
            )
    
    def _validate_request(self, request: QuoteRequest) -> list:
        """校验必填参数"""
        missing = []
        
        if not request.wire_diameter:
            missing.append("wire_diameter")
        if not request.height:
            missing.append("height")
        if not request.mesh_width:
            missing.append("mesh_width")
        if not request.roll_length:
            missing.append("roll_length")
        if not request.quantity or request.quantity <= 0:
            missing.append("quantity")
        
        # 外贸需要目的地
        if request.trade_type in ["外贸FOB", "外贸CIF"] and not request.destination:
            missing.append("destination")
        
        return missing
    
    def _lookup_roll_weight(self, request: QuoteRequest) -> Optional[float]:
        """查询卷重"""
        try:
            wire_data = self.roll_weight_catalog.get(request.wire_diameter)
            if not wire_data:
                return None
            
            height_data = wire_data.get(str(request.height))
            if not height_data:
                return None
            
            mesh_data = height_data.get(request.mesh_width)
            if not mesh_data:
                return None
            
            weight = mesh_data.get(str(request.roll_length))
            return float(weight) if weight else None
            
        except (KeyError, TypeError):
            return None
    
    def _calculate_costs(self, request: QuoteRequest, roll_weight: float) -> CostBreakdown:
        """计算各项成本"""
        cost = CostBreakdown()
        cost.roll_weight = roll_weight
        cost.quantity = request.quantity
        
        # 根据网孔类型选择计算模型
        if request.mesh_type == "均孔":
            # 均孔网：按面积计算（面积 × 每平米单价）
            # 面积 (㎡) = 高度(m) × 卷长(m)
            height_m = request.height / 100.0
            length_m = request.roll_length
            area_sqm = height_m * length_m
            
            price_per_sqm = self.price_catalog.get("price_per_sqm", {}).get(request.wire_diameter, 15.0)
            cost.production_cost = area_sqm * price_per_sqm
            
        elif request.mesh_type == "立柱":
            # 立柱：按固定单价计算
            post_price = self.price_catalog.get("post_unit_prices", {}).get(request.wire_diameter, 5.0)
            cost.production_cost = post_price
            cost.roll_weight = 0 # 立柱不按重量算生产成本
            # 立柱通常不需要额外的表面处理费（已含）
            cost.surface_treatment_cost = 0
            cost.processing_fee = 0 # 无加工费
            cost.packaging_cost = 0 # 简单包装或无
            
        else:
            # 默认/上疏下密：按重量计算（卷重 × 每公斤单价）
            cost_per_kg = self.price_catalog["cost_per_kg"].get(request.wire_diameter, 8.5)
            cost.production_cost = roll_weight * cost_per_kg
        
        # 2. 表面处理费
        surface_data = self.price_catalog["surface_treatment"].get(request.surface_treatment, {})
        cost.surface_treatment_cost = surface_data.get(str(request.height), 105)
        
        # 3. 加工费
        cost.processing_fee = self.price_catalog["processing_fee"].get(request.mesh_type, 25)
        
        # 4. 包装费
        cost.packaging_cost = self.price_catalog["packaging"].get(request.packaging, 0)
        
        # 5. 国内运费（简化计算，实际应调用物流API）
        if request.trade_type == "内贸":
            # 圆通运费计算
            freight_rule = self.price_catalog["inland_freight"]["圆通"]
            if roll_weight >= freight_rule["min_weight_kg"]:
                cost.inland_freight = roll_weight * 1.8 + 4
            else:
                cost.inland_freight = 0  # 小重量免运费
        
        # 6. 报关费
        cost.customs_fee = self.price_catalog["customs_clearance"].get(request.trade_type, 0)
        # 报关费是按票计算，不是按卷
        if cost.customs_fee > 0:
            cost.customs_fee = cost.customs_fee / request.quantity
        
        return cost
    
    def _calculate_fob(self, total_cost: float, request: QuoteRequest) -> float:
        """计算FOB价格（USD/卷）"""
        # FOB = 总成本 × (1 + 利润率) ÷ 汇率
        fob_rmb = total_cost * (1 + request.profit_margin)
        fob_usd = fob_rmb / request.exchange_rate
        return round(fob_usd, 2)
    
    def _calculate_cif(self, total_cost: float, fob_price: float, request: QuoteRequest) -> float:
        """计算CIF价格（USD/卷）"""
        if not request.destination:
            return 0.0
        
        # 海运费
        ocean_freight = self.price_catalog["ocean_freight"].get(request.destination, 65)
        
        # 保险费 = CIF × 0.3%
        # CIF = FOB + 海运费 + 保险费
        # CIF × (1 - 0.003) = FOB + 海运费
        cif_before_insurance = fob_price + ocean_freight
        cif_price = cif_before_insurance / (1 - 0.003)
        
        return round(cif_price, 2)
    
    def _calculate_tax_rebate(self, total_cost: float, request: QuoteRequest) -> float:
        """计算退税（USD/卷）"""
        rebate_rate = self.price_catalog["tax_rebate_rate"].get("丝网类产品", 0.13)
        
        # 退税 = 总成本 ÷ 1.13 × 13% ÷ 汇率
        rebate_rmb = total_cost / 1.13 * rebate_rate
        rebate_usd = rebate_rmb / request.exchange_rate
        
        return round(rebate_usd, 2)
    
    def _calculate_actual_profit_rate(self, total_cost: float, fob_price: float, 
                                      tax_rebate: float, request: QuoteRequest) -> float:
        """计算实际利润率（含退税）"""
        # 实际利润 = (FOB价格 × 汇率 - 总成本) + 退税×汇率
        profit_rmb = (fob_price * request.exchange_rate - total_cost) + (tax_rebate * request.exchange_rate)
        profit_rate = profit_rmb / (total_cost * request.exchange_rate) if total_cost > 0 else 0
        
        return round(profit_rate, 4)


# ============================================================
# 参数提取辅助函数
# ============================================================

def extract_params_from_text(text: str) -> dict:
    """
    从自然语言提取报价参数
    
    Args:
        text: 用户输入的自然语言
        
    Returns:
        提取到的参数字典
    """
    params = {}
    
    # 提取丝径
    wire_match = re.search(r'丝径[：:]?\s*(\d+\.?\d*)\s*[×xX]\s*(\d+\.?\d*)', text)
    if wire_match:
        params['wire_diameter'] = f"{wire_match.group(1)}×{wire_match.group(2)}"
    
    # 提取高度
    height_match = re.search(r'高度[：:]?\s*(\d+)\s*cm', text, re.IGNORECASE)
    if height_match:
        params['height'] = int(height_match.group(1))
    
    # 提取网孔宽度
    mesh_match = re.search(r'网孔[：:]?\s*(\d+)\s*cm', text, re.IGNORECASE)
    if mesh_match:
        params['mesh_width'] = f"{mesh_match.group(1)}cm"
    
    # 提取卷长
    roll_match = re.search(r'卷长[：:]?\s*(\d+)\s*m', text, re.IGNORECASE)
    if roll_match:
        params['roll_length'] = int(roll_match.group(1))
    
    # 提取数量
    qty_match = re.search(r'(\d+)\s*卷', text)
    if qty_match:
        params['quantity'] = int(qty_match.group(1))
    
    return params


def apply_defaults(params: dict) -> dict:
    """
    应用默认值
    
    Args:
        params: 已提取的参数
        
    Returns:
        应用默认值后的参数
    """
    defaults = {
        'wire_diameter': '2.0×1.8',
        'height': None,  # 必须追问
        'mesh_width': '15cm',
        'roll_length': 50,
        'quantity': 1,
        'mesh_type': '上疏下密',
        'surface_treatment': '热镀锌',
        'packaging': '标准简包',
        'trade_type': '内贸',
        'exchange_rate': 7.25,
        'profit_margin': 0.18
    }
    
    for key, value in defaults.items():
        if key not in params:
            params[key] = value
    
    return params


# ============================================================
# 快速测试
# ============================================================

if __name__ == "__main__":
    # 初始化引擎
    engine = QuotationEngine()
    
    # 测试用例1：完整参数
    request1 = QuoteRequest(
        wire_diameter="2.0×1.8",
        height=105,
        mesh_width="15cm",
        roll_length=50,
        quantity=10,
        trade_type="内贸"
    )
    result1 = engine.calculate(request1)
    print("=" * 60)
    print("测试用例1：完整参数（内贸）")
    print("=" * 60)
    print(json.dumps(result1.to_dict(), ensure_ascii=False, indent=2))
    
    # 测试用例2：参数不全
    request2 = QuoteRequest(
        wire_diameter="2.0×1.8",
        height=0,  # 缺失
        mesh_width="15cm",
        roll_length=50,
        quantity=0  # 缺失
    )
    result2 = engine.calculate(request2)
    print("\n" + "=" * 60)
    print("测试用例2：参数不全")
    print("=" * 60)
    print(json.dumps(result2.to_dict(), ensure_ascii=False, indent=2))
    
    # 测试用例3：从文本提取参数
    text = "牛栏网 丝径2.0×1.8 高度105cm 网孔15cm 50m卷 10卷"
    params = extract_params_from_text(text)
    print("\n" + "=" * 60)
    print("测试用例3：从文本提取参数")
    print("=" * 60)
    print(f"提取结果: {params}")
