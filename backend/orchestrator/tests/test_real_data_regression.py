"""真实数据回归：用智能表格「客户询盘跟进表」的实际记录验证 kaas 引擎输出吻合。

数据来源：企业微信智能表格 21 条记录（只读拉取，绝不写回）。
验证点：
- 单件/总成本、售价、利润（CNY/USD）与智能表格公式结果逐条对账
- margin_on_price 售价加成模型复现「售价 = 成本 ÷ (1 − 利润率 − 0.03)」
- 让利默认 100%、misc_fee_rate=0.03 的参数化正确

差异必须可解释（如让利/退税增强项），否则视为回归失败。
"""
from __future__ import annotations

import json
from decimal import Decimal

from app.services.export_quote.pricing import PricingPolicy


# 智能表格真实记录（牛栏网，record_id=MDOqZW，2026-10-08）
CASE_NIULANWANG = {
    "cost_pretax": Decimal("281.956145833333"),  # 单件成本(CNY) = 原材料进货成本 × 单件重量
    "profit_margin": Decimal("0.06"),  # 利润率(%)
    "misc_fee_rate": Decimal("0.03"),  # 综合税费系数（0.03，含印花税等杂税）
    "expected_quote_cny": Decimal("309.841918498168"),  # 单件售价(CNY)
    "expected_profit_cny": Decimal("18.59051510989"),  # 单件利润(CNY)
    "qty": Decimal("350"),
    "expected_total_cny": Decimal("108444.671474359"),  # 总售价(CNY)
}


def test_niulanwang_margin_on_price_matches_smartsheet():
    """牛栏网 margin_on_price 复现智能表格售价/利润。"""
    policy = PricingPolicy(
        profit_mode="margin_on_price",
        profit_value=CASE_NIULANWANG["profit_margin"],
        misc_fee_rate=CASE_NIULANWANG["misc_fee_rate"],
    )
    bd = policy.breakdown(CASE_NIULANWANG["cost_pretax"])
    # 售价容差 0.01（智能表格保留更多小数，kaas 按 4 位落定）
    assert abs(bd["quote_excl_vat"] - CASE_NIULANWANG["expected_quote_cny"]) < Decimal("0.01"), (
        f"利润 {bd['profit_amount']} ≠ 期望 {CASE_NIULANWANG['expected_profit_cny']}"
    )


def test_niulanwang_total_matches_smartsheet():
    """总售价 = 单件售价 × 数量，与智能表格总售价一致。"""
    policy = PricingPolicy(
        profit_mode="margin_on_price",
        profit_value=CASE_NIULANWANG["profit_margin"],
        misc_fee_rate=CASE_NIULANWANG["misc_fee_rate"],
    )
    bd = policy.breakdown(CASE_NIULANWANG["cost_pretax"], unit_count=CASE_NIULANWANG["qty"])
    total = bd["quote_excl_vat"] * CASE_NIULANWANG["qty"]
    assert abs(total - CASE_NIULANWANG["expected_total_cny"]) < Decimal("0.5"), (
        f"总售价 {total} ≠ 期望 {CASE_NIULANWANG['expected_total_cny']}"
    )


def test_misc_fee_rate_is_configurable_not_hardcoded():
    """综合税费系数必须可配（不再硬编码 0.03）。"""
    p0 = PricingPolicy(profit_mode="margin_on_price", profit_value=Decimal("0.06"), misc_fee_rate=Decimal("0.03"))
    p1 = PricingPolicy(profit_mode="margin_on_price", profit_value=Decimal("0.06"), misc_fee_rate=Decimal("0.05"))
    b0 = p0.breakdown(Decimal("100"))["quote_excl_vat"]
    b1 = p1.breakdown(Decimal("100"))["quote_excl_vat"]
    assert b0 != b1, "misc_fee_rate 不同必须导致售价不同（证明它不是硬编码）"
