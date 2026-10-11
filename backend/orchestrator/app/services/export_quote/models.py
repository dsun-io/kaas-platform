"""报价模型的共享数据结构。

这些类型把「产品知识」与「报价计算」解耦：
产品类声明规格轴、变体、公式与列；引擎只负责展开与求值。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from decimal import Decimal, InvalidOperation
from typing import Any


@dataclass(frozen=True)
class FormulaSpec:
    """一条派生公式。decimals 处即逐级落定，下游用的是落定后的值。

    note 是该量的**业务口径说明**（怎么算、为什么这么算），
    unit 是计量单位。二者只为「把计算逻辑讲清楚」而存在——
    报价工位要把公式与口径一并展示给业务确认，不能只有一个表达式。
    """

    name: str
    expr: str
    decimals: int | None = None
    integer: bool = False  # 计数类（卷数/支数），非整数时报诊断
    label: str = ""
    label_en: str = ""
    unit: str = ""
    note: str = ""


@dataclass(frozen=True)
class Axis:
    """独立规格轴：各轴做笛卡尔积。"""

    name: str
    options: tuple
    label: str = ""
    label_en: str = ""


@dataclass(frozen=True)
class VariantGroup:
    """关联属性包：一选全变（如选一个丝径方案，多个直径/卷长同时确定）。"""

    name: str
    options: tuple  # 每项是 dict，含 name 与若干属性
    label: str = ""
    label_en: str = ""


@dataclass(frozen=True)
class PieceInput:
    """按件填写的规格参数（用户可在「数量区」直接改）。

    为什么需要这一层声明
    --------------------
    有些规格参数**物理上绑定在一起**：卷长改了，卷径必须跟着改，
    否则体积（体积 = π/4 × 卷径² × 网高）就是错的 —— 而体积是对外报运价/报关的口径。
    它们默认由变体包联动确定。若要允许在界面上直接改，就必须让界面知道
    「改哪个属性、怎么回写」，否则界面只能把属性名写死 ——
    那就与「属性名与取值是产品的数据、不是界面的」这条原则相冲突。

    本声明只描述**映射关系**，不含任何取值：
      · key     —— 覆盖哪个变体属性
      · variant —— 该属性属于哪个变体组
                   （默认值 = 该组**当前选中项**的这个属性）

    引擎不认识 piece_inputs；它只认 variant_overrides。本声明是给界面看的。

    关于单位：`unit` 是**引擎内部单位**（公式里用的那个），`ui_unit` 是**界面给用户看的单位**。
    两者可以不同 —— 业务用的是公分（卷径 30 公分），而体积公式用的是米（π/4 × 0.30² × 网高）。
    因此界面上显示与输入的是「引擎值 × ui_scale」，回写覆盖时再除回去。
    这样界面不必懂业务单位，业务也不必去换算公式单位。
    """

    key: str
    label: str = ""
    label_en: str = ""
    unit: str = ""  # 引擎内部单位（公式用的，如 m）
    ui_unit: str = ""  # 界面单位（如 公分）；留空则同 unit
    ui_scale: float = 1.0  # 界面值 = 引擎值 × ui_scale（m→cm 填 100）
    variant: str = ""
    note: str = ""
    # 本项是「每件的数量」（如每卷多少米）。界面的「总数」= 本项 × 件数。
    # 必须由产品声明，不能让界面按顺序猜 —— 否则加一个参数就会算错总数。
    unit_quantity: bool = False


@dataclass(frozen=True)
class NumericInput:
    """自由数值规格参数 —— 直接填任意值，不做枚举。

    为什么需要它
    ------------
    丝径 / 网高 / 竖丝间距 / 卷长 / 卷径 这类量在业务上是**连续值**：
    客户给 2.3mm 就是 2.3mm。枚举只能覆盖事先想到的取值，于是
    「选不到」会逼着人把值写进备注，公式反而算不出来。
    重量、体积、成本由 `derived` 公式从这些自由值折算，
    所以取值本身不需要被枚举约束 —— 这也正是「新增产品的自由度」：
    加一个数值参数只需多一条声明，不必改界面或引擎。

    与 Axis 的分工：**可枚举的**（表面处理、工艺、材质）继续用
    Axis / VariantGroup，以便报价单与定价数据有稳定 code；
    **连续的**用 NumericInput。
    """

    key: str
    label: str = ""
    label_en: str = ""
    unit: str = ""          # 引擎内部单位（公式里用的那个）
    ui_unit: str = ""       # 界面单位；留空则同 unit
    ui_scale: float = 1.0   # 界面值 = 引擎值 × ui_scale（m→cm 填 100）
    default: Any = None     # 未提供时用它；None 表示必填
    min_value: Any = None   # 可选下界（含）。只做防误填，不做枚举
    max_value: Any = None
    decimals: int | None = None
    # 表头单位 → **引擎单位** 的换算表，如 {"cm": "10"}（表头写 cm、值 10 → 10cm → 100mm）。
    # 导出列用的就是这些单位，导入时必须按同一张表换回去，否则「导出→改→再导入」
    # 会把单位认错（例如 10cm 被当成 10mm，差十倍）。留空则按 unit / ui_scale 推断。
    unit_factors: Any = None
    note: str = ""


@dataclass(frozen=True)
class OrderSpec:
    """订单量方案。"""

    name: str
    total: Any
    unit: str = ""
    label: str = ""
    label_en: str = ""


@dataclass(frozen=True)
class Column:
    """输出列定义。

    internal=True 的列只出现在内部核算视图，客户视图自动剔除 ——
    这是「对外展示不得暴露成本利润率」铁律的落地点。
    """

    key: str
    label: str = ""
    label_en: str = ""
    decimals: int | None = None
    internal: bool = False
    width: float | None = None


@dataclass(frozen=True)
class Invariant:
    """必须成立的关系式；表达式在每个「行 × 订单」作用域内求值。"""

    name: str
    expr: str
    severity: str = "error"  # error | warning


@dataclass(frozen=True)
class SpaceDeduction:
    """体积按长方体累计后的扣减口径。

    业务口径：每卷按长方体（卷径² × 网高）累加得到总体积，
    再扣掉一部分。扣减的由来是卷与卷之间并非完美网格堆叠，
    边界余量实际堆不到满箱。

    两种形态（可叠加，公式为
    `volume_box_m3 * (1 - space_deduction_ratio) - space_deduction`）：

    · **按比例**（`mode="ratio"`，`value` = 扣减比例）—— 推荐。
      随数量自然缩放，且**永远不会算出负体积**。
      工厂经验值可换算：满柜多占 2~3 m³ ÷ 整柜容量。
    · **按绝对值**（`fixed` / `median` / `mean` / `formula`，解析成一个 m³ 数）。
      注意：固定值在**小单上会扣除超过总体积**，算出负体积
      （实测牛栏网 < 2314 米时 `volume_effective_m3` 为负），所以只适合
      数量级稳定的场景。
    """

    mode: str = "fixed"  # fixed | median | mean | formula | ratio
    value: Any = 0
    range: tuple | None = None
    expr: str = ""
    note: str = ""

    @property
    def ratio(self):
        """按比例扣减时的**扣减比例**（0.04 = 扣掉 4%）；其他模式为 0。"""
        if self.mode != "ratio":
            return 0
        return self.value or 0


@dataclass
class ProductSpec:
    """一个产品类的完整声明（纯数据，可来自 Python 类或 YAML）。"""

    key: str
    name: str = ""
    name_en: str = ""
    category_code: str = ""
    cost_field: str = "raw_price"
    cost_basis: str = "pretax"  # pretax | incl_tax
    cost_unit: str = ""
    constants: dict = field(default_factory=dict)
    axes: list = field(default_factory=list)
    variants: list = field(default_factory=list)
    derived: list = field(default_factory=list)
    space_deduction: SpaceDeduction = field(default_factory=SpaceDeduction)
    piece_metrics: list = field(default_factory=list)
    order_metrics: list = field(default_factory=list)
    columns: list = field(default_factory=list)
    invariants: list = field(default_factory=list)
    params: list = field(default_factory=list)  # [[参数, 取值, 单位, 说明], ...]
    piece_inputs: list = field(default_factory=list)  # [PieceInput, ...] 数量区可改的规格参数
    # ── 自由数值规格参数（[NumericInput, ...]）──
    # 丝径 / 网高 / 间距 / 卷长 / 卷径 这类**连续量**：客户填任意值，
    # 由 `derived` 公式折算成重量/体积/成本。不参与 combo_count 的笛卡尔积
    # （它们是连续量，枚举组合数在数学上就不成立）。
    numeric_inputs: list = field(default_factory=list)
    # ── 定价键：决定「去定价数据里查哪一行」的维度组合 ──
    # 每一项：{"field": 取值字段, "label": 中文名, "unit": 单位(可省), "label_field": 显示用字段(可省)}
    # 例（牛栏网）：成本随「边丝径 × 镀锌量」变，与网高/网孔无关 →
    #   [{"field": "de", "label": "边丝径", "unit": "mm"},
    #    {"field": "coating_code", "label": "镀锌量", "label_field": "coating"}]
    # field 取的是**稳定标识**（如 coating_code），label_field 取的是**给人看的名字**。
    pricing_key: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    hs_codes: list = field(default_factory=list)  # 用于退税率查询
    # ── 产品级利润配置（租户可配，留权限口子）──
    # profit_mode: margin_on_price（默认，售价加成）| fixed | ratio
    # profit_value: 利润率（margin_on_price/ratio 模式）或固定额（fixed 模式）
    # misc_fee_rate: 综合税费系数（默认 0.03，含印花税等杂税，对销项计征）
    # 优先级：产品级配置 > 报价单级配置 > 税务档案默认值
    profit_mode: str = "margin_on_price"
    profit_value: Any = 0.06
    misc_fee_rate: Any = 0.03

    # ---------- 便捷 ----------
    @property
    def combo_count(self) -> int:
        n = 1
        for ax in self.axes:
            n *= len(ax.options)
        for vg in self.variants:
            n *= len(vg.options)
        return n

    def summary(self) -> str:
        parts = [f"{a.name}({len(a.options)})" for a in self.axes]
        parts += [f"{v.name}({len(v.options)})" for v in self.variants]
        return " × ".join(parts) or "（无规格轴）"

    def internal_columns(self) -> list:
        return [c for c in self.columns if c.internal]

    def customer_columns(self) -> list:
        return [c for c in self.columns if not c.internal]


# ─────────────────────────────────────────────────────────────────────────────
# 定价键（产品级工具函数）
# ─────────────────────────────────────────────────────────────────────────────
def pricing_key_fields(product: "ProductSpec") -> list[str]:
    """定价键用到的取值字段名（按声明顺序）。未声明定价键则返回空表。"""
    return [d["field"] for d in (product.pricing_key or []) if d.get("field")]


def pricing_key_value(value) -> str:
    """定价键里**单个取值**的规范写法 —— 必须跨进程、跨语言稳定。

    为什么不能直接 ``str(value)``：这条键要在**三个地方**各自拼一次
    （引擎算价时、界面提交时、脚本写库时），三处必须拼出**完全相同**的字符串，
    否则就是三把不同的钥匙开同一把锁。

    浮点数会踩这个坑：JSON 会把 ``2.0`` 变成 ``2``（JS 里没有"2.0"这个数），
    于是界面存进去的是 ``de=2``、引擎查的是 ``de=2.0`` ——
    症状是「保存成功了，但界面不显示、报价也不变」，也就是用户眼里的"存不上"。

    所以数值一律用 Decimal 归一化、去掉尾随零，再把科学计数法展开成普通写法。
    **数字型的字符串同样要归一化**：界面回传的就是 ``"3.0"`` 这样的字符串，
    只归一化数字类型的话，引擎（浮点 3.0 → "3"）与界面（"3.0"）又会分叉 ——
    这个坑踩过一次，第二次就是因为漏了字符串这条路径。
    """
    if isinstance(value, bool):  # bool 是 int 的子类，得先拦
        return str(value)
    if isinstance(value, str):
        text = value.strip()
        try:
            parsed = Decimal(text)
        except (InvalidOperation, ValueError):
            return value  # 非数字（如变体编码 zinc_40）原样保留
        if not parsed.is_finite():
            return value
        # format(..., 'f') 会把 1E+2 这类写法展开成 100
        return format(parsed.normalize(), "f")
    if isinstance(value, (int, float, Decimal)):
        try:
            normalized = Decimal(str(value)).normalize()
        except (InvalidOperation, ValueError):
            return str(value)
        # normalize() 会把 100 写成 1E+2、把 30000 写成 3E+4，用 'f' 展开回来
        return format(normalized, "f")
    return str(value)


def pricing_key_of(product: "ProductSpec", scope: dict) -> str:
    """把当前规格组合的定价键拼成稳定字符串，用作定价数据的查价键。

    形如 ``de=2|coating_code=zinc_40``；末尾无分隔符，避免「前缀相同」的两条
    键互相误匹配（查表是精确匹配，这里仍需保证两端一致）。

    返回空字符串表示**该组合没有定价键**（产品未声明，或某个维度没取到值），
    调用方据此回退到产品定义里的内联成本。
    """
    fields = pricing_key_fields(product)
    if not fields:
        return ""
    parts: list[str] = []
    for field in fields:
        value = scope.get(field)
        if value is None:
            # 维度取不到值就不能查价 —— 宁可回退，也不要用半截键去查出错价
            return ""
        parts.append(f"{field}={pricing_key_value(value)}")
    return "|".join(parts)


def pricing_key_dimensions(product: "ProductSpec") -> dict[str, tuple[str, Any]]:
    """定价键字段 → 它在产品定义里的「维度」。

    返回值：``{字段: ("axis", Axis) | ("variant", VariantGroup) | ("numeric", NumericInput)}``。

    把「哪个字段对应哪个维度」的判断**收在一处**：扩展档位、列出已定义取值、
    拼查价键都靠它，三处各写一遍迟早会分叉。

    尺寸类改成自由数值后，原先的轴维度会落到 `"numeric"` 上 ——
    调用方必须认得这一种，否则就会出现
    「`formulas.describe_pricing_key` 说 de 是维度、这里说不是」的分叉。
    """
    out: dict[str, tuple[str, Any]] = {}
    axes = {ax.name: ax for ax in product.axes}
    variants = {f"{vg.name}_code": vg for vg in product.variants}
    numerics = {ni.key: ni for ni in product.numeric_inputs}
    for dim in (product.pricing_key or []):
        field = dim.get("field")
        if not field:
            continue
        if field in axes:
            out[field] = ("axis", axes[field])
        elif field in variants:
            out[field] = ("variant", variants[field])
        elif field in numerics:
            out[field] = ("numeric", numerics[field])
    return out


def pricing_key_defined_values(product: "ProductSpec") -> dict[str, set[str]]:
    """定价键每个维度在产品定义里**已经定义**的取值（规范化字符串形式）。"""
    out: dict[str, set[str]] = {}
    for field, (kind, dim) in pricing_key_dimensions(product).items():
        if kind == "numeric":
            # 自由数值维度**没有预定义取值**（客户填什么就是什么）。
            # 给一个非空集合会让界面误以为这里要枚举。
            out[field] = set()
        elif kind == "axis":
            out[field] = {pricing_key_value(o) for o in dim.options}
        else:
            out[field] = {pricing_key_value(o.get("code")) for o in dim.options}
    return out


def extend_product(
    product: "ProductSpec",
    extensions: dict[str, list[dict]] | None,
) -> "ProductSpec":
    """把「客户自己加的档位」并入产品定义，得到本次请求的**有效规格空间**。

    为什么放在这里：产品定义是纯数据，扩展也只是纯数据的合并 ——
    引擎依旧不认识数据库，它只拿到一份（可能被扩展过的）产品定义。

    ``extensions`` 形如::

        {"de": [{"value": "3.0", "label": "3.0"}],
         "coating_code": [{"value": "zinc_60", "label": "镀锌60g/㎡"}]}

    键与 ``ProductSpec.pricing_key`` 的字段名一致：
      · 维度是规格轴 → 往轴上追加取值（类型对齐已有取值，丝径必须仍是数字，
        否则重量公式里的 ``de**2`` 会对字符串求幂而崩）；
      · 维度是变体包的 ``_code`` → 给该变体包追加一个选项（只有 code 与显示名）。
        新档位**不写入 raw_price 等属性**：成本由定价数据提供，
        这正是「定价数据就是成本来源」的落点。
    """
    if not extensions:
        return product

    dims = pricing_key_dimensions(product)
    new_axes = list(product.axes)
    new_variants = list(product.variants)

    for field, items in extensions.items():
        if not items or field not in dims:
            continue
        kind, dim = dims[field]

        if kind == "numeric":
            # 自由数值维度**不需要也不能扩展**：客户填 3.0 就是 3.0，
            # 没有"可选值清单"可追加。
            # （原先是枚举轴，客户要加档位才能选到自己要的丝径；
            #   改成自由数值后这条路自然消失 —— 这正是不再需要它的原因。）
            continue

        if kind == "axis":
            have = {pricing_key_value(o) for o in dim.options}
            added = []
            for it in items:
                raw = it.get("value")
                if raw is None or pricing_key_value(raw) in have:
                    continue
                added.append(_coerce_axis_value(dim, raw))
                have.add(pricing_key_value(raw))
            if added:
                new_axes[new_axes.index(dim)] = replace(
                    dim, options=tuple(dim.options) + tuple(added)
                )
        else:
            have = {pricing_key_value(o.get("code")) for o in dim.options}
            added_opts = []
            for it in items:
                raw = it.get("value")
                if raw is None or pricing_key_value(raw) in have:
                    continue
                added_opts.append({
                    "code": raw,
                    "name": str(it.get("label") or raw),
                })
                have.add(pricing_key_value(raw))
            if added_opts:
                new_variants[new_variants.index(dim)] = replace(
                    dim, options=tuple(dim.options) + tuple(added_opts)
                )

    return replace(product, axes=new_axes, variants=new_variants)


def apply_option_overrides(
    product: "ProductSpec",
    overrides: Mapping[str, Any] | None,
) -> "ProductSpec":
    """把**团队级**的档位覆盖（改显示名 / 软停用）套到有效规格空间上。

    粒度是**团队**（2026-10-11 用户裁决）：档位 = 公司能做什么，
    不该因买家而异。成本价相反 —— 那是"不同买家拿到不同价"，仍在定价数据里。

    ``overrides`` 形如::

        {"coating_code": {"rename": {"zinc_40": "40克锌层"},
                          "disabled": ["pvc_black"]}}

    键可以是变体包的**稳定 code 字段**（``coating_code``）或包名（``coating``）。

    两条硬约束（在代码里落实，不只是注释）：

    1. **只改显示名，不改 code**。code 是查价键的一半
       （``pricing_key_of`` 拼的就是它），一改，历史定价数据与报价单就对不上。
       所以这里只动 ``name``。
    2. **停用是"标记"，不是"移除"**。若把停用档位从 ``options`` 里删掉，
       ``spec_from_partial`` 就解析不了它 —— 已引用该档位的**历史报价单重算会失败**。
       所以保留在 options 里、打上 ``disabled: True``，由
       `visible_options` 在**给界面看的清单**里滤掉。引擎据此仍能解析。
    """
    if not overrides:
        return product

    changed = False
    new_variants = []
    for vg in product.variants:
        ov = None
        for key in (f"{vg.name}_code", vg.name):
            if key in overrides:
                ov = overrides.get(key) or {}
                break
        if not ov:
            new_variants.append(vg)
            continue

        rename = {pricing_key_value(k): str(v)
                  for k, v in (ov.get("rename") or {}).items()}
        disabled = {pricing_key_value(x) for x in (ov.get("disabled") or [])}
        if not rename and not disabled:
            new_variants.append(vg)
            continue

        options = []
        for opt in vg.options:
            merged = dict(opt)
            for ident in (opt.get("code"), opt.get("name")):
                canonical = pricing_key_value(ident)
                if canonical in disabled:
                    merged["disabled"] = True
                if canonical in rename:
                    merged["name"] = rename[canonical]
            options.append(merged)
        new_variants.append(
            VariantGroup(vg.name, tuple(options), vg.label, vg.label_en))
        changed = True

    if not changed:
        return product
    return replace(product, variants=new_variants)


def visible_options(options) -> list:
    """从一组变体选项里滤掉**软停用**的 —— 只给界面用。

    单独抽出来，是为了让"停用只影响展示、不影响解析"这条约束有唯一落点，
    免得有人在引擎路径上也顺手过滤一遍，把历史报价单弄坏。
    """
    return [o for o in options if not o.get("disabled")]


def _coerce_axis_value(axis: "Axis", raw: Any) -> Any:
    """把客户填的新取值转成与轴上已有取值**同类型**的值。

    丝径轴上是数字（2.0 / 2.5）；如果新档位以字符串 "3.0" 混进去，
    重量公式 ``de**2`` 会直接抛 TypeError —— 报错还算好的，
    更坏的情况是某处做了隐式转换、悄悄算出另一个重量。所以这里必须转。
    """
    sample = next((o for o in axis.options if isinstance(o, (int, float)) and not isinstance(o, bool)), None)
    if sample is None:
        return raw
    try:
        return float(raw)
    except (TypeError, ValueError):
        raise ValueError(
            f"{axis.label or axis.name} 的新档位必须是数字（收到 {raw!r}）；"
            f"该规格轴现有取值：{', '.join(str(o) for o in axis.options)}"
        )
