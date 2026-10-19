"""出口报价内核测试：价链口径、命名、税法正确性。

锁定的事实：
  · 销项税的计税基数是**售价**，不是成本
  · 退税退的是**进项增值税额**，可退进项增值税税额 = 进项税额 × (退税率 ÷ 征税率)
  · 印花税定义已删除（2026-10-19 用户裁决）：并入杂税，政策只有 misc_fee_rate
    一个综合税费旋钮；旧请求里的 stamp_rate/stamp_base 传入即忽略
  · 售价不随税制漂移（退还与抵扣价值相同）
  · 价链等价式：不含税售价 = 成本 + 利润 + 不可退进项税额 + 自留可退税额 + 综合税费附加额
"""
from decimal import Decimal

import pytest

from app.services.export_quote.numeric import FRACTION, to_decimal
from app.services.export_quote.pricing import ExtraFee, PricingPolicy, PricingError, policy_from_dict
from app.services.export_quote.terms import FeeItem, TermLadder, TermRung, TermsError, ladder_from_dict

pytestmark = pytest.mark.unit

D = Decimal


def Q(x, nd=4):
    return D(x).quantize(D(1).scaleb(-nd))


def policy(**kw):
    base = dict(
        input_vat_rate=D("0.10"),
        profit_mode="fixed",
        profit_value=D("0.1"),
        give_ratio=D("0.8"),
        refund_ratio=D("1"),
    )
    base.update(kw)
    return PricingPolicy(**base)


class TestPriceChain:
    def test_export_full_refund_matches_hand_verified_numbers(self):
        """出口零税率 + 全额可回收 → 不含税售价 4.6028（客户人工核对值）。"""
        bd = policy(output_vat_rate=D("0")).breakdown(D("4.4"))
        assert bd["cost_incl"] == D("4.8889")
        assert bd["profit_amount"] == D("0.1000")
        assert bd["pretax_quote"] == D("4.5000")
        assert bd["base_quote"] == D("4.9889")
        assert bd["input_vat"] == D("0.4889")
        assert bd["refundable_input_vat"] == D("0.4889")
        assert bd["non_refundable_input_vat"] == D("0.0000")
        assert bd["give_amount"] == D("0.3911")
        assert bd["retained_refundable"] == D("0.0978")
        assert bd["stamp_duty"] == D("0")
        assert bd["quote_excl_vat"] == D("4.5978")
        assert bd["output_vat"] == D("0.0000")
        assert bd["quote_incl_vat"] == D("4.5978")

    def test_high_zinc_tier(self):
        bd = policy().breakdown(D("5.6"))
        assert bd["quote_excl_vat"] == D("5.8244")
        assert bd["input_vat"] == D("0.6222")
        assert bd["give_amount"] == D("0.4978")

    def test_refund_ratio_from_rebate_over_invoice_point(self):
        """可退税比例 = 出口退税率 ÷ **进项票税点**；差额成为不可退进项税额（真成本）。

        分母是进项票税点（供应商发票上的实际税点），不是法定征税率 ——
        要回答的是「实际交出去的进项税额里有多少能退回来」。
        """
        bd = policy(
            refund_ratio="auto", rebate_rate=D("0.09"), input_vat_rate=D("0.10")
        ).breakdown(D("4.4"))
        assert bd["refund_ratio_used"] == D("0.900000")
        assert bd["input_vat"] == D("0.4889")
        assert bd["refundable_input_vat"] == D("0.4400")
        assert bd["non_refundable_input_vat"] == D("0.0489")
        # 回收不到的部分抬高售价
        assert bd["quote_excl_vat"] == D("4.6369")

    def test_partial_refund_is_more_expensive_than_full(self):
        """退税率低于进项票税点 → 退不满 → 不可退部分抬高售价。"""
        full = policy().breakdown(D("4.4"))["quote_excl_vat"]
        part = policy(
            refund_ratio="auto", rebate_rate=D("0.09"), input_vat_rate=D("0.10")
        ).breakdown(D("4.4"))["quote_excl_vat"]
        assert part > full

    def test_ratio_one_when_rebate_equals_invoice_point(self):
        """退税率 = 进项票税点 → 全额可退。"""
        bd = policy(
            refund_ratio="auto", rebate_rate=D("0.10"), input_vat_rate=D("0.10")
        ).breakdown(D("4.4"))
        assert bd["refund_ratio_used"] == D("1.000000")
        assert bd["non_refundable_input_vat"] == D("0.0000")


