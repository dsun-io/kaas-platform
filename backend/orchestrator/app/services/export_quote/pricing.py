"""出口报价内核：与产品无关的价格链。

整条链路（术语命名以税法为准）：

    ① 采购与利润
       含税采购价              = 税前成本 ÷ (1 − 进项票税点)
       加工利润                = 固定额 | 税前成本 × 利润率
       税前报价                = 税前成本 + 加工利润
       基础报价                = 含税采购价 + 加工利润

    ② 进项增值税与退税
       进项税额                = 含税采购价 − 税前成本
       可退进项增值税税额      = 进项税额 × (出口退税率 ÷ 征税率)
       不可退进项税额          = 进项税额 − 可退进项增值税税额
       让利额                  = 可退进项增值税税额 × 让利比例
       自留可退税额            = 可退进项增值税税额 − 让利额

    ③ 税负
       印花税                  = 计税基数 × 印花税率      （基数默认「加工利润」）

    ④ 不含税售价
       不含税售价              = 含税采购价 + 加工利润 − 让利额 + 印花税
       等价式                  ≡ 税前成本 + 加工利润 + 不可退进项税额 + 自留可退税额 + 印花税

    ⑤ 销项增值税（价外税，计税基数是售价）
       销项税额                = 不含税售价 × 销项税率
       含税售价                = 不含税售价 + 销项税额

    ⑥ 纳税结算
       应缴增值税              = max(0, 销项税额 − 可退进项增值税税额)
       可退/留抵税额           = max(0, 可退进项增值税税额 − 销项税额)

    ⑦ 附加费用
       最终客户价              = 含税售价 + Σ 附加费用

两个必须记住的点
----------------
**销项税的计税基数是我们算出来的售价，不是成本。**
    销项税额 = 不含税售价 × 销项税率      4.6028 × 13% = 0.5984  ✓
              ≠ 税前成本 × 税率           4.4    × 13% = 0.5720  ✗

**退税退的是进项增值税额；「退还」与「抵扣」价值相同，不构成互斥开关。**
    出口零税率：销项税 0，可退进项增值税税额以现金退还
    内销征税  ：可退进项增值税税额以抵扣销项税额实现，抵不完则留抵
两者每单位价值相等，因此售价公式统一、不随税制漂移，
差别只体现在第 ⑥ 步的纳税结算。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from .numeric import DECIMAL, dec, quantize

# 各环节默认小数位（可由配置覆盖）
DEFAULT_DECIMALS: dict[str, int] = {
    # ① 采购与利润
    "cost_pretax": 4,
    "cost_incl": 4,
    "profit_amount": 4,
    "pretax_quote": 4,
    "base_quote": 4,
    # ② 进项增值税与退税
    "input_vat": 4,
    "refund_ratio_used": 6,
    "refundable_input_vat": 4,
    "non_refundable_input_vat": 4,
    "give_amount": 4,
    "retained_refundable": 4,
    # ③ 税负
    "stamp_duty": 4,
    # ④ 不含税售价
    "chain_amount": 4,
    "quote_excl_vat": 4,
    # ⑤ 销项税
    "output_vat_rate_used": 4,
    "output_vat": 4,
    "quote_incl_vat": 4,
    # ⑥ 结算
    "vat_payable": 4,
    "vat_carryforward": 4,
    "refund_receivable": 4,
    # ⑦ 附加
    "extras": 4,
    "extras_total": 4,
    "quote_final": 4,
}

STAMP_BASES = ("profit", "cost", "base_quote")
OUTPUT_VAT_MODES = ("additive", "inclusive")


class PricingError(ValueError):
    """报价政策配置有误。"""


def _num(value, mode=DECIMAL):
    """把政策里的标量转成当前数值模式的类型。

    配置里带引号的数字（"0.10"）必须能参与算术，
    否则会抛出「str 与 int 比较」这类难以定位的错误。
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return mode.convert(dec(value))
    return mode.convert(value)


@dataclass(frozen=True)
class ExtraFee:
    """客户价上叠加的费用（银行费、认证费等）。"""

    name: str
    mode: str = "ratio_of_quote"  # ratio_of_quote | fixed_per_unit | fixed_total
    value: Any = 0
    decimals: int = 4

    def amount(self, quote, unit_count=1, mode=DECIMAL):
        v = _num(self.value, mode)
        if self.mode == "ratio_of_quote":
            return quote * v
        if self.mode == "fixed_per_unit":
            return v
        if self.mode == "fixed_total":
            return mode.divide(v, unit_count)
        raise PricingError(f"未知的费用模式: {self.mode}")


