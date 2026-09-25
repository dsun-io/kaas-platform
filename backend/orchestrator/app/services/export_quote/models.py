"""报价模型的共享数据结构。

这些类型把「产品知识」与「报价计算」解耦：
产品类声明规格轴、变体、公式与列；引擎只负责展开与求值。
"""
from __future__ import annotations

from dataclasses import dataclass, field
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
    再扣减 2~3 m³，取中位数 2.5 m³。扣减的由来是卷与卷之间并非完美
    网格堆叠，边界余量实际堆不到满箱。
    """

    mode: str = "fixed"  # fixed | median | mean | formula
    value: Any = 0
    range: tuple | None = None
    expr: str = ""
    note: str = ""


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
    notes: list = field(default_factory=list)
    hs_codes: list = field(default_factory=list)  # 用于退税率查询

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