class TestRefundRatioCappedAtInputVat:
    """「取低的那个」：可退进项增值税税额以**实际缴纳的进项税额**为上限。

    不能退得比交的多 —— 没交过的税退不回来。
    """

    def test_rebate_above_invoice_point_is_capped(self):
        """丝厂开票价税点 10%，出口退税率 13% → 按 10 点（取低），比例封顶 1。"""
        pol = policy(refund_ratio="auto", rebate_rate=D("0.13"))
        ratio, warn = pol.resolve_refund_ratio()
        assert ratio == D("1"), "应取低者，比例封顶为 1"
        assert warn and "上限" in warn
        bd = pol.breakdown(D("4.4"))
        assert bd["input_vat"] == D("0.4889")
        assert bd["refundable_input_vat"] == D("0.4889")
        assert bd["non_refundable_input_vat"] == D("0.0000")

    def test_policy_has_no_levy_rate_knob(self):
        """征税率已从设计上删除。

        它的存在本身就会诱导后人拿它当分母 —— 历史上就是这么错的
        （可退税比例的分母应该是「进项票税点」）。这里钉住：它不得回来。
        """
        assert "levy_rate" not in PricingPolicy.__dataclass_fields__

    def test_refundable_never_exceeds_input_vat_for_any_rebate(self):
        """横扫一片退税率（含高于税点的），可退额恒 ≤ 进项税额。"""
        for rebate in ("0.13", "0.10", "0.09", "0.20", "0.01"):
            bd = policy(refund_ratio="auto", rebate_rate=D(rebate),
                        input_vat_rate=D("0.10")).breakdown(D("4.4"))
            assert D(str(bd["refundable_input_vat"])) <= D(str(bd["input_vat"])), rebate

    def test_explicit_ratio_above_one_is_capped_not_error(self):
        """显式给 1.3 也按 1 计 —— 报错会阻断出单，封顶 + 提示更合适。"""
        pol = policy(refund_ratio=D("1.3"))
        ratio, warn = pol.resolve_refund_ratio()
        assert ratio == D("1")
        assert warn
        bd = pol.breakdown(D("4.4"))
        assert bd["refundable_input_vat"] == bd["input_vat"]

    def test_capping_does_not_change_the_baseline_quote(self):
        """封顶不改变基准报价：基准本来就是「全额可回收」。"""
        assert policy().breakdown(D("4.4"))["quote_excl_vat"] == D("4.5978")
        assert policy(
            refund_ratio="auto", rebate_rate=D("0.13")
        ).breakdown(D("4.4"))["quote_excl_vat"] == D("4.5978")

    def test_rebate_below_invoice_point_still_discounts(self):
        """退税率 9% < 进项票税点 10%，差额成为不可退成本。"""
        pol = policy(refund_ratio="auto", rebate_rate=D("0.09"), input_vat_rate=D("0.10"))
        ratio, warn = pol.resolve_refund_ratio()
        assert ratio == D("0.9")
        assert warn is None
        bd = pol.breakdown(D("4.4"))
        assert bd["refundable_input_vat"] < bd["input_vat"]
        assert bd["non_refundable_input_vat"] == D("0.0489")

    def test_invoice_point_zero_is_unconfigured_not_a_divisor(self):
        """进项票税点为 0 → 视为「未配置」，不去做除零，退回全额并提示。"""
        ratio, warn = policy(
            refund_ratio="auto", rebate_rate=D("0.13"), input_vat_rate=D("0")
        ).resolve_refund_ratio()
        assert ratio == D("1")
        assert warn and "未配置" in warn

    def test_negative_invoice_point_raises(self):
        with pytest.raises(PricingError, match="进项票税点"):
            policy(refund_ratio="auto", rebate_rate=D("0.13"),
                   input_vat_rate=D("-0.13")).resolve_refund_ratio()

    def test_negative_ratio_raises(self):
        with pytest.raises(PricingError, match="可退税比例"):
            policy(refund_ratio=D("-0.1")).breakdown(D("4.4"))


