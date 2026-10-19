from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""自由数值规格参数（NumericInput）：丝径这类连续量不做枚举。

业务口径（2026-10-11 用户裁决）：
「丝径应该是灵活值、自由配置，然后根据计算公式计算重量和报价；
其他涉及到丝径的产品也是一样，除了丝径其他的数值属性也是一样。」

所以连续量（丝径/网高/间距/卷长/卷径）由客户直接填任意值，
重量与价格交给 derived 公式折算；**只做上下界防误填，不做枚举**。
本测试把这条能力钉死，防止后人"顺手"改回枚举。
"""
import pytest

from kaas_common.export_quote.engine import EngineError, expand_specs, spec_from_partial
from kaas_common.export_quote.models import (
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


# ── 对外说明书与定价键：自由数值也必须能被界面读到 ────────────────────────

def test_describe_product_exposes_numeric_inputs():
    """界面靠这份清单渲染输入框（而不是下拉）—— 没有它就等于"填不进去"。"""
    from kaas_common.export_quote.formulas import describe_product

    d = describe_product(_spec())
    assert [n["key"] for n in d["numeric_inputs"]] == ["d", "h"]
    assert d["numeric_inputs"][0]["unit"] == "mm"
    assert d["numeric_inputs"][0]["default"] == "2.0"
    assert d["numeric_inputs"][0]["min_value"] == "0.5"


def _priced_spec() -> ProductSpec:
    return ProductSpec(
        key="demo2",
        name="带定价键的演示",
        variants=[VariantGroup(
            "coating",
            ({"code": "z40", "name": "热镀锌40"}, {"code": "z200", "name": "热镀锌200"}),
            "表面处理", "Surface")],
        numeric_inputs=[NumericInput("d", "丝径(mm)", unit="mm", default=2.0)],
        pricing_key=[{"field": "d", "label": "丝径"},
                     {"field": "coating_code", "label": "表面处理"}],
    )


def test_pricing_key_numeric_dim_is_declared_not_dropped():
    """自由数值的定价键维度**不能整维跳过**。

    跳了界面就少一列，而引擎查价键仍带着这一维 ——
    又变成"存进去了但查不到"（这正是本项目踩过的坑）。
    """
    from kaas_common.export_quote.formulas import describe_product

    dims = {x["field"]: x for x in describe_product(_priced_spec())["pricing_key"]}
    assert dims["d"]["kind"] == "numeric"
    assert dims["d"]["options"] == []
    assert [o["value"] for o in dims["coating_code"]["options"]] == ["z40", "z200"]


def test_pricing_key_carries_the_free_value_verbatim():
    """查价键用**实际填入的值**（不枚举），三处拼键必须一致。"""
    from kaas_common.export_quote.models import pricing_key_of

    spec = _priced_spec()
    assert pricing_key_of(spec, {"d": 2.3, "coating_code": "z40"}) == "d=2.3|coating_code=z40"
    assert pricing_key_of(spec, {"d": 2, "coating_code": "z200"}) == "d=2|coating_code=z200"


# ── 导表：自由数值列必须能被"导出 → 改 → 再导入"闭环认出来 ──────────────────

def test_template_has_numeric_columns():
    """模板里必须有自由数值列，否则该尺寸无从填写（它不属于规格轴）。"""
    from kaas_common.export_quote.importers import template_headers

    headers = template_headers(_spec())
    assert "丝径(mm)" in headers
    assert "网高(m)" in headers


def test_import_parses_free_numeric_values_without_enumeration():
    """2.3 这种"枚举里没有"的值必须能导入 —— 自由数值不做可选值校验。"""
    from decimal import Decimal as D

    from kaas_common.export_quote.importers import parse_table

    csv_text = "表面处理,丝径(mm),网高(m)\n热镀锌40,2.3,1.5\n"
    t = parse_table(csv_text.encode("utf-8"), _spec(), "a.csv")
    assert t.mapping["丝径(mm)"] == "d"
    assert len(t.rows) == 1
    assert D(str(t.rows[0]["d"])) == D("2.3")
    assert D(str(t.rows[0]["h"])) == D("1.5")


def test_numeric_column_with_ui_unit_converts_to_engine_unit():
    """表头写界面单位（公分）→ 值要除以 ui_scale 变成引擎单位（米）。"""
    from decimal import Decimal as D

    from kaas_common.export_quote.importers import parse_table

    spec = ProductSpec(
        key="unit_demo", name="单位演示",
        numeric_inputs=[NumericInput(
            "roll_dia_m", "卷径", label_en="Roll Diameter",
            unit="m", ui_unit="公分", ui_scale=100, default=0.30)],
    )
    t = parse_table("卷径\n30\n".encode("utf-8"), spec, "a.csv")
    assert t.mapping["卷径"] == "roll_dia_m"
    assert D(str(t.rows[0]["roll_dia_m"])) == D("0.30")
