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

from .models import FormulaSpec, ProductSpec, pricing_key_value
from .models import visible_options
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
        # value = 参与计算的原始取值（保持数字类型）；
        # label = 给人看的写法。两者**不能合并**：数值过一遍 JSON 会把
        # 2.0 变成 2，而业务要看到的是 2.0；位数的权威写法就是产品定义里
        # 怎么写的（这里写 2.0）→ str(2.0) = "2.0"。
        "options": [{"value": o, "label": str(o)} for o in ax.options],
    }


def _variant_row(vg) -> dict:
    """关联属性包：一选全变，把每个选项带出的属性一并列出。"""
    options = []
    # **软停用**的档位在这里滤掉：这一份是**给界面看的清单**。
    # 引擎路径（`spec_from_partial`）读的是 `product.variants` 原始 options，
    # 必须仍能解析停用档位 —— 否则已引用它的历史报价单重算会失败。
    for opt in visible_options(vg.options):
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


def describe_piece_inputs(product: ProductSpec) -> list[dict]:
    """数量区可按件改写的规格参数声明。

    只给**映射关系**（属性名 + 所属变体组），默认值由界面从「当前选中项」的
    属性里取，改完回写成 variant_overrides —— 属性名与取值始终留在产品数据里，
    界面不写死任何产品知识。

    单位信息一并给界面：`unit` 是引擎内部单位，`ui_unit` / `ui_scale` 是界面呈现与
    输入用的（界面值 = 引擎值 × ui_scale）。界面只负责换算，不拥有业务单位知识。
    """
    return [
        {
            "key": pi.key,
            "label": pi.label or pi.key,
            "label_en": pi.label_en,
            "unit": pi.unit,
            "ui_unit": pi.ui_unit or pi.unit,
            "ui_scale": pi.ui_scale,
            "variant": pi.variant,
            "note": pi.note,
            "unit_quantity": pi.unit_quantity,
        }
        for pi in product.piece_inputs
    ]


def describe_pricing_key(product: ProductSpec) -> list[dict]:
    """定价键的维度声明 + 每一维的取值清单（给界面画「定价数据」矩阵用）。

    维度与取值全部来自产品定义，界面不写死任何产品知识 —— 换个产品、改个档位，
    定价页自动跟着变。

    每一维形如::

        {"field": "de", "label": "边丝径", "unit": "mm",
         "options": [{"value": 2.0, "label": "2.0"}, ...]}

    `value` 是拼查价键用的稳定值，`label` 是给人看的名字。
    取值为空的维度会被跳过（界面上就少一列，而不是画出一列空列）。
    """
    axis_map = {ax.name: ax for ax in product.axes}
    numeric_map = {ni.key: ni for ni in product.numeric_inputs}
    dims: list[dict] = []
    for dim in (product.pricing_key or []):
        field = dim.get("field")
        if not field:
            continue
        options: list[dict] = []
        # 这一维在**产品定义**里是什么：轴 / 变体包 / 自由数值。
        # 界面靠它决定渲染下拉还是输入框；报错了会让界面画出一列空下拉。
        kind = "axis"
        # 「声明了」与「有取值」是两件事：档位可以由客户自建，产品定义只声明不预置。
        declared = (
            field in numeric_map
            or field in axis_map
            or any(field in (vg.name, f"{vg.name}_code") for vg in product.variants)
        )
        if field in numeric_map:
            # 自由数值维度：取值是**连续量**，无法枚举 —— 不能像轴那样列 options，
            # 但也不能整维跳过：跳了界面就少一列，查价键却仍带着这个维度，
            # 于是又变成"存进去了但查不到"。
            # 这里显式声明成 numeric：界面渲染输入框，查价键用实际填入的值。
            ni = numeric_map[field]
            dims.append({
                "field": field,
                "label": dim.get("label") or ni.label or field,
                "unit": dim.get("unit") or ni.unit,
                "kind": "numeric",
                "options": [],
                "ui_unit": ni.ui_unit,
                "ui_scale": ni.ui_scale,
            })
            continue
        if field in axis_map:
            # value 用**规范写法**（2.0 → "2"），label 仍给人看（"2.0"）。
            # 两边必须是同一把钥匙：界面拿 value 回传、引擎拿取值拼键，
            # 写法不一致就会出现「存进去了但查不到」。
            options = [
                {"value": pricing_key_value(v), "label": str(v)}
                for v in axis_map[field].options
            ]
        else:
            kind = "variant"
            for vg in product.variants:
                if field == vg.name:
                    options = [{"value": o.get("name"), "label": o.get("name")}
                               for o in visible_options(vg.options)]
                    break
                if field == f"{vg.name}_code":
                    options = [
                        {"value": o.get("code"), "label": o.get("name") or o.get("code")}
                        for o in visible_options(vg.options)
                    ]
                    break
        # 「声明了但没有取值」≠「不是一维」。
        # 档位可以由客户自建（产品定义里只声明、不预置），这时必须**把这一列画出来**，
        # 否则客户在定价页看不到该列、加不进档位，就永远报不了价。
        # 只有**完全没声明**的维度才跳过（否则会画出一列永远填不上的空列）。
        if not options and not declared:
            continue
        dims.append({
            "field": field,
            "label": dim.get("label") or field,
            "unit": dim.get("unit", ""),
            "kind": kind,
            "options": options,
        })
    return dims


def describe_product(product: ProductSpec, with_columns: bool = False) -> dict:
    """一份产品的完整计算说明书。"""
    payload = {
        "product_key": product.key,
        "name": product.name,
        "name_en": product.name_en,
        "category_code": product.category_code,
        "hs_codes": list(product.hs_codes),
        # 产品级默认利润/杂税（报价页首次打开时带入；本单可覆盖）
        "profit_mode": product.profit_mode,
        "profit_value": product.profit_value,
        "misc_fee_rate": product.misc_fee_rate,
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
        "piece_inputs": describe_piece_inputs(product),
        # 包装方案（需求 20）：[{id,name,method,is_default,created_at,mode,amount,ranges}]
        # 界面据此渲染包装选择/默认标识，并把 packaging_id 随报价请求下发。
        "packaging": list(product.packaging or []),
        # 自由数值规格参数：界面据此渲染输入框（不是下拉）。
        # 尺寸类没有"可选值"，所以既有取值的自由度，也必须有明确的单位口径。
        "numeric_inputs": [
            {
                "key": ni.key,
                "label": ni.label,
                "label_en": ni.label_en,
                "unit": ni.unit,
                "ui_unit": ni.ui_unit,
                "ui_scale": ni.ui_scale,
                "default": None if ni.default is None else str(ni.default),
                "min_value": None if ni.min_value is None else str(ni.min_value),
                "max_value": None if ni.max_value is None else str(ni.max_value),
                "decimals": ni.decimals,
                "note": ni.note,
            }
            for ni in product.numeric_inputs
        ],
        "pricing_key": describe_pricing_key(product),
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
