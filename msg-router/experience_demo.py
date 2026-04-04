"""
牛栏网报价小助手 · 体验 Demo
模拟真实业务场景：从买家咨询到 AI 生成报价话术的全流程
"""

import sys
import os
import json  # 用于演示 JSON 数据展示

# 确保能导入 msg-router/app 下的模块
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from quotation_engine import QuotationEngine, QuoteRequest, extract_params_from_text, apply_defaults
from quote_templates import QuoteResponseGenerator
from intent import infer_buyer_intent

# 预设测试用例
test_cases = [
    {
        "name": "Case 1: 参数不全（模拟小白客户）",
        "input": "老板，你们那牛栏网多少钱一米啊？"
    },
    {
        "name": "Case 2: 标准询价（参数齐全）",
        "input": "你好，我要买牛栏网。丝径 2.0x1.8，高度 105cm，网孔 15cm，50 米一卷的，先来 10 卷试试。"
    },
    {
        "name": "Case 3: 大批量询价（模拟大客户）",
        "input": "我们需要一批牧场围栏，规格是丝径 2.5x2.2，高度 180cm，网孔 15cm，卷长 100 米，一共要 50 卷，报个价。"
    },
    {
        "name": "Case 4: 只有数量（模拟含糊询价）",
        "input": "我想进 100 卷网，最便宜的那种，多少钱？"
    }
]

def run_fastgpt_simulation():
    """
    模拟 FastGPT 与 Python 报价引擎的真实交互流程。
    验证 David 提出的：FastGPT 提取参数 -> Python 计算 -> 返回结果。
    """
    print("\n🚀 **模式 2: FastGPT 集成模拟 (纯计算模式)**")
    print("场景：FastGPT 已经分析完买家意图，提取出精确参数，直接调用 Python 接口。")
    print("-" * 60)

    try:
        engine = QuotationEngine()
        
        # 模拟 FastGPT 传来的结构化参数 (无需 Python 做文本提取)
        # 这里演示的是：FastGPT 把分析好的 JSON 扔给 Python
        fastgpt_payload = {
            "wire_diameter": "2.0×1.8",
            "height": 105,           # FastGPT 已确认单位为 cm
            "mesh_width": "15cm",    # FastGPT 已补全单位
            "roll_length": 50,       # FastGPT 已识别为 50m
            "quantity": 20,          # FastGPT 已识别数量
            "mesh_type": "上疏下密",  # FastGPT 根据上下文推断或默认
            "surface_treatment": "热镀锌"
        }

        print(f"📥 **FastGPT 传入参数**：\n{json.dumps(fastgpt_payload, indent=2, ensure_ascii=False)}")

        # 构造请求
        request = QuoteRequest(**fastgpt_payload)

        # 执行计算 (不查表文本，只查数据配置)
        result = engine.calculate(request)

        print(f"\n📤 **Python 返回结果 (JSON)**：")
        # 仅展示核心计算字段，FastGPT 将拿这个去生成回复
        print(json.dumps({
            "status": result.status,
            "total_cost_per_roll_rmb": result.cost.total_cost_per_roll,
            "suggested_price_rmb": result.fob_price_per_roll * request.exchange_rate,
            "breakdown": {
                "material": result.cost.production_cost,
                "surface": result.cost.surface_treatment_cost,
                "processing": result.cost.processing_fee
            }
        }, indent=2, ensure_ascii=False))
        
        print("\n💡 **David 请看：** Python 这里只负责**纯粹的计算**，不做任何语义分析。")
        print("   逻辑是：传入参数 -> 查表/公式 -> 算出价格。")
        print("   关于【公式 vs 查表】：目前代码逻辑是 `面积 * 单价` (公式逻辑)，但单价存在 JSON 中方便您随时改价。")

    except Exception as e:
        print(f"❌ 模拟失败: {e}")

def run_demo():
    print("="*60)
    print("🚀 牛栏网 AI 报价小助手 · 体验 Demo")
    print("="*60)
    
    # 1. 先跑 FastGPT 模拟 (回应 David 关于架构的疑问)
    run_fastgpt_simulation()
    
    print("\n" + "="*60)
    print("📢 下面是旧版 Demo（包含文本提取），仅供参考...")
    print("="*60)

    # 初始化引擎
    try:
        engine = QuotationEngine()
        print("✅ 报价引擎初始化成功 (加载数据: roll_weight_catalog.json, price_catalog.json)")
    except Exception as e:
        print(f"❌ 引擎初始化失败：{e}")
        return

    print("-" * 60)

    for case in test_cases:
        print(f"\n📢 **{case['name']}**")
        print(f"🗣️ **买家说**：\"{case['input']}\"")
        
        # 1. 意图识别
        intent = infer_buyer_intent(case['input'])
        print(f"🤖 [系统识别] 意图：{intent.summary_zh}")

        # 2. 参数提取
        params = extract_params_from_text(case['input'])
        params = apply_defaults(params) # 应用默认值
        
        # 3. 构造请求
        request = QuoteRequest(
            wire_diameter=params.get('wire_diameter'),
            height=params.get('height', 0), # 0 表示缺失，会触发 incomplete
            mesh_width=params.get('mesh_width'),
            roll_length=params.get('roll_length'),
            quantity=params.get('quantity', 0),
            mesh_type=params.get('mesh_type', '上疏下密'),
            surface_treatment=params.get('surface_treatment', '热镀锌')
        )

        # 4. 计算报价
        result = engine.calculate(request)

        # 5. 生成话术
        reply = QuoteResponseGenerator.generate(result)
        
        print(f"💬 **AI 回复**：\n{reply}")
        print("-" * 60)

if __name__ == "__main__":
    run_demo()
