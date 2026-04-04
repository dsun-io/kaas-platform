"""
牛栏网报价小助手 · 体验 Demo
模拟真实业务场景：从买家咨询到 AI 生成报价话术的全流程
"""

import sys
import os

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

def run_demo():
    print("="*60)
    print("🚀 牛栏网 AI 报价小助手 · 体验 Demo")
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