@dataclass(frozen=True)
class Sensitivity:
    """敏感性分析：列出要扫描的旋钮取值。"""

    give_ratio: list = field(default_factory=list)
    profit_value: list = field(default_factory=list)
    input_vat_rate: list = field(default_factory=list)
    fx_rate: list = field(default_factory=list)


@dataclass(frozen=True)
class PricingPolicy:
    """报价政策：整条链的旋钮集合。

    法定参数（征税率、销项税率、印花税率）默认来自税务档案 RateSet，
    也可在本处显式覆盖；报价政策只负责"本单怎么报"。
    """

    input_vat_rate: Any = 0  # 进项票税点（供应商属性，非国家法定）
    output_vat_rate: Any = 0  # 销项税率；出口零税率填 0
    output_vat_mode: str = "additive"  # additive(价外) | inclusive(价内拆解)
    profit_mode: str = "fixed"  # fixed | ratio
    profit_value: Any = 0
    give_ratio: Any = 0  # 让出可退进项增值税税额的比例
    refund_ratio: Any = 1  # 可退税比例；'auto' = 出口退税率 ÷ 征税率
    rebate_rate: Any = None  # 出口退税率（auto 模式使用）
    levy_rate: Any = None  # 征税率（auto 模式使用）
    stamp_rate: Any = 0
    stamp_base: str = "profit"
    extras: tuple = ()
    decimals: dict = field(default_factory=dict)
    sensitivity: Sensitivity | None = None

    # ---------- 可退税比例 ----------
    def resolve_refund_ratio(self, mode=DECIMAL):
        """返回 (可退税比例, 提示信息)。

        可退税比例 = 出口退税率 ÷ 征税率，**上限为 1**。

        为什么上限必须是 1（即「取低的那个」）
        ------------------------------------
        可退进项增值税税额 = 进项税额 × 可退税比例。进项税额是采购发票上
        **实际缴纳**的税额；没交过的税是退不回来的。所以：

          · 退税率 ≤ 征税率（常态）→ 比例 = 退税率 ÷ 征税率 < 1，
            差额即「不可退进项税额」，是实打实的成本，留在价链里
          · 退税率 > 进项票税点 → 比例本会 > 1，但那等于「退得比交的多」，
            不成立。此时按 1 计，即取两者中**低**的那个为准

        举例：丝厂开票价税点 10%，出口退税率 13%
          → 进项税额按 10 点交了 0.4889，全部可退，可退额 = 0.4889
          → 不会变成 0.4889 × 1.3 = 0.6356（那是凭空多退 0.1467）

        这类情形在实际业务里很正常（发票税点与法定退税率本就不同源），
        所以**只提示不阻断**，让报价单照常出得来。
        """
        raw = self.refund_ratio
        warn: str | None = None
        if isinstance(raw, str) and raw.strip().lower() == "auto":
            if self.rebate_rate is None or self.levy_rate in (None, 0, "0", "0.0"):
                return mode.convert(1), (
                    "refund.refund_ratio 使用 auto 模式，但 rebate_rate（出口退税率）"
                    "或 levy_rate（征税率）未配置，暂按「进项税额全额可回收」计算；"
                    "请填入实际退税率后重算"
                )
            levy = _num(self.levy_rate, mode)
            if levy <= 0:
                raise PricingError("征税率必须 > 0")
            rebate = _num(self.rebate_rate, mode)
            ratio = mode.divide(rebate, levy)
            if ratio > 1:
                warn = (
                    f"出口退税率（{rebate}）高于进项票税点／征税率（{levy}），"
                    "可退税比例按 1 计：可退进项增值税税额以**实际缴纳的进项税额**"
                    "为上限，不会退到超过已缴税额（取两者中低者）。"
                    "若这两个率口径不同源（如发票税点 10 点、法定退税率 13%），"
                    "填 10 点即可得到同一结果。"
                )
        else:
            ratio = _num(raw, mode)
            if ratio > 1:
                warn = (
                    f"显式给定的可退税比例（{ratio}）大于 1，已按 1 计："
                    "可退进项增值税税额不会超过实际缴纳的进项税额。"
                )
        if ratio > 1:
            ratio = mode.convert(1)
        if ratio < 0:
            raise PricingError("可退税比例不能为负")
        return ratio, warn

    # ---------- 计算 ----------
    def breakdown(self, cost_pretax, unit_count=1, mode=DECIMAL) -> dict:
        """给定税前单位成本，算出完整价链。"""
        cost = mode.convert(cost_pretax)
        nd = dict(DEFAULT_DECIMALS)
        nd.update(self.decimals or {})

        one = mode.convert(1)
        vat = _num(self.input_vat_rate, mode)
        if vat >= one:
            raise PricingError("进项票税点必须 < 1")

        # ① 采购与利润
        cost_incl = mode.quantize(mode.divide(cost, one - vat), nd["cost_incl"])
        if self.profit_mode == "fixed":
            profit = _num(self.profit_value, mode)
        elif self.profit_mode == "ratio":
            profit = cost * _num(self.profit_value, mode)
        else:
            raise PricingError(f"未知的利润模式: {self.profit_mode}")
        profit = mode.quantize(profit, nd["profit_amount"])
        pretax_quote = mode.quantize(cost + profit, nd["pretax_quote"])
        base_quote = mode.quantize(cost_incl + profit, nd["base_quote"])

        # ② 进项增值税与退税
        input_vat = mode.quantize(cost_incl - cost, nd["input_vat"])
        ratio, warn = self.resolve_refund_ratio(mode)
        ratio = mode.quantize(ratio, nd["refund_ratio_used"])
        refundable = mode.quantize(input_vat * ratio, nd["refundable_input_vat"])
        non_refundable = mode.quantize(input_vat - refundable, nd["non_refundable_input_vat"])
        give = mode.quantize(refundable * _num(self.give_ratio, mode), nd["give_amount"])
        retained = mode.quantize(refundable - give, nd["retained_refundable"])

        # ③ 印花税（默认按加工利润计征）
        if self.stamp_base == "profit":
            stamp_base_val = profit
        elif self.stamp_base == "cost":
            stamp_base_val = cost
        elif self.stamp_base == "base_quote":
            stamp_base_val = base_quote
        else:
            raise PricingError(
                f"未知的印花税基数: {self.stamp_base}（可选 {' | '.join(STAMP_BASES)}）"
            )
        stamp = mode.quantize(stamp_base_val * _num(self.stamp_rate, mode), nd["stamp_duty"])

        # ④ 不含税售价（价链输出，与税制无关）
        chain_amount = mode.quantize(base_quote - give + stamp, nd["quote_excl_vat"])

        # ⑤ 销项增值税：价外税，基数是售价
        out_vat = _num(self.output_vat_rate, mode)
        if self.output_vat_mode not in OUTPUT_VAT_MODES:
            raise PricingError(
                f"未知的销项税模式: {self.output_vat_mode}"
                f"（可选 {' | '.join(OUTPUT_VAT_MODES)}）"
            )
        if self.output_vat_mode == "additive":
            quote_excl_vat = chain_amount
            output_vat = mode.quantize(quote_excl_vat * out_vat, nd["output_vat"])
            quote_incl_vat = mode.quantize(quote_excl_vat + output_vat, nd["quote_incl_vat"])
        else:
            # 价内拆解：报价已含税，从中反算不含税价与税额
            quote_incl_vat = chain_amount
            output_vat = mode.quantize(
                mode.divide(quote_incl_vat * out_vat, one + out_vat), nd["output_vat"]
            )
            quote_excl_vat = mode.quantize(quote_incl_vat - output_vat, nd["quote_excl_vat"])

        # ⑥ 纳税结算：销项与进项相抵（可退进项增值税税额只被用掉一次）
        diff = output_vat - refundable
        vat_payable = mode.quantize(diff if diff > 0 else mode.convert(0), nd["vat_payable"])
        vat_carry = mode.quantize(-diff if diff < 0 else mode.convert(0), nd["vat_carryforward"])

        # ⑦ 附加费用
        extras_total = mode.convert(0)
        extra_items: dict[str, Any] = {}
        for extra in self.extras:
            amt = mode.quantize(extra.amount(quote_incl_vat, unit_count, mode), extra.decimals)
            extra_items[extra.name] = amt
            extras_total = extras_total + amt
        quote_final = mode.quantize(quote_incl_vat + extras_total, nd["quote_final"])

        # 等价式自检：不含税售价 = 成本 + 利润 + 不可退进项税额 + 自留可退税额 + 印花税
        check = pretax_quote + non_refundable + retained + stamp
        if mode.quantize(check, nd["quote_excl_vat"]) != chain_amount:
            raise PricingError(
                "价链不闭合: 不含税售价 = "
                f"{chain_amount}, 成本+利润+不可退进项税额+自留可退税额+印花税 = "
                f"{mode.quantize(check, nd['quote_excl_vat'])}"
            )

        return {
            # ①
            "cost_pretax": mode.quantize(cost, nd["cost_pretax"]),
            "cost_incl": cost_incl,
            "profit_amount": profit,
            "pretax_quote": pretax_quote,
            "base_quote": base_quote,
            # ②
            "input_vat": input_vat,
            "refund_ratio_used": ratio,
            "refundable_input_vat": refundable,
            "non_refundable_input_vat": non_refundable,
            "give_amount": give,
            "retained_refundable": retained,
            # ③
            "stamp_duty": stamp,
            # ④
            "chain_amount": chain_amount,
            # ⑤
            "output_vat_rate_used": out_vat,
            "output_vat": output_vat,
            "quote_excl_vat": quote_excl_vat,
            "quote_incl_vat": quote_incl_vat,
            # ⑥
            "vat_payable": vat_payable,
            "vat_carryforward": vat_carry,
            "refund_receivable": vat_carry,
            # ⑦
            "extras_total": extras_total,
            "quote_final": quote_final,
            # 兼容别名（旧口径命名，避免调用方大面积改动）
            "quote": quote_excl_vat,
            "output_tax": output_vat,
            **extra_items,
        }

    def quote_only(self, cost_pretax, unit_count=1, mode=DECIMAL):
        return self.breakdown(cost_pretax, unit_count, mode)["quote_final"]

    # ---------- 一致性提示 ----------
    def consistency_warnings(self, mode=DECIMAL) -> list[str]:
        """配置层面的语义告警（不阻断计算）。"""
        out: list[str] = []
        rate = _num(self.output_vat_rate, mode) or mode.convert(0)
        if rate > 0:
            out.append(
                f"销项税率 {rate} ≠ 0：可退进项增值税税额实际通过**抵扣**实现，"
                "而非现金退还。售价公式不受影响（两种方式价值相同），"
                "但纳税结算应按「应缴增值税 = 销项税额 − 可退进项增值税税额」理解。"
            )
        return out

    def with_(self, **kwargs) -> "PricingPolicy":
        return replace(self, **kwargs)


