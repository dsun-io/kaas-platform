"""
话术模板引擎（Response Template Generator）

职责：
- 根据报价结果生成自然语言回复
- 支持多种场景（标准报价、参数不全、议价、外贸等）
- 零Token消耗（纯模板渲染）

设计原则：
- 模板与数据分离
- 支持变量插值和条件渲染
- 易于扩展新场景
"""

from __future__ import annotations

from typing import Optional
from app.quotation_engine import QuoteResult


class QuoteResponseGenerator:
    """报价话术生成器"""
    
    @staticmethod
    def generate(result: QuoteResult, context: Optional[dict] = None) -> str:
        """
        根据报价结果生成回复话术
        
        Args:
            result: 报价结果
            context: 额外上下文（如客户称呼、历史对话等）
            
        Returns:
            自然语言回复
        """
        if result.status == "incomplete":
            return QuoteResponseGenerator._generate_incomplete_params(result)
        elif result.status == "error":
            return QuoteResponseGenerator._generate_error(result)
        elif result.status == "success":
            if result.request.trade_type in ["外贸FOB", "外贸CIF"]:
                return QuoteResponseGenerator._generate_foreign_trade(result)
            else:
                return QuoteResponseGenerator._generate_domestic(result)
        else:
            return "报价计算出现异常，请稍后重试或联系人工客服。"
    
    @staticmethod
    def _generate_domestic(result: QuoteResult) -> str:
        """生成内贸报价话术"""
        req = result.request
        cost = result.cost
        
        template = (
            f"根据您需要的规格：\n"
            f"• 丝径：{req.wire_diameter}\n"
            f"• 高度：{req.height}cm\n"
            f"• 网孔：{req.mesh_width}\n"
            f"• 卷长：{req.roll_length}m\n"
            f"• 网孔结构：{req.mesh_type}\n"
            f"• 表面处理：{req.surface_treatment}\n\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"💰 报价明细：\n"
            f"• 单卷重量：{cost.roll_weight:.1f}kg\n"
            f"• 生产成本：¥{cost.production_cost:.2f}\n"
            f"• 表面处理：¥{cost.surface_treatment_cost:.2f}\n"
            f"• 加工费：¥{cost.processing_fee:.2f}\n"
            f"• 包装费：¥{cost.packaging_cost:.2f}\n"
            f"• 单卷总价成本：¥{cost.total_cost_per_roll:.2f}\n\n"
            f"💵 报价：¥{result.fob_price_per_roll * req.exchange_rate:.2f}/卷（含{req.profit_margin*100:.0f}%利润）\n"
            f"📦 {req.quantity}卷总价：¥{result.total_fob_price * req.exchange_rate:.2f}\n\n"
            f"🚚 交期：约7-10天\n"
            f"💳 付款：款到发货（支持支付宝/微信/银行转账）\n\n"
            f"需要看其他规格或者量大优惠吗？"
        )
        
        return template
    
    @staticmethod
    def _generate_foreign_trade(result: QuoteResult) -> str:
        """生成外贸报价话术"""
        req = result.request
        cost = result.cost
        
        trade_term = "FOB" if req.trade_type == "外贸FOB" else "CIF"
        price = result.fob_price_per_roll if req.trade_type == "外贸FOB" else result.cif_price_per_roll
        total_price = result.total_fob_price if req.trade_type == "外贸FOB" else result.total_cif_price
        
        template = (
            f"根据您需要的规格：\n"
            f"• Product: Cattle Fence Wire Mesh\n"
            f"• Wire Dia.: {req.wire_diameter}mm\n"
            f"• Height: {req.height}cm\n"
            f"• Mesh Width: {req.mesh_width}\n"
            f"• Roll Length: {req.roll_length}m\n"
            f"• Surface: {req.surface_treatment}\n\n"
            f"━━━━━━━━━━━━━━━━━━━━\n"
            f"💰 Quotation ({trade_term}):\n"
            f"• Roll Weight: {cost.roll_weight:.1f}kg\n"
            f"• Unit Price: ${price:.2f}/roll\n"
            f"• Quantity: {req.quantity} rolls\n"
            f"• Total Amount: ${total_price:.2f}\n\n"
        )
        
        if req.trade_type == "外贸CIF":
            template += f"• Destination Port: {req.destination}\n"
            template += f"• Include ocean freight & insurance\n\n"
        
        template += (
            f"📦 Lead Time: 7-10 days after deposit\n"
            f"💳 Payment: T/T 30% deposit, 70% before shipment\n"
            f"📄 Valid for 15 days\n\n"
            f"Need CIF price for other ports or quantity discount?"
        )
        
        return template
    
    @staticmethod
    def _generate_incomplete_params(result: QuoteResult) -> str:
        """生成参数不全时的追问话术"""
        missing = result.missing_params
        
        # 字段中文名映射
        field_names = {
            "wire_diameter": "丝径（如2.0×1.8）",
            "height": "高度（如90/105/120/150/180cm）",
            "mesh_width": "网孔宽度（如5/10/15cm）",
            "roll_length": "卷长（50m或100m）",
            "quantity": "数量（多少卷）",
            "destination": "目的港（如东南亚/欧洲/北美）"
        }
        
        missing_cn = [field_names.get(m, m) for m in missing]
        
        template = (
            f"为了给您准确报价，还需要确认以下信息：\n\n"
            f"❓ {', '.join(missing_cn)}\n\n"
            f"您方便提供一下吗？提供后我马上给您算价格。"
        )
        
        return template
    
    @staticmethod
    def _generate_error(result: QuoteResult) -> str:
        """生成错误提示话术"""
        template = (
            f"抱歉，报价计算出现异常：\n"
            f"❌ {result.error_message}\n\n"
            f"请检查参数是否正确，或联系人工客服协助处理。"
        )
        return template
    
    @staticmethod
    def generate_negotiation_response(result: QuoteResult, customer_offer: float) -> str:
        """
        生成议价回应话术
        
        Args:
            result: 原报价结果
            customer_offer: 客户出价（USD）
            
        Returns:
            议价回应话术
        """
        original_price = result.fob_price_per_roll
        diff_percent = (customer_offer - original_price) / original_price * 100
        
        if diff_percent >= -5:
            # 客户出价接近或高于原价，可以接受
            template = (
                f"您出的价格${customer_offer:.2f}/卷我们可以接受。\n"
                f"这个价格我们利润比较低，需要您确认：\n"
                f"• 数量：{result.request.quantity}卷\n"
                f"• 单价：${customer_offer:.2f}/卷\n"
                f"• 总价：${customer_offer * result.request.quantity:.2f}\n\n"
                f"确认没问题的话我就给您做合同。"
            )
        elif diff_percent >= -15:
            # 客户出价低但可协商
            template = (
                f"您出的价格${customer_offer:.2f}/卷确实比我们报价低一些。\n"
                f"我们目前的报价${original_price:.2f}是基于：\n"
                f"• 热镀锌工艺，质保10年\n"
                f"• 国标丝径，足米足重\n"
                f"• 含出口包装和报关\n\n"
                f"如果您数量能到{result.request.quantity * 2}卷以上，\n"
                f"我可以向公司申请优惠到${original_price * 0.95:.2f}/卷，您看可以吗？"
            )
        else:
            # 客户出价太低，需要解释
            template = (
                f"您出的价格${customer_offer:.2f}/卷我们确实做不了。\n"
                f"给您透个底，我们成本都要${result.cost.total_cost_per_roll / result.request.exchange_rate:.2f}/卷了：\n"
                f"• 原材料：¥{result.cost.production_cost:.2f}\n"
                f"• 表面处理：¥{result.cost.surface_treatment_cost:.2f}\n"
                f"• 加工+包装：¥{result.cost.processing_fee + result.cost.packaging_cost:.2f}\n\n"
                f"这个价格已经是行业底价了，您可以对比其他家。\n"
                f"我们是安平大厂，质量和服务都有保障。"
            )
        
        return template
    
    @staticmethod
    def generate_quantity_discount(result: QuoteResult, new_quantity: int) -> str:
        """
        生成量大优惠话术
        
        Args:
            result: 原报价结果
            new_quantity: 新数量
            
        Returns:
            量大优惠话术
        """
        original_qty = result.request.quantity
        discount_rate = 0.0
        
        if new_quantity >= 100:
            discount_rate = 0.12
        elif new_quantity >= 50:
            discount_rate = 0.08
        elif new_quantity >= 30:
            discount_rate = 0.05
        else:
            discount_rate = 0.02
        
        new_price = result.fob_price_per_roll * (1 - discount_rate)
        new_total = new_price * new_quantity
        
        template = (
            f"您如果数量从{original_qty}卷增加到{new_quantity}卷，\n"
            f"可以申请{discount_rate*100:.0f}%优惠：\n\n"
            f"• 原价：${result.fob_price_per_roll:.2f}/卷\n"
            f"• 优惠后：${new_price:.2f}/卷\n"
            f"• {new_quantity}卷总价：${new_total:.2f}\n"
            f"• 节省：${(result.fob_price_per_roll - new_price) * new_quantity:.2f}\n\n"
            f"这个价格很合适，要给您锁单吗？"
        )
        
        return template


# ============================================================
# 快速测试
# ============================================================

if __name__ == "__main__":
    from app.quotation_engine import QuotationEngine, QuoteRequest
    
    # 初始化引擎
    engine = QuotationEngine()
    
    # 测试1：内贸报价
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
    print("测试1：内贸报价话术")
    print("=" * 60)
    print(QuoteResponseGenerator.generate(result1))
    
    # 测试2：外贸FOB报价
    request2 = QuoteRequest(
        wire_diameter="2.0×1.8",
        height=105,
        mesh_width="15cm",
        roll_length=50,
        quantity=20,
        trade_type="外贸FOB",
        destination="东南亚"
    )
    result2 = engine.calculate(request2)
    
    print("\n" + "=" * 60)
    print("测试2：外贸FOB报价话术")
    print("=" * 60)
    print(QuoteResponseGenerator.generate(result2))
    
    # 测试3：参数不全
    request3 = QuoteRequest(
        wire_diameter="2.0×1.8",
        height=0,
        mesh_width="15cm",
        roll_length=50,
        quantity=0
    )
    result3 = engine.calculate(request3)
    
    print("\n" + "=" * 60)
    print("测试3：参数不全追问话术")
    print("=" * 60)
    print(QuoteResponseGenerator.generate(result3))
