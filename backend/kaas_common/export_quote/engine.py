"""出口报价引擎：把产品模型 + 报价政策 + 税务档案 + 术语阶梯组装成一张报价表。

流程：
    1. 规格展开    规格轴 × 变体包 做笛卡尔积 → 每行一个变量作用域
    2. 派生公式    按声明顺序求值（重量、体积…），decimals 处逐级落定
    3. 成本取值    按 cost_field / cost_basis 得到税前单位成本
    4. 价格链      跑 PricingPolicy.breakdown（含进项税、退税、销项税、印花税）
    5. 术语阶梯    若有 terms，按订单量逐档累加（批次费用需摊到单件）
    6. 单件指标    单卷/单支价、每米价、外币价
    7. 订单指标    卷数、总重、总体积、总价、总外币价
    8. 列投影      内部视图 / 客户视图（internal 标记切分）

引擎不含任何产品知识，产品类不含任何税务知识 —— 这是"换产品/换国家都不改引擎"的前提。
"""
from __future__ import annotations

import keyword
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation, localcontext
from typing import Any, Mapping

from . import expr as expr_mod
from .models import Column, FormulaSpec, OrderSpec, ProductSpec, pricing_key_of
from .numeric import DECIMAL, FRACTION, PRECISION, is_integral
from .pricing import PricingError, PricingPolicy
from .terms import TermLadder, TermsError, ladder_from_dict

_IDENT = re.compile(r"^[A-Za-z_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff]*$")

DEFAULT_VALIDITY_DAYS = 7


def _pick_packaging(product: ProductSpec, packaging_id: str) -> dict | None:
    """选本单包装：显式 id > is_default > 最早创建 > 第一条。

    产品没有配置包装 → None（包装费 0，行为与改造前一致）。
    """
    items = [p for p in (product.packaging or []) if isinstance(p, Mapping)]
    if not items:
        return None
    wanted = str(packaging_id or "").strip()
    if wanted:
        for item in items:
            if str(item.get("id") or "") == wanted:
                return dict(item)
        raise EngineError(
            f"packaging_id={wanted!r} 不属于产品 {product.key}；"
            f"可选: {', '.join(str(p.get('id')) for p in items)}"
        )
    for item in items:
        if item.get("is_default"):
            return dict(item)
    with_created = [p for p in items if p.get("created_at")]
    if with_created:
        return dict(min(with_created, key=lambda p: str(p.get("created_at"))))
    return dict(items[0])


def _packaging_fee(product: ProductSpec, packaging_id: str, scope: Mapping[str, Any],
                   mode=DECIMAL) -> tuple[Any, dict | None, dict | None]:
    """按当前规格解析包装费（元/卷）。返回 (fee, packaging, matched_range)。

    区间规则：`ranges: [{field, min, max, amount}]`，左闭右开；
    未命中任何区间时用 `amount` 兜底；同时命中多条 → EngineError（配置冲突）。
    """
    pkg = _pick_packaging(product, packaging_id)
    if pkg is None:
        return mode.convert(0), None, None
    matched = None
    for rng in (pkg.get("ranges") or []):
        if not isinstance(rng, Mapping):
            continue
        field = rng.get("field")
        if not field or field not in scope:
            continue
        try:
            value = float(scope[field])
        except (TypeError, ValueError):
            continue
        low, high = rng.get("min"), rng.get("max")
        if low is not None and value < float(low):
            continue
        if high is not None and value >= float(high):
            continue
        if matched is not None:
            raise EngineError(
                f"包装「{pkg.get('name') or pkg.get('id')}」的收费区间重叠："
                f"字段 {field}={value} 同时命中多条规则，请修改产品包装配置"
            )
        matched = rng
    raw_amount = matched.get("amount") if matched else pkg.get("amount", 0)
    try:
        fee = mode.convert(raw_amount or 0)
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise EngineError(f"包装费金额不合法: {raw_amount!r}") from exc
    if fee < 0:
        raise EngineError(f"包装费不能为负: {raw_amount!r}")
    return fee, pkg, matched


class EngineError(ValueError):
    """引擎无法完成计算。"""


# ─────────────────────────────────────────────────────────────────────────────
# 输入 / 输出
# ─────────────────────────────────────────────────────────────────────────────
@dataclass
class QuoteRequest:
    """一次出口报价的完整输入。"""

    product_key: str = ""
    product: ProductSpec | None = None  # 直接给 ProductSpec（覆盖注册表）
    policy: PricingPolicy = field(default_factory=PricingPolicy)
    fx_rate: Any = 1
    fx_source: str = ""
    fx_date: date | None = None
    orders: list[OrderSpec] = field(default_factory=list)
    # 显式规格行：给了就**只算这些行**，不再展开笛卡尔积。
    # 用于「客户只问若干具体组合」与「按上传的表格逐行报价」两种场景。
    spec_rows: list[dict] | None = None
    terms: TermLadder | None = None
    price_inputs: Mapping[str, Any] = field(default_factory=dict)
    validity_days: int = DEFAULT_VALIDITY_DAYS
    quote_date: date | None = None
    constants_override: Mapping[str, Any] = field(default_factory=dict)
    # 变体/规格覆盖：{"coating": {"普锌40g/㎡": {"raw_price": 4.6}}}
    variant_overrides: Mapping[str, Any] = field(default_factory=dict)
    # 客户定价数据（成本表）：{"de=2.0|coating_code=zinc_40": 4.4, ...}
    # 由 API 层按「当前客户 + 产品定价键」查库后注入，引擎本身不碰数据库。
    # 命中则用表里的成本；未命中回退产品定义的内联成本值（老报价行为不变）。
    cost_table: Mapping[str, Any] = field(default_factory=dict)
    # 本单选用的包装（产品 packaging[].id）；缺省 = 默认包装/最早创建的包装
    packaging_id: str = ""
    currency: str = "CNY"
    quote_currency: str = "USD"
    customer_id: str = ""
    tenant_id: str = ""
    notes_extra: list[str] = field(default_factory=list)
    # 逐行模式下被跳过的行数（由 _build_combos 回填，供接口回报）
    skipped_spec_rows: int = 0