class TestOutputVat:
    """销项税：价外税，计税基数是售价。"""

    def test_output_vat_is_computed_on_selling_price_not_cost(self):
        bd = policy(output_vat_rate=D("0.13")).breakdown(D("4.4"))
        assert bd["quote_excl_vat"] == D("4.5978")
        assert bd["output_vat"] == Q(D("4.5978") * D("0.13"))
        # 明确排除两种错误基数
        assert bd["output_vat"] != Q(D("4.4") * D("0.13")), "不能按税前成本算"
        assert bd["output_vat"] != Q(D("4.8889") * D("0.13")), "不能按含税采购价算"

    def test_output_vat_added_on_top(self):
        bd = policy(output_vat_rate=D("0.13")).breakdown(D("4.4"))
        assert bd["quote_incl_vat"] == D("5.1955")
        assert bd["quote_incl_vat"] == bd["quote_excl_vat"] + bd["output_vat"]

    def test_output_vat_zero_for_export(self):
        bd = policy(output_vat_rate=D("0")).breakdown(D("4.4"))
        assert bd["output_vat"] == D("0.0000")
        assert bd["quote_incl_vat"] == bd["quote_excl_vat"]

    def test_selling_price_does_not_drift_between_regimes(self):
        """进项税「退还」与「抵扣」价值相同 ⇒ 售价不受销项税率影响。"""
        export = policy(output_vat_rate=D("0")).breakdown(D("4.4"))
        domestic = policy(output_vat_rate=D("0.13")).breakdown(D("4.4"))
        assert export["quote_excl_vat"] == domestic["quote_excl_vat"] == D("4.5978")
        assert export["give_amount"] == domestic["give_amount"] == D("0.3911")
        assert export["retained_refundable"] == domestic["retained_refundable"] == D("0.0978")
        assert domestic["output_vat"] > export["output_vat"]

    def test_inclusive_mode_extracts_instead_of_adding(self):
        bd = policy(output_vat_rate=D("0.13"), output_vat_mode="inclusive").breakdown(D("4.4"))
        assert bd["quote_incl_vat"] == D("4.5978")
        assert bd["output_vat"] == D("0.5290")
        assert bd["quote_excl_vat"] == D("4.0688")
        assert bd["quote_excl_vat"] + bd["output_vat"] == bd["quote_incl_vat"]

    def test_unknown_vat_mode_rejected(self):
        with pytest.raises(PricingError, match="销项税模式"):
            policy(output_vat_mode="nonsense").breakdown(D("4.4"))


class TestStampDuty:
    """印花税定义已删除（2026-10-19 用户裁决：并入杂税）。

    旧请求里的 stamp_rate/stamp_base 是**无效输入**：引擎忽略、不报错、
    不影响任何价链数值（consistency_warnings 会提示迁移到 misc_fee_rate）。
    """

    def test_stamp_rate_is_ignored(self):
        plain = policy().breakdown(D("4.4"))
        legacy = policy(stamp_rate=D("0.05"), stamp_base="profit").breakdown(D("4.4"))
        assert legacy["stamp_duty"] == plain["stamp_duty"] == D("0")
        assert legacy["quote_excl_vat"] == plain["quote_excl_vat"] == D("4.5978")

    def test_stamp_base_no_longer_validated(self):
        """基数曾是可选 profix/cost/base_quote —— 定义删除后任意值都被忽略。"""
        bd = policy(stamp_rate=D("0.05"), stamp_base="nonsense").breakdown(D("4.4"))
        assert bd["stamp_duty"] == D("0")

    def test_legacy_stamp_fields_warn(self):
        warns = policy(stamp_rate=D("0.05"), stamp_base="profit").consistency_warnings()
        assert any("已删除" in w and "misc_fee_rate" in w for w in warns)
        # 干净配置（不带 legacy 字段）无告警
        assert policy().consistency_warnings() == []


