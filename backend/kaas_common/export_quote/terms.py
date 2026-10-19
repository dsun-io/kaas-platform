"""贸易术语阶梯（Incoterms）：在 EXW 基准上逐档叠加费用。

结构是**累加**的，配置里只写"这一档新增什么"：

    EXW  工厂交货          基准（= 不含税售价 × 单件重量）
    FCA  货交承运人        + 内陆运输 + 出口清关
    FOB  装运港船上交货    + 装船费
    CFR  成本加运费        + 海运运费
    CIF  成本保险费加运费  + 保险费

Incoterms 2020 的四个易错点（本模块的校验会检查）：
  1. **FOB 由卖方办理出口清关**，所以出口清关费属于 FOB，不属于买方
  2. **EXW 由买方办理出口清关**；若实际由卖方报关付汇，术语应改用 FCA，
     把报关费计入 EXW 会把价格算成另一种贸易条件
  3. **风险转移点 ≠ 费用负担点**：CFR/CIF 下风险在装船时即转移给买方，
     但卖方仍要付运费到目的港
  4. **CIF 保险费是循环等式**：
         保险费 = CIF × 投保加成 × 费率
         CIF    = CFR + 保险费
         ⇒ CIF  = CFR ÷ (1 − 投保加成 × 费率)
     写成 CFR × 加成 × 费率 是把保险费算在 CFR 上，会低估

数值来源：术语块只声明"这一档包含哪些费用、怎么计价"，
具体金额通过 `source` 指向价格输入（当期行情、含有效期），
避免把会变的运费写死在结构里。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .numeric import DECIMAL, dec, quantize

FEE_MODES = (
    "per_weight_kg",  # 按公斤
    "per_weight_ton",  # 按吨
    "per_piece",  # 按件/按卷
    "per_shipment",  # 按整批（摊到单件需知道件数）
    "ratio_of_subtotal",  # 按当前累计金额比例
    "insurance_of_cif",  # CIF 保险：解循环等式
)

DEFAULT_CIF_FACTOR = "1.1"  # 投保加成惯例 110%


class TermsError(ValueError):
    """贸易术语配置或求值有误。"""


def _num(value, mode=DECIMAL):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        return mode.convert(dec(value))
    return mode.convert(value)


def _resolve_source(source: str, price_inputs: Mapping[str, Any] | None):
    """按点分路径从价格输入里取值，如 freight.ocean_freight。"""
    if not source:
        return None
    if price_inputs is None:
        return None
    node: Any = price_inputs
    for part in source.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return None
        node = node[part]
    if isinstance(node, Mapping):
        return node.get("value")
    return node


@dataclass(frozen=True)
class FeeItem:
    """一笔费用。

    value 的含义由 mode 决定；若给了 source，则优先从价格输入取值。

    **value 与 source 至少要有一个能取到金额**：两者都取不到时明确报错，
    不以 0 兜底 —— 把一笔运费静默当成 0 会让整张报价单偏低。
    """

    key: str
    name: str = ""
    name_en: str = ""
    mode: str = "per_piece"
    value: Any = None
    source: str = ""
    decimals: int | None = None
    cif_factor: Any = DEFAULT_CIF_FACTOR
    # 费用币种（用户 2026-10-18 口径）：国内费用人民币，国外费用美元。
    # 引擎内部小计以人民币累加，美元费用在此按**本报价设置的汇率**折算成人民币。
    currency: str = "CNY"

    def resolved_value(self, price_inputs: Mapping[str, Any] | None = None):
        """先看 source（当期行情），取不到再回落到 value（配置内联）。"""
        if self.source:
            from_source = _resolve_source(self.source, price_inputs)
            if from_source is not None:
                return from_source
            if self.value is None:
                raise TermsError(
                    f"费用 {self.key} 的 source={self.source!r} 在价格输入里取不到值，"
                    "且未配置 value 兜底。请补齐价格输入，或为该费用直接填 value"
                )
        return self.value

    def amount_per_piece(self, subtotal, weight_kg, pieces, mode=DECIMAL,
                         price_inputs: Mapping[str, Any] | None = None):
        if self.mode not in FEE_MODES:
            raise TermsError(
                f"未知的费用计价方式: {self.mode}（可选 {' | '.join(FEE_MODES)}）"
            )
        v = _num(self.resolved_value(price_inputs), mode)
        if v is None:
            raise TermsError(
                f"费用 {self.key} 没有金额：source={self.source!r}、value={self.value!r} "
                "都取不到，请补齐配置"
            )
        if self.mode == "per_weight_kg":
            return weight_kg * v
        if self.mode == "per_weight_ton":
            return mode.divide(weight_kg, _num(1000, mode)) * v
        if self.mode == "per_piece":
            return v
        if self.mode == "per_shipment":
            if not pieces:
                raise TermsError(
                    f"费用 {self.key} 按整批计价，但订单件数为空或为 0，无法摊到单件"
                )
            return mode.divide(v, pieces)
        if self.mode == "ratio_of_subtotal":
            return subtotal * v
        if self.mode == "insurance_of_cif":
            factor = _num(self.cif_factor, mode)
            denom = _num(1, mode) - factor * v
            if denom <= 0:
                raise TermsError(
                    f"费用 {self.key}：投保加成({float(factor):.4g}) × "
                    f"费率({float(v):.4g}) ≥ 1，CIF 无解，请检查配置"
                )
            return mode.divide(subtotal, denom) - subtotal
        raise TermsError(f"未实现的费用方式: {self.mode}")


@dataclass(frozen=True)
class TermRung:
    """阶梯的一档：在上一档基础上新增若干费用。"""

    code: str
    label: str = ""
    label_en: str = ""
    items: tuple = ()


@dataclass(frozen=True)
class TermLadder:
    rungs: tuple
    items: dict = field(default_factory=dict)
    quote_as: str = ""
    base_code: str = "EXW"
    weight_field: str = "weight_per_piece_kg"
    validity_days: int = 7

    @property
    def codes(self) -> list[str]:
        return [r.code for r in self.rungs]

    def rung(self, code: str) -> TermRung | None:
        for r in self.rungs:
            if r.code == code:
                return r
        return None

    # ---------- 结构自检 ----------
    def audit(self) -> list[str]:
        """术语定义的正确性提示（不阻断计算）。"""
        out: list[str] = []
        rung_codes = self.codes
        for code in ("FOB", "CFR", "CIF"):
            if code in rung_codes:
                prev = rung_codes[rung_codes.index(code) - 1] if rung_codes.index(code) else None
                if prev is None:
                    out.append(f"{code} 之前没有任何档位，阶梯起点应是 EXW")
        # FOB 应包含出口清关；EXW 不应包含
        exw = self.rung("EXW")
        fob = self.rung("FOB")
        if exw and exw.items:
            out.append(
                "EXW 档新增了费用项：Incoterms 2020 下 EXW 由买方办理出口清关，"
                "若实际由卖方报关付汇，术语应改用 FCA。"
            )
        if fob is not None and not fob.items:
            out.append(
                "FOB 档没有任何费用项：FOB 由卖方办理出口清关，"
                "通常至少包含内陆运输与出口清关费。"
            )
        return out

    # ---------- 计算 ----------
    def compute(
        self,
        exw_per_piece,
        weight_kg,
        pieces,
        vat_rate=0,
        vat_mode="additive",
        mode=DECIMAL,
        price_inputs: Mapping[str, Any] | None = None,
        fx_rate=1,
    ) -> dict:
        """从 EXW **单件**不含税金额出发，逐档累加。

        为什么按"单件"而不是"每公斤"：
        运费、报关、保险天然按批/按件/按吨发生，把它们摊成"每公斤"再加回去
        容易出错也难核对。所以阶梯在单件金额上累加，
        同时给出"折每单位重量"的等价数值，两种口径都能查。

        销项税在最终成交价上计算 —— 增值税对最终成交价课征，
        运费等价内费用也应进入税基。

        币种（2026-10-18 用户口径）：**国内费用人民币，国外费用美元**。
        小计始终以人民币累加；美元费用按**本报价设置的汇率** `fx_rate`
        （1 美元 = ? 人民币）折算后再加进去。因此界面上海运费/保险费/目的港费用/进口税费
        都填美元金额。
        """
        base = _num(exw_per_piece, mode)
        weight = _num(weight_kg, mode)
        cnt = _num(pieces, mode) if pieces is not None else None
        rate = _num(vat_rate, mode)
        fx = _num(fx_rate, mode)

        out: dict[str, dict] = {}
        subtotal = base
        for rung in self.rungs:
            fees: dict[str, Any] = {}
            for key in rung.items:
                item = self.items.get(key)
                if item is None:
                    raise TermsError(f"术语 {rung.code} 引用了未定义的费用项: {key}")
                amt = item.amount_per_piece(subtotal, weight, cnt, mode, price_inputs)
                if item.currency.upper() == "USD":
                    if item.mode in ("ratio_of_subtotal", "insurance_of_cif"):
                        raise TermsError(
                            f"费用 {key} 是比例类/保险费率类，不能用美元金额；"
                            "请改用 per_shipment/per_weight_ton 等金额口径"
                        )
                    if fx is None or fx <= 0:
                        raise TermsError(
                            f"费用 {key} 以美元计价，但订单汇率为空/非正，无法折算成人民币"
                        )
                    # 美元金额 → 人民币（子计以人民币累加）
                    amt = amt * fx
                amt = mode.quantize(amt, item.decimals if item.decimals is not None else 4)
                fees[key] = amt
                subtotal = subtotal + amt

            price_excl = mode.quantize(subtotal, 4)
            if vat_mode == "inclusive":
                output_tax = mode.quantize(
                    mode.divide(price_excl * rate, _num(1, mode) + rate), 4
                )
                price_incl = price_excl
            else:
                output_tax = mode.quantize(price_excl * rate, 4)
                price_incl = mode.quantize(price_excl + output_tax, 4)

            row: dict[str, Any] = {
                "code": rung.code,
                "label": rung.label,
                "subtotal_excl": price_excl,
                "output_tax": output_tax,
                "price_incl": price_incl,
                "fees": fees,
                "weight": weight,
            }
            if weight:
                row["price_per_kg"] = mode.quantize(mode.divide(price_incl, weight), 4)
                row["excl_per_kg"] = mode.quantize(mode.divide(price_excl, weight), 4)
            if cnt is not None:
                row["pieces"] = cnt
                row["total_excl"] = mode.quantize(price_excl * cnt, 2)
                row["total_incl"] = mode.quantize(price_incl * cnt, 2)
                row["total_tax"] = mode.quantize(output_tax * cnt, 2)
            out[rung.code] = row
        return out


def ladder_from_dict(cfg: Mapping[str, Any] | None) -> TermLadder | None:
    """从配置构造阶梯；未配置返回 None（保持纯 EXW 行为）。

    为什么对未知键名**直接报错**
    -----------------------------
    这里的键名一旦拼错（例如把费用项写在 `fees` 而不是 `items`），
    费用就会全部落空：

      · `items` 取不到 → 费用表为空
      · 梯档引用的 `items` 为空 → 没有任何费用被累加

    结果是**术语阶梯全等于 EXW，而且不报错** —— 一张 FOB/CIF 报价单
    实际报的却是不含运费的出厂价，客户拿到手就是个错价。
    相比“配错了”，这种静默降级贵得多，所以未知键名一律拒绝。

    注：费用项**内部的**展示用键（unit_hint、note 等）不校验 ——
    界面要把模板原样回传，多几个不参与计算的键是正常的。
    """
    if not cfg:
        return None

    unknown = set(cfg) - {"items", "ladder", "quote_as", "base", "weight_field"}
    if unknown:
        raise TermsError(
            f"terms 存在未知配置项: {', '.join(sorted(unknown))}"
            "（可用 items | ladder | quote_as | base | weight_field）"
        )

    items: dict[str, FeeItem] = {}
    for key, item in (cfg.get("items") or {}).items():
        if not isinstance(item, Mapping):
            raise TermsError(f"terms.items.{key} 必须是映射")
        items[key] = FeeItem(
            key=key,
            name=str(item.get("name", key)),
            name_en=str(item.get("name_en", "")),
            mode=str(item.get("mode", "per_piece")),
            value=item.get("value"),
            source=str(item.get("source", "")),
            decimals=item.get("decimals"),
            cif_factor=item.get("cif_factor", DEFAULT_CIF_FACTOR),
            currency=str(item.get("currency", "CNY")).upper(),
        )

    rungs: list[TermRung] = []
    for i, r in enumerate(cfg.get("ladder") or []):
        if isinstance(r, str):
            rungs.append(TermRung(code=r, label=r))
            continue
        if not isinstance(r, Mapping) or "code" not in r:
            raise TermsError(f"terms.ladder 第 {i + 1} 项必须含 code")
        unknown_rung = set(r) - {"code", "label", "label_en", "items"}
        if unknown_rung:
            raise TermsError(
                f"terms.ladder 第 {i + 1} 项存在未知配置项: "
                f"{', '.join(sorted(unknown_rung))}（可用 code | label | label_en | items）"
            )
        rungs.append(
            TermRung(
                code=str(r["code"]),
                label=str(r.get("label", r["code"])),
                label_en=str(r.get("label_en", "")),
                items=tuple(r.get("items") or ()),
            )
        )
    if not rungs:
        return None

    codes = [r.code for r in rungs]
    if len(set(codes)) != len(codes):
        raise TermsError(f"terms.ladder 存在重复的术语代码: {', '.join(codes)}")
    for rung in rungs:
        for key in rung.items:
            if key not in items:
                raise TermsError(f"术语 {rung.code} 引用了未定义的费用项: {key}")

    quote_as = str(cfg.get("quote_as") or codes[-1])
    if quote_as not in codes:
        raise TermsError(
            f"terms.quote_as={quote_as} 不在 ladder 中（可选 {', '.join(codes)}）"
        )

    return TermLadder(
        rungs=tuple(rungs),
        items=items,
        quote_as=quote_as,
        base_code=str(cfg.get("base", codes[0])),
        weight_field=str(cfg.get("weight_field") or "weight_per_piece_kg"),
        validity_days=int(cfg.get("validity_days", 7)),
    )


def quantize_frac_helper(x, nd: int):
    """便捷导出：供核验模块统一处理小数位。"""
    return quantize(x, nd)