@dataclass
class Row:
    """一行 = 一个规格组合。"""

    index: int
    spec: dict = field(default_factory=dict)
    derived: dict = field(default_factory=dict)
    price: dict = field(default_factory=dict)
    piece: dict = field(default_factory=dict)
    orders: dict = field(default_factory=dict)
    terms: dict = field(default_factory=dict)

    def resolve(self, key: str, default=None):
        """按命名空间取数。

        支持：index / spec.x / derived.x / price.x / piece.x /
              orders.<name>.<metric> / terms.<CODE>.<order>.<metric>
        """
        if key == "index":
            return self.index
        if "." in key:
            head, _, rest = key.partition(".")
            if head == "orders":
                oname, _, metric = rest.partition(".")
                return (self.orders.get(oname) or {}).get(metric, default)
            if head == "terms":
                parts = rest.split(".")
                per_order = self.terms.get(parts[0]) or {}
                if len(parts) >= 3:
                    order = per_order.get(parts[1]) or {}
                    if parts[2] == "fees":
                        return order.get("fees", default)
                    return order.get(parts[2], default)
                if len(parts) == 2:
                    for metrics in per_order.values():
                        if parts[1] in metrics:
                            return metrics[parts[1]]
                    return default
                return per_order or default
            bucket = getattr(self, head, None)
            if isinstance(bucket, dict):
                return bucket.get(rest, default)
            return default
        for bucket in (self.derived, self.price, self.piece, self.spec):
            if key in bucket:
                return bucket[key]
        return default


@dataclass
class QuoteResult:
    """一次报价的完整结果。"""

    request: QuoteRequest
    product: ProductSpec
    rows: list
    valid_until: date | None = None
    quote_date: date | None = None
    diagnostics: list = field(default_factory=list)
    term_codes: list = field(default_factory=list)
    quote_as: str = ""
    # 旧字段保留为空串：报告/兼容层仍引用；税务档案已改 DB，不再参与算价
    rate_set_code: str = ""

    @property
    def combo_count(self) -> int:
        return len(self.rows)

    def columns(self, view: str = "internal") -> list[Column]:
        """view='customer' 时剔除 internal 列（铁律：不暴露成本利润率）。"""
        return self.product.columns if view == "internal" else self.product.customer_columns()

    def table(self, view: str = "internal"):
        cols = self.columns(view)
        header = [c.label for c in cols]
        body = [[r.resolve(c.key) for c in cols] for r in self.rows]
        return header, body

    def table_en(self, view: str = "customer"):
        cols = self.columns(view)
        header = [(c.label_en or c.label) for c in cols]
        body = [[r.resolve(c.key) for c in cols] for r in self.rows]
        return header, body

    def main_term_summary(self) -> dict:
        """主术语在各订单量下的价格区间（给前端做概览卡片）。"""
        if not self.term_codes:
            return {}
        out: dict[str, dict] = {}
        for order in self.request.orders:
            prices = [
                (r.terms.get(self.quote_as) or {}).get(order.name) for r in self.rows
            ]
            prices = [p for p in prices if p]
            if not prices:
                continue
            out[order.name] = {
                "label": order.label,
                "total": order.total,
                "unit": order.unit,
                "min_price_incl": min(p["price_incl"] for p in prices),
                "max_price_incl": max(p["price_incl"] for p in prices),
                "min_total": min(p.get("total_incl", 0) for p in prices),
                "max_total": max(p.get("total_incl", 0) for p in prices),
                "min_price_fx": min(p.get("price_fx", 0) for p in prices),
                "max_price_fx": max(p.get("price_fx", 0) for p in prices),
            }
        return out


# ─────────────────────────────────────────────────────────────────────────────
# 规格展开
# ─────────────────────────────────────────────────────────────────────────────
def _apply_overrides(product: ProductSpec, overrides: Mapping[str, Any]) -> ProductSpec:
    """把报价单里的数值覆盖应用到变体包（结构不变、只改数值）。"""
    if not overrides:
        return product
    new_variants = []
    for vg in product.variants:
        ov = overrides.get(vg.name)
        if not ov:
            new_variants.append(vg)
            continue
        options = []
        for opt in vg.options:
            patch = ov.get(opt.get("name"))
            merged = dict(opt)
            if patch:
                merged.update(patch)
            options.append(merged)
        from .models import VariantGroup

        new_variants.append(VariantGroup(vg.name, tuple(options), vg.label, vg.label_en))
    return ProductSpec(**{**product.__dict__, "variants": new_variants})