class TestMiscFeeSurcharge:
    """综合税费（杂税，含已并入的印花税）归并后的统一口径。

    归并目标（2026-10-19 用户裁决）：印花税定义删除，政策/档案只有
    misc_fee_rate 一个综合税费旋钮，口径不在 fixed/ratio 与
    margin_on_price 两个利润模式间分叉。
    """

    def test_misc_fee_rate_effective_in_fixed_mode(self):
        """旧实现里 misc_fee_rate 在 fixed/ratio 下是静默空旋钮 —— 现在必须生效。"""
        bd = policy(misc_fee_rate=D("0.03")).breakdown(D("4.4"))
        # 综合税费附加额 = 基础报价 × 综合税费系数
        assert bd["stamp_duty"] == Q(D("4.9889") * D("0.03"))
        # 附加额进入不含税售价（价链闭合由 breakdown 自检保证）
        assert bd["quote_excl_vat"] == Q(D("4.9889") - D("0.3911") + bd["stamp_duty"])

    def test_misc_fee_rate_effective_in_ratio_mode(self):
        bd = policy(profit_mode="ratio", profit_value=D("0.06"),
                    misc_fee_rate=D("0.03")).breakdown(D("4.0"))
        assert bd["stamp_duty"] == Q(bd["base_quote"] * D("0.03"))
        assert bd["quote_excl_vat"] == Q(bd["base_quote"] - bd["give_amount"] + bd["stamp_duty"])

    def test_misc_fee_rate_additive_to_chain_not_mode_fork(self):
        """同一个杂税率在 fixed 与 margin 两种模式下都体现为「综合税费进售价」。"""
        fixed_bd = policy(misc_fee_rate=D("0.03")).breakdown(D("4.4"))
        margin_bd = policy(profit_mode="margin_on_price", profit_value=D("0.1"),
                           misc_fee_rate=D("0.03")).breakdown(D("4.4"))
        # fixed/ratio：附加额显式出现在价链里；margin：含在售价公式分母里（附加额为 0）
        assert fixed_bd["stamp_duty"] > 0
        assert margin_bd["stamp_duty"] == 0
        # 两种模式下含杂税的售价都必须高于无杂税口径
        fixed_plain = policy().breakdown(D("4.4"))
        margin_plain = policy(profit_mode="margin_on_price", profit_value=D("0.1")).breakdown(D("4.4"))
        assert fixed_bd["quote_excl_vat"] > fixed_plain["quote_excl_vat"]
        assert margin_bd["quote_excl_vat"] > margin_plain["quote_excl_vat"]

    def test_from_dict_misc_fee_rate_flows_into_fixed_mode(self):
        """税务档案下发的 misc_fee_rate 经 policy_from_dict 在 fixed/ratio 下生效。"""
        p = policy_from_dict({
            "input_vat_rate": 0.10,
            "profit": {"mode": "fixed", "value": 0.1},
            "refund": {"refund_ratio": 1, "give_ratio": 0.8},
            "misc_fee_rate": 0.03,
        })
        bd = p.breakdown(D("4.4"))
        assert bd["stamp_duty"] == Q(D("4.9889") * D("0.03"))


class TestSettlement:
    """纳税结算：销项与进项相抵，可退进项增值税税额只被用掉一次。"""

    def test_vat_payable_nets_output_against_input(self):
        bd = policy(output_vat_rate=D("0.13")).breakdown(D("4.4"))
        assert bd["vat_payable"] == Q(D("0.5977") - D("0.4889"))
        assert bd["vat_carryforward"] == D("0.0000")

    def test_carryforward_for_export(self):
        bd = policy(output_vat_rate=D("0")).breakdown(D("4.4"))
        assert bd["vat_payable"] == D("0.0000")
        assert bd["vat_carryforward"] == D("0.4889")
        assert bd["refund_receivable"] == D("0.4889")

    def test_input_tax_consumed_exactly_once(self):
        for rate in ("0", "0.13"):
            bd = policy(output_vat_rate=D(rate)).breakdown(D("4.4"))
            assert bd["give_amount"] + bd["retained_refundable"] == bd["refundable_input_vat"], rate

    def test_export_cash_flow_closes(self):
        bd = policy(output_vat_rate=D("0")).breakdown(D("4.4"))
        net = (
            bd["quote_incl_vat"] - bd["cost_incl"] + bd["refund_receivable"]
            - bd["vat_payable"] - bd["stamp_duty"]
        )
        assert net == bd["profit_amount"] + bd["retained_refundable"]

    def test_domestic_cash_flow_closes(self):
        bd = policy(output_vat_rate=D("0.13")).breakdown(D("4.4"))
        net = (
            bd["quote_incl_vat"] - bd["cost_incl"]
            - bd["vat_payable"] - bd["stamp_duty"]
        )
        assert net == bd["profit_amount"] + bd["retained_refundable"]


