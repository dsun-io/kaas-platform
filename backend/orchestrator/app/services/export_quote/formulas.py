"""把产品的计算逻辑渲染成业务可读的形式。

为什么需要单独一层
------------------
公式留在代码里，业务看不到「波弯款到底怎么加的」「实际占用体积扣了多少」，
每次都要找开发问；报价单出了偏差也无法自证。所以把产品的计算逻辑
**从产品定义里提取成结构化输出**，供报价工位直接展示与核对。

输出分三块：
  · 规格轴 / 变体    —— 输入是什么，怎么排列组合
  · 派生量与指标     —— 中间量与结果量，含公式、单位、落定小数位、业务口径
  · 关系式与参数     —— 必须成立的关系，以及可调的业务参数

每条都带 note（口径说明），这才是「把计算逻辑讲清楚」的关键。
"""
from __future__ import annotations

from typing import Any

from .models import FormulaSpec, ProductSpec
from .numeric import DECIMAL


def _formula_row(f: FormulaSpec, stage: str) -> dict:
    return {
        "code": f.name,
        "stage": stage,  # derived | piece | order
        "label": f.label or f.name,
        "label_en": f.label_en,
        "unit": f.unit,
        "expr": f.expr,
        "decimals": f.decimals,
        "integer": f.integer,
        "note": f.note,
    }


def _axis_row(ax) -> dict:
    return {
        "name": ax.name,
        "label": ax.label or ax.name,
        "label_en": ax.label_en,
        "kind": "axis",
        "options": [{"value": o} for o in ax.options],
    }


def _variant_row(vg) -> dict:
    """关联属性包：一选全变，把每个选项带出的属性一并列出。"""
    options = []
    for opt in vg.options:
        attrs = {k: v for k, v in opt.items() if k not in ("name", "name_en")}
        options.append(
            {"value": opt.get("name", ""), "label_en": opt.get("name_en", ""),
             "attributes": attrs}
        )
    return {
        "name": vg.name,
        "label": vg.label or vg.name,
        "label_en": vg.label_en,
        "kind": "variant",
        "options": options,
    }


def describe_space(product: ProductSpec) -> dict:
    """规格空间：哪些量在变，变出多少个组合。"""
    axes = [_axis_row(a) for a in product.axes]
    variants = [_variant_row(v) for v in product.variants]
    return {
        "axes": axes,
        "variants": variants,
        "combo_count": product.combo_count,
        "summary": product.summary(),
        "formula": " × ".join(
            [f"{a['label']}({len(a['options'])})" for a in axes]
            + [f"{v['label']}({len(v['options'])})" for v in variants]
        ) or "（无规格轴）",
    }


def describe_calculations(product: ProductSpec) -> dict:
    """全部计算逻辑，按求值顺序分组。"""
    return {
        "derived": [_formula_row(f, "derived") for f in product.derived],
        "piece": [_formula_row(f, "piece") for f in product.piece_metrics],
        "order": [_formula_row(f, "order") for f in product.order_metrics],
    }


def describe_deduction(product: ProductSpec) -> dict:
    """体积扣减口径。"""
    sd = product.space_deduction
    return {
        "mode": sd.mode,
        "value": sd.value,
        "range": list(sd.range) if sd.range else None,
        "expr": sd.expr,
        "note": sd.note,
    }


def describe_invariants(product: ProductSpec) -> list[dict]:
    return [
        {"label": inv.name, "expr": inv.expr, "severity": inv.severity}
        for inv in product.invariants
    ]


def describe_params(product: ProductSpec) -> list[dict]:
    """业务参数：业务可调的那些数。"""
    out = []
    for row in product.params:
        # 约定 [[参数, 取值, 单位, 说明], ...]
        if isinstance(row, (list, tuple)):
            item = {"name": row[0], "value": row[1]}
            if len(row) > 2:
                item["unit"] = row[2]
            if len(row) > 3:
                item["note"] = row[3]
        else:
            item = dict(row)
        out.append(item)
    return out


def describe_product(product: ProductSpec, with_columns: bool = False) -> dict:
    """一份产品的完整计算说明书。"""
    payload = {
        "product_key": product.key,
        "name": product.name,
        "name_en": product.name_en,
        "category_code": product.category_code,
        "hs_codes": list(product.hs_codes),
        "cost": {
            "field": product.cost_field,
            "basis": product.cost_basis,
            "unit": product.cost_unit,
            "note": (
                "税前成本：给的是「已含加工利润的含税价」时要用 incl_tax，"
                "引擎会按进项票税点还原为税前成本；给的是税前价则用 pretax。"
            ),
        },
        "space": describe_space(product),
        "calculations": describe_calculations(product),
        "space_deduction": describe_deduction(product),
        "invariants": describe_invariants(product),
        "params": describe_params(product),
        "notes": list(product.notes),
        "constants": {
            k: v for k, v in product.constants.items()
        },
    }
    if with_columns:
        payload["columns"] = [
            {"key": c.key, "label": c.label, "label_en": c.label_en,
             "decimals": c.decimals, "internal": c.internal}
            for c in product.columns
        ]
    return payload


# 依赖价链（而非仅数量口径）才能算出的指标。
# 逐步代入接口默认不算这些 —— 价格要跑完整价链并查税务档案，
# 在这里给 0 会让人误以为价格就是 0。
PRICE_METRICS = frozenset({
    "price_per_piece",
    "price_per_meter",
    "price_per_piece_fx",
    "total_price",
    "total_price_fx",
})


def worked_example(product: ProductSpec, scope: dict, only=None) -> list[dict]:
    """给一组具体规格取值，按公式逐个代入，产出可核对的计算过程。

    scope 需已包含该产品的常量与规格取值（可直接用引擎的行作用域）。
    公式按声明顺序求值，后一条能用上前一条的结果。

    **only 只影响返回哪些步骤，不影响求值** —— 否则被过滤掉的中间量
    会让依赖它的下游公式取不到值而算出空结果。
    """
    from .expr import evaluate as eval_expr

    local = dict(scope)
    order_list = (
        [(f, "derived") for f in product.derived]
        + [(f, "piece") for f in product.piece_metrics]
        + [(f, "order") for f in product.order_metrics]
    )
    computed: list[dict] = []
    for f, stage in order_list:
        try:
            value = eval_expr(f.expr, local)
        except Exception as exc:  # noqa: BLE001 - 示例不成立时如实回报
            computed.append({
                "code": f.name, "label": f.label or f.name, "stage": stage,
                "expr": f.expr, "unit": f.unit, "decimals": f.decimals,
                "note": f.note, "value": None, "error": str(exc),
            })
            continue
        if f.decimals is not None:
            value = DECIMAL.quantize(value, f.decimals)
        elif f.integer:
            value = DECIMAL.quantize(value, 0)
        local[f.name] = value
        computed.append({
            "code": f.name,
            "label": f.label or f.name,
            "stage": stage,
            "expr": f.expr,
            "unit": f.unit,
            "decimals": f.decimals,
            "note": f.note,
            "value": str(value),
        })
    if only is None:
        return computed
    wanted = set(only)
    return [s for s in computed if s["code"] in wanted]