def spec_from_partial(
    product: ProductSpec, row: Mapping[str, Any], row_index: int = 0
) -> dict:
    """把一条**部分规格**补全为完整规格（用于按表格逐行报价）。

    与 `expand_specs` 的区别：这里不展开笛卡尔积，只把给定的一行补全 ——
    客户常只关心若干具体组合，而不是全量 48 个。

    补全规则：
      · 变体包给的是**取值名**（如 wire="全丝2.0"）→ 带上该选项的全部属性
        （de/dm/dv/roll_len_m/roll_dia_m），保证「一选全变」
      · 独立轴必须给全（缺哪个就报哪个）
      · 变体包也可以只给属性名而跳过 group 名，此时按属性值反查选项

    校验失败会抛 `EngineError`，错误信息里带行号与可选值，便于回报给用户。
    """
    if not isinstance(row, Mapping):
        raise EngineError("第 %d 行不是键值对，无法解析为规格" % row_index)

    picked: dict = {}
    reserved = set(product.constants)
    for ax in product.axes:
        reserved.add(ax.name)
    for vg in product.variants:
        reserved.add(vg.name)
    for ni in product.numeric_inputs:
        reserved.add(ni.key)

    known = set(reserved)
    for vg in product.variants:
        for opt in vg.options:
            known.update(k for k in opt
                         if k not in ("name", "name_en", "code"))
        known.add(f"{vg.name}_code")
        known.add(f"{vg.name}_en")

    unknown = [k for k in row if k not in known]
    if unknown:
        raise EngineError(
            "第 %d 行出现无法识别的规格字段: %s；可用字段: %s"
            % (row_index, ", ".join(sorted(unknown)), ", ".join(sorted(known)))
        )

    # 独立轴：必须给全
    for ax in product.axes:
        if ax.name not in row:
            raise EngineError(
                "第 %d 行缺少规格轴「%s」；可选值: %s"
                % (row_index, ax.label or ax.name,
                   ", ".join(str(o) for o in ax.options))
            )
        picked[ax.name] = _match_axis_option(ax, row[ax.name], row_index)

    # 自由数值参数：给了就用，没给用默认值；只做上下界防误填，**不做枚举**
    for ni in product.numeric_inputs:
        if ni.key in row:
            picked[ni.key] = _numeric_value(ni, row[ni.key], row_index)
        elif ni.default is not None:
            picked[ni.key] = ni.default
        else:
            raise EngineError(
                "第 %d 行缺少数值参数「%s」" % (row_index, ni.label or ni.key))

    # 变体包：给取值名，或给该包内任一属性，或给稳定 code
    for vg in product.variants:
        # 空档位包 = 该产品不预置选项（如勾花网/鹿网的表面处理由定价数据补）。
        # 报价时视为“可不填”，不阻塞整行；有可选档位时才要求选。
        if not vg.options:
            continue
        want = row.get(vg.name)
        code_want = row.get(f"{vg.name}_code")
        chosen = None
        if want is not None or code_want is not None:
            for opt in vg.options:
                if want is not None and (
                    str(opt.get("name")) == str(want)
                    or str(opt.get("name_en")) == str(want)
                    or _loose_eq(opt.get("code"), want)
                ):
                    chosen = opt
                    break
                if code_want is not None and _loose_eq(opt.get("code"), code_want):
                    chosen = opt
                    break
            if chosen is None:
                raise EngineError(
                    "第 %d 行的「%s」取值 %r 不在可选范围；可选: %s"
                    % (row_index, vg.label or vg.name,
                       want if want is not None else code_want,
                       ", ".join(str(o.get("name")) for o in vg.options))
                )
        else:
            # 没给包名：用包内属性反查唯一选项
            given = {k: row[k] for k in row
                     if any(k in opt for opt in vg.options)}
            if given:
                hits = [
                    opt for opt in vg.options
                    if all(_loose_eq(opt.get(k), v) for k, v in given.items())
                ]
                if len(hits) == 1:
                    chosen = hits[0]
                elif not hits:
                    raise EngineError(
                        "第 %d 行的「%s」属性组合 %s 不对应任何方案；可选: %s"
                        % (row_index, vg.label or vg.name, given,
                           ", ".join(str(o.get("name")) for o in vg.options))
                    )
                else:
                    raise EngineError(
                        "第 %d 行的「%s」属性组合 %s 对应多个方案，请直接给方案名"
                        % (row_index, vg.label or vg.name, given)
                    )
            else:
                if not vg.options:
                    raise EngineError(
                        "第 %d 行缺少「%s」；该产品**还没有可选档位** —— "
                        "请先在「定价数据」里添加档位（本产品不预置档位，由客户自建）"
                        % (row_index, vg.label or vg.name)
                    )
                raise EngineError(
                    "第 %d 行缺少「%s」；可选: %s"
                    % (row_index, vg.label or vg.name,
                       ", ".join(str(o.get("name")) for o in vg.options))
                )
        picked[vg.name] = chosen.get("name", str(chosen))
        en = chosen.get("name_en")
        if en:
            picked[f"{vg.name}_en"] = en
        code = chosen.get("code")
        if code:
            picked[f"{vg.name}_code"] = code
        for attr, value in chosen.items():
            if attr in ("name", "name_en", "code"):
                continue
            picked[attr] = value

    # 显式覆盖：允许按属性名直接改（如只改 roll_len_m），后写覆盖变体包带出的值。
    # 变体包的 *_code / *_en 由上面的解析决定，不接受直接覆盖，避免自相矛盾。
    derived_keys = {f"{vg.name}_code" for vg in product.variants}
    derived_keys |= {f"{vg.name}_en" for vg in product.variants}
    for k, v in row.items():
        if k in reserved or k in derived_keys:
            continue
        picked[k] = v

    return picked