class TestIdentity:
    def test_identity_holds_across_rates_and_costs(self):
        """核心等价式，覆盖 可退税比例 < 1 与销项税 ≠ 0 的一般情形。"""
        for out_rate in ("0", "0.13"):
            for rr, kw in (
                (D("1"), {}),
                ("auto", {"rebate_rate": D("0.09")}),
                (D("0.5"), {}),
            ):
                p = policy(output_vat_rate=D(out_rate), refund_ratio=rr, **kw)
                for cost in ("4.4", "5.6", "3.92", "12.345"):
                    bd = p.breakdown(D(cost))
                    assert bd["quote_excl_vat"] == (
                        bd["cost_pretax"] + bd["profit_amount"]
                        + bd["non_refundable_input_vat"] + bd["retained_refundable"]
                        + bd["stamp_duty"]
                    ), (out_rate, rr, cost)

    def test_fraction_mode_matches_decimal(self):
        p = policy(output_vat_rate=D("0.13"))
        for cost in ("4.4", "5.6"):
            d = p.breakdown(D(cost))
            f = p.breakdown(D(cost), mode=FRACTION)
            for key in (
                "cost_incl", "input_vat", "refundable_input_vat",
                "non_refundable_input_vat", "give_amount", "retained_refundable",
                "stamp_duty", "output_vat", "quote_excl_vat", "quote_incl_vat",
            ):
                assert to_decimal(f[key]) == d[key], (cost, key)

    def test_profit_ratio_mode(self):
        bd = policy(profit_mode="ratio", profit_value=D("0.06")).breakdown(D("4.0"))
        assert bd["profit_amount"] == D("0.2400")

    def test_margin_on_price_matches_business_formula(self):
        """售价加成模型：不含税售价 = 成本 ÷ (1 − 利润率 − 综合税费系数)。

        取自业务在用报价表（牛栏网，成本 281.9561，利润率 6%，综合税费系数 3%）：
        售价应为 309.8419（表格 309.841918…），利润 = 售价 × 0.97 − 成本 = 18.5905。
        """
        bd = policy(
            profit_mode="margin_on_price",
            profit_value=D("0.06"),
            misc_fee_rate=D("0.03"),
            stamp_rate=D("0"),
        ).breakdown(D("281.9561"))
        assert bd["quote_excl_vat"] == D("309.8419")
        assert bd["profit_amount"] == D("18.5905")
        assert bd["stamp_duty"] == 0

    def test_margin_on_price_rejects_invalid_denominator(self):
        with pytest.raises(PricingError, match="售价加成模型"):
            policy(
                profit_mode="margin_on_price",
                profit_value=D("0.98"),
                misc_fee_rate=D("0.03"),
            ).breakdown(D("10"))

    def test_extras_stack_on_incl_vat_price(self):
        p = policy(extras=(ExtraFee("银行费用", "ratio_of_quote", D("0.001")),))
        bd = p.breakdown(D("4.4"))
        assert bd["quote_final"] == Q(bd["quote_incl_vat"] * D("1.001"))
        assert bd["银行费用"] > 0


class TestPolicyConfig:
    def test_from_dict_reads_nested_blocks(self):
        p = policy_from_dict(
            {
                "input_vat_rate": 0.10,
                "output_vat": {"rate": 0.13, "mode": "inclusive"},
                "profit": {"mode": "fixed", "value": 0.1},
                "refund": {
                    "refund_ratio": "auto", "rebate_rate": 0.10,
                    "give_ratio": 0.8,
                },
                "stamp": {"rate": 0.05, "base": "profit"},
            }
        )
        assert p.output_vat_rate == 0.13
        assert p.output_vat_mode == "inclusive"
        assert p.rebate_rate == 0.10
        assert p.stamp_base == "profit"

    def test_quoted_numbers_survive_arithmetic(self):
        """YAML 里带引号的数字不能被当成字符串。"""
        p = policy_from_dict(
            {
                "input_vat_rate": "0.10",
                "profit": {"mode": "fixed", "value": "0.1"},
                "refund": {"refund_ratio": "1", "give_ratio": "0.8"},
                "stamp": {"rate": "0.05", "base": "profit"},
            }
        )
        # stamp 字段已删除（并入杂税）：带引号的旧键值能解析但不再影响价链
        assert p.breakdown(D("4.4"))["quote_excl_vat"] == D("4.5978")

    def test_auto_without_rebate_warns_and_assumes_full(self):
        p = policy(refund_ratio="auto", rebate_rate=None)
        ratio, warn = p.resolve_refund_ratio()
        assert ratio == D("1")
        assert warn and "rebate_rate" in warn

    def test_consistency_warning_when_output_vat_nonzero(self):
        warns = policy(output_vat_rate=D("0.13")).consistency_warnings()
        assert warns and "抵扣" in warns[0]

    def test_no_warning_for_clean_export(self):
        # 不带 legacy 字段的干净配置不应有任何告警
        assert policy(output_vat_rate=D("0")).consistency_warnings() == []

    @pytest.mark.parametrize("kw,msg", [
        ({"refund_ratio": D("-0.1")}, "可退税比例"),
        ({"input_vat_rate": D("1")}, "进项票税点"),
        ({"profit_mode": "nonsense"}, "利润模式"),
    ])
    def test_invalid_policy_rejected(self, kw, msg):
        with pytest.raises(PricingError, match=msg):
            policy(**kw).breakdown(D("4.4"))