def policy_from_dict(cfg: dict | None) -> PricingPolicy:
    """从配置字典构造政策，缺省值安全（老配置行为不变）。"""
    cfg = cfg or {}
    profit = cfg.get("profit") or {}
    refund = cfg.get("refund") or {}
    stamp = cfg.get("stamp") or cfg.get("stamp_duty") or {}
    sens = cfg.get("sensitivity") or {}
    out_vat = cfg.get("output_vat")
    if isinstance(out_vat, dict):
        out_vat_rate = out_vat.get("rate", 0)
        out_vat_mode = out_vat.get("mode", "additive")
    else:
        out_vat_rate = cfg.get("output_vat_rate", 0)
        out_vat_mode = "additive"

    extras = [
        ExtraFee(
            name=item["name"],
            mode=item.get("mode", "ratio_of_quote"),
            value=item.get("value", 0),
            decimals=item.get("decimals", 4),
        )
        for item in (cfg.get("extras") or [])
    ]

    return PricingPolicy(
        input_vat_rate=cfg.get("input_vat_rate", 0),
        output_vat_rate=out_vat_rate,
        output_vat_mode=out_vat_mode,
        profit_mode=profit.get("mode", "fixed"),
        profit_value=profit.get("value", 0),
        give_ratio=refund.get("give_ratio", 0),
        refund_ratio=refund.get("refund_ratio", 1),
        rebate_rate=refund.get("rebate_rate"),
        levy_rate=refund.get("levy_rate"),
        stamp_rate=stamp.get("rate", 0),
        stamp_base=stamp.get("base", "profit"),
        extras=tuple(extras),
        decimals=cfg.get("decimals") or {},
        sensitivity=Sensitivity(
            give_ratio=sens.get("give_ratio") or [],
            profit_value=sens.get("profit_value") or [],
            input_vat_rate=sens.get("input_vat_rate") or [],
            fx_rate=sens.get("fx_rate") or [],
        ),
    )