def _loose_eq(a, b) -> bool:
    """宽松相等：12 == "12"、1.2 == "1.2"、2.0 == 2。"""
    if a is None or b is None:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return a == b
    try:
        return Decimal(str(a)) == Decimal(str(b))
    except (InvalidOperation, TypeError, ValueError):
        # 只有「真·非数值」（如 "abc"、"1.5mm"）才退回字符串比较。
        # 这里**不能**用宽泛的 `except Exception`：它会把 NameError / AttributeError
        # 这类编程错误一并吞掉，使上面的数值分支静默失效。
        # 历史缺陷即由此产生：模块内原本缺少 `Decimal` 导入，导致 2.0 与 2
        # 被当成两个不同的值，导出 Excel 再回导会丢掉一半规格行。
        return str(a).strip() == str(b).strip()


def _match_axis_option(ax, value, row_index: int):
    """把输入值对齐到轴声明的取值（容忍 "1.2" 与 1.2、"10cm" 与 10）。"""
    for opt in ax.options:
        if _loose_eq(opt, value):
            return opt
    # 容忍带单位的写法（"10cm" / "1.5m"）
    if isinstance(value, str):
        stripped = value.strip().rstrip("cm米mM")
        for opt in ax.options:
            if _loose_eq(opt, stripped):
                return opt
    raise EngineError(
        "第 %d 行的「%s」取值 %r 不在可选范围；可选值: %s"
        % (row_index, ax.label or ax.name, value,
           ", ".join(str(o) for o in ax.options))
    )


def _numeric_value(ni, raw, row_index: int):
    """自由数值参数取值：转 Decimal 并做上下界防误填。

    与 `_match_axis_option` 的区别：这里**不枚举**取值 —— 丝径 2.3mm 就是 2.3mm。
    只挡两类明显填错：超出声明上下界、根本不是数字。

    容忍**同单位后缀**（`"1.2m"` / `"100mm"`）—— 与旧的轴选项同一宽容度，
    导表里带单位是常态。但**不跨单位换算**（`"1.2cm"` 不会被当成 0.012m），
    那是刻意的安全性质，见 test_engine_does_not_cross_convert_units。
    """
    from .numeric import to_decimal

    parsed = None
    try:
        parsed = to_decimal(raw)
    except Exception:
        # 只容忍**与声明单位一致**的后缀（"1.2m" 之于 unit="m"）。
        # 不能盲 strip：那会把 "10cm" 当成 10mm 用，差十倍 ——
        # 单位换算是**导入器**的职责（它按表头单位换算），引擎不跨单位换算。
        if isinstance(raw, str) and ni.unit:
            s = raw.strip()
            if len(s) > len(ni.unit) and s.endswith(ni.unit):
                try:
                    parsed = to_decimal(s[: -len(ni.unit)].strip())
                except Exception:
                    parsed = None
    if parsed is None:
        raise EngineError(
            "第 %d 行的「%s」不是数值，或单位与声明的「%s」不符: %r"
            % (row_index, ni.label or ni.key, ni.unit or "原值", raw))
    value = parsed
    if ni.min_value is not None and value < to_decimal(ni.min_value):
        raise EngineError(
            "第 %d 行的「%s」=%s 小于下界 %s"
            % (row_index, ni.label or ni.key, value, ni.min_value))
    if ni.max_value is not None and value > to_decimal(ni.max_value):
        raise EngineError(
            "第 %d 行的「%s」=%s 大于上界 %s"
            % (row_index, ni.label or ni.key, value, ni.max_value))
    return value


def _build_combos(
    product: ProductSpec, request: "QuoteRequest", diagnostics: list
) -> list[dict]:
    """决定这次要算哪些规格行。

    两种模式：
      · 未给 `spec_rows` → 展开规格轴的全部组合（全量报价，默认行为）
      · 给了 `spec_rows` → **只算给的那些行**，逐行补全与校验

    逐行模式下，一行出错**不阻断整批**：把该行标记为跳过并记诊断，
    其余行照常出结果。整批只有一行错就全军覆没，对批量导入是不可接受的。
    """
    if not request.spec_rows:
        return expand_specs(product)

    rows_out: list[dict] = []
    bad = 0
    seen: set = set()
    for i, raw in enumerate(request.spec_rows, start=1):
        try:
            spec = spec_from_partial(product, raw, i)
        except EngineError as exc:
            bad += 1
            diagnostics.append(str(exc))
            continue
        key = tuple(sorted((k, str(v)) for k, v in spec.items()))
        if key in seen:
            bad += 1
            diagnostics.append("第 %d 行与前面的规格重复，已跳过" % i)
            continue
        seen.add(key)
        rows_out.append(spec)

    if not rows_out:
        raise EngineError(
            "提供的 %d 行规格全部无法解析，请检查列名与取值" % len(request.spec_rows)
        )
    if bad:
        diagnostics.append(
            "共 %d 行规格未能采用（已跳过），%d 行正常计算出结果"
            % (bad, len(rows_out))
        )
    request.skipped_spec_rows = bad
    return rows_out


