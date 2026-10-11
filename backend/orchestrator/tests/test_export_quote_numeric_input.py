"""自由数值规格参数（NumericInput）：丝径这类连续量不做枚举。

业务口径（2026-10-11 用户裁决）：
「丝径应该是灵活值、自由配置，然后根据计算公式计算重量和报价；
其他涉及到丝径的产品也是一样，除了丝径其他的数值属性也是一样。」

所以连续量（丝径/网高/间距/卷长/卷径）由客户直接填任意值，
重量与价格交给 derived 公式折算；**只做上下界防误填，不做枚举**。
本测试把这条能力钉死，防止后人"顺手"改回枚举。
"""
import pytest

from app.services.export_quote.engine import EngineError, expand_specs, spec_from_partial
from app.services.export_quote.models import (
    FormulaSpec,
    NumericInput,
    ProductSpec,
    VariantGroup,
)

pytestmark = pytest.mark.unit


def _spec() -> ProductSpec:
    return ProductSpec(
        key="demo",
        name="演示产品",
        constants={"k": 2},
        # 可枚举的（有稳定 code、要挂定价数据）仍然是枚举
        variants=[
            VariantGroup(
                "coating",
                (
                    {"code": "z40", "name": "热镀锌40", "raw_price": 4.4},
                    {"code": "z200", "name": "热镀锌200", "raw_price": 5.6},
                ),
                "表面处理",
                "Surface Treatment",
            ),
        ],
        # 连续量：自由数值
        numeric_inputs=[
            NumericInput("d", "丝径(mm)", unit="mm", default=2.0,
                         min_value=0.5, max_value=8),
            NumericInput("h", "网高(m)", unit="m", default=1.2,
                         min_value=0.3, max_value=3),
        ],
        derived=[
            FormulaSpec("weight", "0.00617 * d**2 * h * 1000", 4, False,
                        "重量(kg)", "Weight (kg)", "kg", "演示公式"),
        ],
    )


def test_free_numeric_value_is_accepted_as_is():
    """枚举里没有的取值（2.3）必须直接算得出来 —— 这正是"自由配置"的意义。"""
    row = spec_from_partial(_spec(), {"coating": "热镀锌40", "d": 2.3, "h": 1.5}, 1)
    assert float(row["d"]) == 2.3
    assert float(row["h"]) == 1.5
    assert row["coating_code"] == "z40"


def test_numeric_default_used_when_not_given():
    row = spec_from_partial(_spec(), {"coating": "热镀锌40"}, 1)
    assert float(row["d"]) == 2.0
    assert float(row["h"]) == 1.2


def test_numeric_out_of_range_is_rejected():
    with pytest.raises(EngineError, match="上界"):
        spec_from_partial(_spec(), {"coating": "热镀锌40", "d": 99}, 1)
    with pytest.raises(EngineError, match="下界"):
        spec_from_partial(_spec(), {"coating": "热镀锌40", "d": 0.1}, 1)


def test_numeric_non_number_is_rejected():
    with pytest.raises(EngineError, match="不是数值"):
        spec_from_partial(_spec(), {"coating": "热镀锌40", "d": "很粗"}, 1)


def test_expand_specs_injects_defaults_and_does_not_inflate_combo_count():
    """展开全量时数值参数取默认值；组合数只数**可枚举**的那些。"""
    spec = _spec()
    rows = expand_specs(spec)
    assert len(rows) == 2                                  # 只有 coating 一个枚举行
    assert all(float(r["d"]) == 2.0 for r in rows)
    assert spec.combo_count == 2                           # 数值参数不进笛卡尔积


def test_numeric_input_must_have_default_to_expand():
    bad = ProductSpec(key="bad", numeric_inputs=[NumericInput("d", "丝径")])
    with pytest.raises(EngineError, match="没有默认值"):
        expand_specs(bad)


def test_numeric_input_must_not_collide_with_constants():
    bad = ProductSpec(key="bad", constants={"d": 1},
                      numeric_inputs=[NumericInput("d", "丝径", default=1)])
    with pytest.raises(EngineError, match="重名"):
        expand_specs(bad)
