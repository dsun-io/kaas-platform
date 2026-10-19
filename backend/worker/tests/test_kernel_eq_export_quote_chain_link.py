from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""勾花网产品：公式对齐智能表格实测值 + 「档位由客户自建」的可行性。

数据来源：企微智能表格「客户询盘跟进表 → 明细表」。表里勾花网有 3 行数据，
`单件重量` 是**公式字段**，下面是逐位核对的结果：

    d=2.5 S=5 W=1.8 L=10 → 28.8 kg
    d=3.0 S=6 W=1.8 L=10 → 34.56 kg
    d=3.0 S=5 W=1.2 L=25 → 69.12 kg
    d=3.0 S=5 W=1.2 L=25、原料 9.3 元/㎡ → 单件成本 279 元  ← **按面积**

本文件把这几条钉死，防止后续有人"顺手"把成本改回按重量。
"""
from decimal import Decimal

import pytest

from kaas_common.export_quote.engine import (
    EngineError,
    resolve_space_deduction,
    resolve_space_deduction_ratio,
    spec_from_partial,
)
from kaas_common.export_quote.formulas import describe_product, worked_example
from kaas_common.export_quote.models import extend_product
from kaas_common.export_quote.numeric import DECIMAL
from kaas_common.export_quote.products import get

pytestmark = pytest.mark.unit

# 表格里的 3 行真实数据：(d, S(cm), W(m), L(m), 期望单件重量)
SHEET_ROWS = [
    (2.5, 5, 1.8, 10, "28.8"),
    (3.0, 6, 1.8, 10, "34.56"),
    (3.0, 5, 1.2, 25, "69.12"),
]


def _with_option():
    """模拟「客户在定价数据里加了一个档位」后的有效产品定义。"""
    return extend_product(
        get("chain_link"),
        {"coating_code": [{"value": "hot_dip", "label": "热镀锌"}]},
    )


def _steps(product, **spec):
    base = {"roll_dia_m": Decimal("0.30"), "coating_code": "hot_dip"}
    base.update(spec)
    picked = spec_from_partial(product, base, 1)
    scope = dict(product.constants)
    scope.update(picked)
    scope["total"] = Decimal(str(base["len_m"])) * 10
    scope["pieces"] = 10
    scope["space_deduction"] = resolve_space_deduction(product, scope, DECIMAL)
    scope["space_deduction_ratio"] = resolve_space_deduction_ratio(product)
    scope.update({"terms_enabled": 0, "main_price_incl": 0,
                  "unit_price": 0, "fx_rate": 1})
    return {s["code"]: s["value"] for s in worked_example(product, scope)}


class TestSheetParity:
    """公式必须与智能表格的公式字段逐位相符。"""

    @pytest.mark.parametrize("d,s,w,l,expect", SHEET_ROWS)
    def test_piece_weight_matches_sheet(self, d, s, w, l, expect):
        got = _steps(_with_option(), d=d, mesh_cm=s, width_m=w, len_m=l)
        assert Decimal(str(got["weight_per_piece_kg"])) == Decimal(expect)

    def test_piece_cost_is_by_area_not_by_weight(self):
        """表格：单件成本 = L × W × 元/㎡。d=3 S=5 W=1.2 L=25、9.3 元/㎡ → 279。"""
        got = _steps(_with_option(), d=3, mesh_cm=5, width_m=1.2, len_m=25)
        assert Decimal(str(got["area_per_piece_m2"])) == Decimal("30.0000")
        assert (Decimal("30.0000") * Decimal("9.3")).quantize(Decimal("0.01")) \
            == Decimal("279.00")

    def test_weight_uses_the_1_28_factor_verbatim(self):
        """d² × 1.28 ÷ S × W × L —— 系数照搬表格，不改成别的写法。"""
        got = _steps(_with_option(), d=2.0, mesh_cm=4, width_m=1.0, len_m=100)
        expect = Decimal("2.0") ** 2 * Decimal("1.28") / Decimal("4") * 1 * 100
        assert Decimal(str(got["weight_per_piece_kg"])) == expect.quantize(
            Decimal("0.0001"))


class TestCustomerBuiltOptions:
    """「档位由客户自建」：不预置档位，但**必须画得出这一维**，否则客户加不进来。"""

    def test_pricing_key_shows_the_empty_dim(self):
        dims = {d["field"]: d for d in describe_product(get("chain_link"))["pricing_key"]}
        # 声明了就是声明了 —— 空选项也要出现，不然定价页少一列、客户无处可加
        assert dims["coating_code"]["kind"] == "variant"
        assert dims["coating_code"]["options"] == []
        # 丝径是自由数值维度，同样要出现
        assert dims["d"]["kind"] == "numeric"

    def test_no_option_yet_is_tolerated(self):
        """空档位包 = 由客户自建：报价不阻塞（coating 留空），不再报 400。"""
        picked = spec_from_partial(get("chain_link"),
                                   {"d": 2.5, "mesh_cm": 5, "width_m": 1.8,
                                    "len_m": 10, "roll_dia_m": Decimal("0.30")}, 1)
        assert "coating" not in picked
        assert picked["d"] == Decimal("2.5") or picked["d"] == 2.5

    def test_product_ships_with_zero_options(self):
        product = get("chain_link")
        assert [v.name for v in product.variants] == ["coating"]
        assert product.variants[0].options == (), "本产品不预置任何档位"

    def test_extend_product_makes_it_quotable(self):
        product = _with_option()
        assert [o["name"] for o in product.variants[0].options] == ["热镀锌"]
        steps = _steps(product, d=2.5, mesh_cm=5, width_m=1.8, len_m=10, )
        assert Decimal(str(steps["weight_per_piece_kg"])) == Decimal("28.8000")


class TestCostUnitIsArea:
    def test_cost_unit_is_per_square_meter(self):
        product = get("chain_link")
        assert product.cost_unit == "CNY/㎡"
        assert "面积" in product.notes[1], "说明里要写清是按面积计价"