def expand_specs(product: ProductSpec) -> list[dict]:
    """规格轴 × 变体包 笛卡尔积。

    变体包内多个属性必须同进同出（如选一个丝径方案，
    边丝径/内横丝径/竖丝径/卷长/卷径一起确定）。
    """
    reserved = set(product.constants)
    for ax in product.axes:
        reserved.add(ax.name)

    combos: list[dict] = [{}]
    for ax in product.axes:
        combos = [dict(c, **{ax.name: v}) for c in combos for v in ax.options]

    for vg in product.variants:
        if not vg.options:
            # 空档位包不参与组合/校验（报价可正常进行，列留空）
            continue
        if not _IDENT.match(vg.name):
            raise EngineError(f"变体包名必须是合法标识符: {vg.name}")
        nxt = []
        for combo in combos:
            for opt in vg.options:
                new = dict(combo)
                new[vg.name] = opt.get("name", str(opt))
                # 英文名与稳定 code 单独存放，避免多个变体包的 name_en/code 互相覆盖
                en = opt.get("name_en")
                if en:
                    new[f"{vg.name}_en"] = en
                code = opt.get("code")
                if code:
                    new[f"{vg.name}_code"] = code
                for attr, value in opt.items():
                    if attr in ("name", "name_en", "code"):
                        continue
                    if not _IDENT.match(attr):
                        raise EngineError(
                            f"变体包 {vg.name} 的属性名 {attr!r} 不是合法标识符（公式里要引用它）"
                        )
                    if attr in reserved:
                        raise EngineError(
                            f"变体包 {vg.name} 的属性 {attr!r} 与常数/规格轴重名，会产生歧义"
                        )
                    new[attr] = value
                nxt.append(new)
        combos = nxt

    # ── 自由数值参数：不参与笛卡尔积（连续量没有"组合数"）──
    # 每个组合都带上默认值；要用别的值就走 `spec_rows` 逐行覆盖。
    for ni in product.numeric_inputs:
        if not _IDENT.match(ni.key):
            raise EngineError(f"数值参数名必须是合法标识符（公式里要引用它）: {ni.key}")
        if ni.key in reserved:
            raise EngineError(
                f"数值参数 {ni.key!r} 与常数/规格轴重名，会产生歧义")
        if ni.default is None:
            raise EngineError(
                f"数值参数「{ni.label or ni.key}」没有默认值：展开全量规格时取不到值，"
                f"请给它默认值，或用 spec_rows 逐行提供")
        reserved.add(ni.key)
        for combo in combos:
            combo[ni.key] = ni.default

    dup = set()
    label_keys = {vg.name for vg in product.variants} | {f"{vg.name}_en" for vg in product.variants}
    label_keys |= {f"{vg.name}_code" for vg in product.variants}
    for combo in combos:
        key = tuple(sorted((k, str(v)) for k, v in combo.items() if k not in label_keys))
        if key in dup:
            raise EngineError(
                "规格展开出现重复组合（忽略变体名称后属性完全相同），请检查取值是否重复"
            )
        dup.add(key)
    return combos


# ─────────────────────────────────────────────────────────────────────────────
# 公式执行
# ─────────────────────────────────────────────────────────────────────────────
def _run_specs(
    specs: list[FormulaSpec],
    scope: dict,
    label: str,
    diagnostics: list[str],
    mode=DECIMAL,
    row_no: int = 0,
) -> dict:
    out: dict = {}
    for spec in specs:
        try:
            value = expr_mod.evaluate(spec.expr, scope, mode)
        except expr_mod.ExpressionError as exc:
            raise EngineError(f"{label} 公式 {spec.name} 求值失败: {exc}") from exc
        except ZeroDivisionError as exc:
            raise EngineError(f"{label} 公式 {spec.name} 出现除以零: {spec.expr!r}") from exc
        # 计数类指标必须在落定之前判断是否为整数，
        # 否则四舍五入会把 50.5 悄悄变成 50，错误被吞掉。
        if spec.integer and not mode.exact and not is_integral(value):
            from .numeric import to_decimal

            diagnostics.append(
                f"第 {row_no} 行 {label} 的 {spec.name} 不是整数: {to_decimal(value)}"
                "（订单量可能无法整除单件规格）"
            )
        if spec.decimals is not None:
            value = mode.quantize(value, spec.decimals)
        out[spec.name] = value
        scope[spec.name] = value
    return out