# ─────────────────────────────────────────────────────────────────────────────
# 贸易术语
# ─────────────────────────────────────────────────────────────────────────────
def ladder(items, rungs, **kw):
    return TermLadder(
        rungs=tuple(TermRung(code=c, label=c, items=tuple(it)) for c, it in rungs),
        items={k: FeeItem(key=k, mode=m, value=v, **o) for k, m, v, o in items},
        **kw,
    )


STANDARD = dict(
    items=[
        ("inland", "per_weight_ton", D("120"), {}),
        ("customs", "per_shipment", D("500"), {}),
        ("freight", "per_weight_ton", D("480"), {}),
        ("ins", "insurance_of_cif", D("0.0011"), {"cif_factor": D("1.1")}),
    ],
    rungs=[("EXW", []), ("FOB", ["inland", "customs"]), ("CFR", ["freight"]), ("CIF", ["ins"])],
)


class TestIncoterms:
    def test_ladder_is_cumulative(self):
        l = ladder(**STANDARD)
        out = l.compute(D("300"), D("65.402"), D("300"))
        inland = out["FOB"]["fees"]["inland"]
        customs = out["FOB"]["fees"]["customs"]
        assert out["EXW"]["subtotal_excl"] == D("300")
        assert out["FOB"]["subtotal_excl"] == D("300") + inland + customs
        assert out["CFR"]["subtotal_excl"] == out["FOB"]["subtotal_excl"] + out["CFR"]["fees"]["freight"]
        assert out["CIF"]["subtotal_excl"] == out["CFR"]["subtotal_excl"] + out["CIF"]["fees"]["ins"]

    def test_exw_has_no_fees(self):
        out = ladder(**STANDARD).compute(D("100"), D("10"), D("10"))
        assert out["EXW"]["fees"] == {}
        assert out["EXW"]["price_incl"] == D("100")

    def test_per_weight_ton_uses_tonnage(self):
        l = ladder([("t", "per_weight_ton", D("120"), {})], [("X", ["t"])])
        assert l.compute(D("0"), D("1000"), D("5"))["X"]["fees"]["t"] == D("120")

    def test_per_shipment_dilutes_by_order_size(self):
        l = ladder([("c", "per_shipment", D("500"), {})], [("X", ["c"])])
        small = l.compute(D("0"), D("65"), D("300"))["X"]
        large = l.compute(D("0"), D("65"), D("500"))["X"]
        assert small["fees"]["c"] == D("1.6667")
        assert large["fees"]["c"] == D("1.0000")
        assert small["subtotal_excl"] > large["subtotal_excl"]

    def test_per_shipment_without_pieces_raises(self):
        l = ladder([("c", "per_shipment", D("500"), {})], [("X", ["c"])])
        with pytest.raises(TermsError, match="无法摊到单件"):
            l.compute(D("0"), D("65"), None)

    def test_cif_insurance_solves_circular_equation(self):
        l = ladder([("ins", "insurance_of_cif", D("0.0011"), {"cif_factor": D("1.1")})],
                   [("X", ["ins"])])
        cfr = D("341.9402")
        out = l.compute(cfr, D("65.402"), D("300"))["X"]
        ins, cif = out["fees"]["ins"], out["subtotal_excl"]
        # 反代：CIF × 加成 × 费率 必须等于保险费
        assert abs(cif * D("1.1") * D("0.0011") - ins) < D("0.0002")
        expected = cfr / (D("1") - D("1.1") * D("0.0011"))
        assert abs(cif - expected) < D("0.0002")

    def test_insurance_not_naive_wrong_formula(self):
        """常见错误：把保险费算在 CFR 上会低估。"""
        l = ladder([("ins", "insurance_of_cif", D("0.0011"), {"cif_factor": D("1.1")})],
                   [("X", ["ins"])])
        cfr = D("341.9402")
        out = l.compute(cfr, D("65.402"), D("300"))["X"]
        assert out["fees"]["ins"] > cfr * D("1.1") * D("0.0011")

    def test_impossible_insurance_rate_rejected(self):
        l = ladder([("ins", "insurance_of_cif", D("1.0"), {"cif_factor": D("1.1")})],
                   [("X", ["ins"])])
        with pytest.raises(TermsError, match="CIF 无解"):
            l.compute(D("100"), D("1"), D("1"))

    def test_vat_applied_on_final_term_price(self):
        l = ladder([("f", "per_piece", D("100"), {})], [("X", ["f"])])
        out = l.compute(D("1000"), D("1"), D("10"), vat_rate=D("0.13"))["X"]
        assert out["subtotal_excl"] == D("1100")
        assert out["output_tax"] == D("143")
        assert out["price_incl"] == D("1243")

    def test_values_resolved_from_price_inputs(self):
        """术语块只声明结构，金额从价格输入取（当期行情）。"""
        l = ladder_from_dict(
            {
                "items": {"freight": {"mode": "per_weight_ton", "source": "freight.ocean"}},
                "ladder": [{"code": "EXW"}, {"code": "CFR", "items": ["freight"]}],
            }
        )
        out = l.compute(
            D("100"), D("1000"), D("1"),
            price_inputs={"freight": {"ocean": {"value": "480"}}},
        )
        assert out["CFR"]["fees"]["freight"] == D("480")

    def test_missing_value_and_source_raises(self):
        l = ladder_from_dict(
            {
                "items": {"x": {"mode": "per_piece", "source": "nope"}},
                "ladder": [{"code": "EXW"}, {"code": "FOB", "items": ["x"]}],
            }
        )
        with pytest.raises(TermsError, match="取不到值"):
            l.compute(D("1"), D("1"), D("1"))

    def test_both_value_and_source_absent_raises_not_zero(self):
        """value 与 source 都取不到时必须报错，不能静默按 0 计价。"""
        l = ladder_from_dict(
            {
                "items": {"x": {"mode": "per_piece"}},
                "ladder": [{"code": "EXW"}, {"code": "FOB", "items": ["x"]}],
            }
        )
        with pytest.raises(TermsError, match="没有金额"):
            l.compute(D("1"), D("1"), D("1"))

    def test_explicit_zero_value_is_allowed(self):
        """显式填 0 是合法配置（例如暂不收费），不应被当成缺失。"""
        l = ladder_from_dict(
            {
                "items": {"x": {"mode": "per_piece", "value": "0"}},
                "ladder": [{"code": "EXW"}, {"code": "FOB", "items": ["x"]}],
            }
        )
        out = l.compute(D("1"), D("1"), D("1"))
        assert out["FOB"]["fees"]["x"] == D("0")
        assert out["FOB"]["subtotal_excl"] == out["EXW"]["subtotal_excl"]

    def test_ladder_config_validation(self):
        with pytest.raises(TermsError, match="未定义的费用项"):
            ladder_from_dict({"items": {}, "ladder": [{"code": "FOB", "items": ["nope"]}]})
        with pytest.raises(TermsError, match="重复"):
            ladder_from_dict({"ladder": ["EXW", "EXW"]})
        with pytest.raises(TermsError, match="DDP"):
            ladder_from_dict({"quote_as": "DDP", "ladder": ["EXW", "FOB"]})
        assert ladder_from_dict({}) is None
        assert ladder_from_dict(None) is None

    def test_audit_flags_incoterm_mistakes(self):
        """EXW 不应含费用项（若卖方报关应改 FCA）；FOB 不应为空。"""
        with_exw_fees = ladder_from_dict(
            {
                "items": {"c": {"mode": "per_piece", "value": 1}},
                "ladder": [{"code": "EXW", "items": ["c"]}, {"code": "FOB", "items": ["c"]}],
            }
        )
        warns = with_exw_fees.audit()
        assert any("EXW" in w and "FCA" in w for w in warns)

        empty_fob = ladder_from_dict({"ladder": ["EXW", "FOB"]})
        assert any("FOB" in w for w in empty_fob.audit())