def resolve_space_deduction(product: ProductSpec, scope: dict, mode=DECIMAL):
    """把体积扣减口径解析为一个**绝对值**（m³）。

    按比例的模式（`ratio`）没有固定额 —— 它的修正量随订单体积变，
    由 `resolve_space_deduction_ratio` 给系数、在公式里乘出来，
    所以这里返回 0。两者可叠加：
        `volume_effective_m3 = volume_box_m3 * (1 - ratio) - space_deduction`
    """
    sd = product.space_deduction
    if sd.mode == "formula" and sd.expr:
        return mode.convert(expr_mod.evaluate(sd.expr, scope, mode))
    if sd.mode == "ratio":
        return mode.convert(0)
    if sd.mode == "fixed":
        return mode.convert(sd.value)
    if sd.mode in ("median", "mean"):
        if not sd.range or len(sd.range) != 2:
            raise EngineError(f"space_deduction 使用 {sd.mode} 模式时必须给出 range: [min, max]")
        lo, hi = mode.convert(sd.range[0]), mode.convert(sd.range[1])
        return mode.divide(lo + hi, mode.convert(2))
    raise EngineError(f"未知的 space_deduction 模式: {sd.mode}")


def resolve_space_deduction_ratio(product: ProductSpec) -> Any:
    """体积扣减里**按比例**的那一部分（0.04 = 扣掉 4%）；非比例模式为 0。

    为什么不并进 `resolve_space_deduction`：扣减在**派生公式之前**就要落进作用域，
    而订单体积（`volume_box_m3`）要到订单指标阶段才知道。
    固定额与比例是两种不同性质的东西（一个是 m³、一个是无量纲系数），
    分开给、在公式里合成，才不会出现"比例被当成 2.5 立方米扣掉"这种事故。
    """
    return product.space_deduction.ratio


def policy_scope(policy: PricingPolicy) -> dict:
    """把报价政策的旋钮暴露进表达式作用域。

    让产品类的关系式能写成与政策联动的形式
    （如用 `give_ratio` 而不是硬编码 0.80），改配置时关系式不会悄悄失真。
    """
    return {
        "give_ratio": policy.give_ratio,
        "input_vat_rate": policy.input_vat_rate,
        "output_vat_config_rate": policy.output_vat_rate,
        "output_vat_mode": policy.output_vat_mode,
        "stamp_rate": policy.stamp_rate,
        "stamp_base": policy.stamp_base,
        "profit_mode": policy.profit_mode,
        "profit_value": policy.profit_value,
        "misc_fee_rate": policy.misc_fee_rate,
        "rebate_rate": policy.rebate_rate if policy.rebate_rate is not None else 0,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────
def build(request: QuoteRequest, mode=DECIMAL) -> QuoteResult:
    """执行一次出口报价计算。"""
    product = request.product
    if product is None:
        if not request.product_key:
            raise EngineError("必须提供 product_key 或 product")
        from .products import get as get_product

        try:
            product = get_product(request.product_key)
        except KeyError as exc:
            raise EngineError(str(exc)) from exc
    product = _apply_overrides(product, request.variant_overrides)

    orders = list(request.orders)
    if not orders:
        raise EngineError("至少需要一个订单量方案（orders）")

    diagnostics: list[str] = []
    policy = request.policy
    # ── 产品级利润配置优先：产品级 > 报价单级 > 税务档案默认 ──
    # 仅当报价单**未显式指定**利润参数时才用产品级默认（避免测试/历史配置被覆盖）。
    # 判断口径：报价单 policy 的 profit_mode 为默认 fixed 且 profit_value 为 0 视为「未指定」。
    _profit_unspecified = (
        getattr(request.policy, "profit_mode", "fixed") == "fixed"
        and not getattr(request.policy, "profit_value", 0)
    )
    if product.profit_mode and _profit_unspecified:
        policy = policy.with_(
            profit_mode=product.profit_mode,
            profit_value=product.profit_value,
            misc_fee_rate=product.misc_fee_rate,
        )
    if mode is DECIMAL:
        _, refund_warn = policy.resolve_refund_ratio(mode)
        if refund_warn:
            diagnostics.append(refund_warn)
        diagnostics.extend(policy.consistency_warnings(mode))

    combos = _build_combos(product, request, diagnostics)
    # 汇率缺失才回落到 1；显式传 0/负数必须报错 ——
    # 静默当成 1 会让外币价与人民币价相等（客户看到美元价 = 元价），是最难察觉的错误。
    raw_fx = request.fx_rate
    fx = mode.convert(1) if raw_fx is None or raw_fx == "" else mode.convert(raw_fx)
    if fx <= 0:
        raise EngineError(f"汇率必须 > 0（当前 {request.fx_rate!r}）")

    rows: list[Row] = []
    with localcontext() as ctx:
        ctx.prec = PRECISION
        for idx, combo in enumerate(combos, start=1):
            scope: dict = {}
            scope.update(product.constants)
            scope.update(policy_scope(policy))
            scope.update(request.constants_override)
            scope["fx_rate"] = fx
            scope["product_key"] = product.key
            scope.update(combo)
            row_spec = dict(scope)
            scope["space_deduction"] = resolve_space_deduction(product, scope, mode)
            scope["space_deduction_ratio"] = resolve_space_deduction_ratio(product)

            derived = _run_specs(product.derived, scope, "派生公式", diagnostics, mode, idx)

            # 成本取值：先按「定价键」查客户定价数据，查不到再回退产品定义的内联成本。
            # 两条路径都必须给出明确结果 —— 都没有就报错，绝不用 0 或默认价糊过去。
            cost_key = pricing_key_of(product, scope)
            table_cost = request.cost_table.get(cost_key) if (cost_key and request.cost_table) else None
            if table_cost is not None:
                raw_cost = mode.convert(table_cost)
            else:
                if product.cost_field not in scope:
                    raise EngineError(
                        f"成本字段 {product.cost_field!r} 不在可用变量中；"
                        f"现有变量: {', '.join(sorted(k for k in scope if not k.startswith('_')))}"
                    )
                raw_cost = mode.convert(scope[product.cost_field])
            vat = mode.convert(policy.input_vat_rate)
            if product.cost_basis == "incl_tax":
                cost_pretax = mode.quantize(raw_cost * (mode.convert(1) - vat), 6)
            elif product.cost_basis == "pretax":
                cost_pretax = raw_cost
            else:
                raise EngineError(f"cost_basis 只能是 pretax 或 incl_tax（当前 {product.cost_basis}）")

            # 包装费：按当前规格解析（元/卷），计入税前成本后再算利润/税。
            pkg_fee, _pkg, _pkg_range = _packaging_fee(
                product, request.packaging_id, {**scope, **derived}, mode,
            )
            if pkg_fee:
                cost_pretax = cost_pretax + pkg_fee

            price = policy.breakdown(cost_pretax, unit_count=1, mode=mode)

            # 单件指标（先用不含术语基准算一次，供订单指标取件数）
            piece_scope = dict(scope)
            piece_scope.update(derived)
            piece_scope["terms_enabled"] = mode.convert(0)
            piece_scope["main_price_incl"] = mode.convert(0)
            piece_scope["quote_excl_vat"] = price["quote_excl_vat"]
            piece_scope["quote_incl_vat"] = price["quote_incl_vat"]
            piece_scope["unit_price"] = price["quote_final"]
            for k, v in price.items():
                piece_scope[f"price_{k}"] = v
            piece = _run_specs(
                product.piece_metrics, dict(piece_scope), "单件指标", diagnostics, mode, idx
            )

            # 订单指标预演：只为拿到件数（per_shipment 类费用需要按订单量摊到单件）。
            # 价格类指标此时用 0 占位，随后用真实值重算。
            pieces_by_order: dict[str, Any] = {}
            for order in orders:
                oscope = dict(piece_scope)
                oscope.update(piece)
                oscope["total"] = order.total
                oscope["order_total"] = order.total
                oscope["order_unit"] = order.unit
                oscope["order_name"] = order.name
                pre = _run_specs(
                    product.order_metrics, oscope, f"订单指标预演({order.name})",
                    [], mode, idx,
                )
                pieces_by_order[order.name] = pre.get("pieces")

            # 术语阶梯（fees 依赖订单件数，故必须在件数已知后计算）
            per_code: dict[str, dict] = {}
            main_price_incl = mode.convert(0)
            if request.terms is not None:
                weight = derived.get(request.terms.weight_field)
                if weight is None:
                    raise EngineError(
                        f"terms.weight_field={request.terms.weight_field!r} 不在派生值中；"
                        f"现有派生值: {', '.join(sorted(derived)) or '（空）'}"
                    )
                exw_per_piece = mode.quantize(price["quote_excl_vat"] * weight, 8)
                for order in orders:
                    ladder = request.terms.compute(
                        exw_per_piece,
                        weight,
                        pieces_by_order[order.name],
                        vat_rate=mode.convert(policy.output_vat_rate or 0),
                        vat_mode=policy.output_vat_mode,
                        mode=mode,
                        price_inputs=request.price_inputs,
                        fx_rate=fx,
                    )
                    for code, data in ladder.items():
                        entry = dict(data)
                        entry["price_fx"] = mode.quantize(
                            mode.divide(entry["price_incl"], fx), 4
                        )
                        if "total_incl" in entry:
                            entry["total_fx"] = mode.quantize(
                                mode.divide(entry["total_incl"], fx), 2
                            )
                        entry["order"] = order.name
                        entry["total_m"] = order.total
                        per_code.setdefault(code, {})[order.name] = entry
                if per_code.get(request.terms.quote_as):
                    first = orders[0].name
                    main_price_incl = per_code[request.terms.quote_as][first]["price_incl"]

            # 单件指标（正式）：启用术语时单卷价取主术语含税价
            piece_scope["terms_enabled"] = mode.convert(1 if request.terms is not None else 0)
            piece_scope["main_price_incl"] = main_price_incl
            piece = _run_specs(
                product.piece_metrics, piece_scope, "单件指标", diagnostics, mode, idx
            )

            # 订单指标（正式，含真实价格）
            order_metrics: dict[str, dict] = {}
            for order in orders:
                oscope = dict(piece_scope)
                oscope.update(piece)
                oscope["order_name"] = order.name
                oscope["order_label"] = order.label
                oscope["total"] = order.total
                oscope["order_total"] = order.total
                oscope["order_unit"] = order.unit
                metrics = _run_specs(
                    product.order_metrics, oscope, f"订单指标({order.name})",
                    diagnostics, mode, idx,
                )
                metrics["_label"] = order.label
                metrics["_label_en"] = order.label_en or order.label
                metrics["_total"] = order.total
                metrics["_unit"] = order.unit
                order_metrics[order.name] = metrics

            rows.append(
                Row(
                    index=idx,
                    spec=row_spec,
                    derived=derived,
                    price=price,
                    piece=piece,
                    orders=order_metrics,
                    terms=per_code,
                )
            )

    today = request.quote_date or date.today()
    valid_until = today + timedelta(days=max(1, int(request.validity_days or DEFAULT_VALIDITY_DAYS)))

    return QuoteResult(
        request=request,
        product=product,
        rows=rows,
        valid_until=valid_until,
        quote_date=today,
        diagnostics=diagnostics,
        term_codes=list(request.terms.codes) if request.terms else [],
        quote_as=request.terms.quote_as if request.terms else "",
    )


def order_scopes(result: QuoteResult):
    """产出 (row, order, scope) —— 供关系式校验与敏感性复用。"""
    req = result.request
    policy = req.policy
    for row in result.rows:
        for order in req.orders:
            metrics = row.orders.get(order.name) or {}
            scope: dict = {}
            scope.update(result.product.constants)
            scope.update(policy_scope(policy))
            scope.update(req.constants_override)
            scope["fx_rate"] = req.fx_rate if req.fx_rate is not None else 1
            scope.update(row.spec)
            scope.update(row.derived)
            scope.update(row.price)
            for k, v in row.price.items():
                scope[f"price_{k}"] = v
            scope["unit_price"] = row.price.get("quote_final")
            scope.update(row.piece)
            # 术语开关与主术语单件价：让关系式能区分"客户看到的是主术语价"
            scope["terms_enabled"] = 1 if result.term_codes else 0
            main = (row.terms.get(result.quote_as) or {}).get(order.name) if result.quote_as else None
            scope["main_price_incl"] = main["price_incl"] if main else 0
            scope["order_name"] = order.name
            scope["order_label"] = order.label
            scope["total"] = order.total
            scope["order_total"] = order.total
            scope["order_unit"] = order.unit
            scope.update({k: v for k, v in metrics.items() if not k.startswith("_")})
            scope["space_deduction"] = resolve_space_deduction(result.product, scope, DECIMAL)
            scope["space_deduction_ratio"] = resolve_space_deduction_ratio(result.product)
            yield row, order, scope


def ladder_from_config(terms_cfg: Mapping[str, Any] | None) -> TermLadder | None:
    """便捷转发，便于 API 层直接从配置构造术语阶梯。"""
    try:
        return ladder_from_dict(terms_cfg)
    except TermsError as exc:
        raise EngineError(f"术语阶梯配置有误: {exc}") from exc


def make_request_from_config(cfg: dict) -> QuoteRequest:
    """从「报价单配置」构造 QuoteRequest。

    配置结构（都可通过 API 覆盖）：
        product: {model: field_fence, variant_overrides: {...}, constants: {...}}
        policy:  {...}                      # PricingPolicy 字段
        fx:      {rate: 6.7019, ...}
        orders:  [{name, total, unit, label}] 或 [30000, 50000]
        terms:   {...}
        price_inputs: {...}
        validity_days: 7
    """
    from .pricing import policy_from_dict

    product_cfg = cfg.get("product") or {}
    fx_cfg = cfg.get("fx") or {}
    raw_orders = cfg.get("orders") or []
    orders: list[OrderSpec] = []
    for i, o in enumerate(raw_orders):
        if isinstance(o, (int, float, str)):
            total = o
            name = f"o{o}"
            label = f"{o}米"
            unit = "m"
            label_en = f"{o} m"
        else:
            total = o.get("total")
            name = str(o.get("name") or f"o{total}")
            label = str(o.get("label") or f"{total}米")
            unit = str(o.get("unit") or "m")
            label_en = str(o.get("label_en") or f"{total} {unit}".strip())
        orders.append(OrderSpec(name=name, total=total, unit=unit, label=label, label_en=label_en))

    return QuoteRequest(
        product_key=str(product_cfg.get("model") or product_cfg.get("key") or ""),
        policy=policy_from_dict(cfg.get("policy") or {}),
        fx_rate=fx_cfg.get("rate", 1),
        fx_source=str(fx_cfg.get("source") or ""),
        orders=orders,
        terms=ladder_from_config(cfg.get("terms")),
        price_inputs=cfg.get("price_inputs") or {},
        validity_days=int(cfg.get("validity_days", DEFAULT_VALIDITY_DAYS)),
        constants_override=product_cfg.get("constants") or {},
        variant_overrides=product_cfg.get("variant_overrides") or {},
        currency=str((cfg.get("meta") or {}).get("base_currency", "CNY")),
        quote_currency=str((cfg.get("meta") or {}).get("quote_currency", "USD")),
        customer_id=str(cfg.get("customer_id") or ""),
        tenant_id=str(cfg.get("tenant_id") or ""),
        notes_extra=list(cfg.get("notes") or []),
    )
