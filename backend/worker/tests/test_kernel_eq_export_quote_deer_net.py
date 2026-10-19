from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""鹿网产品：公式与智能表格的公式字段逐点等价。

**本产品没有真实数据可核对** —— 智能表格「客户询盘跟进表 → 明细表」21 行里
没有鹿网记录（只有牛栏网 / 勾花网 / 刺绳 / Y型立柱 / 骑马钉 / 围栏钳等）。
所以这里用替代办法：把**表格的公式原样抄一份**（`sheet_weight`），
在一组输入上逐点求值，与我们的引擎比对 —— 两条公式必须完全相等。

表格原式（逐字）：
    0.01234 × L × ( De² + Di²(N−2)/2
                    + (W×1000+80)×Dw²/(S×10)/2
                    + (N−2)×140×Dt²/(S×10)/2 )
"""
from decimal import Decimal

import pytest

from kaas_common.export_quote.engine import (
    resolve_space_deduction,
    resolve_space_deduction_ratio,
    spec_from_partial,
)
from kaas_common.export_quote.formulas import describe_product, worked_example
from kaas_common.export_quote.models import extend_product
from kaas_common.export_quote.numeric import DECIMAL
from kaas_common.export_quote.products import get

pytestmark = pytest.mark.unit

# (De, Di, Dw, Dt, N, W, S_cm, L)
CASES = [
    (2.5, 2.5, 2.5, 2.0, 10, 1.5, 15, 100),
    (2.0, 2.0, 2.0, 1.8, 8, 1.2, 10, 50),
    (3.0, 2.5, 2.5, 2.5, 13, 1.88, 30, 100),
    (1.8, 1.8, 1.8, 1.6, 6, 0.9, 12.7, 25),
]


def sheet_weight(de, di, dw, dt, n, w, s_cm, l) -> Decimal:
    """表格里的鹿网重量公式（逐字照抄，不做任何整理）。"""
    D = Decimal
    de, di, dw, dt = D(str(de)), D(str(di)), D(str(dw)), D(str(dt))
    n, w, s_cm, l = D(str(n)), D(str(w)), D(str(s_cm)), D(str(l))
    return D("0.01234") * l * (
        de ** 2
        + di ** 2 * (n - 2) / 2
        + (w * 1000 + 80) * dw ** 2 / (s_cm * 10) / 2
        + (n - 2) * 140 * dt ** 2 / (s_cm * 10) / 2
    )


def _with_option():
    """模拟客户在定价数据里加了一个档位。"""
    return extend_product(
        get("deer_net"),
        {"coating_code": [{"value": "hot_dip", "label": "热镀锌"}]},
    )


def _steps(product, **spec):
    base = {"roll_dia_m": Decimal("0.30"), "coating_code": "hot_dip"}
    base.update(spec)
    picked = spec_from_partial(product, base, 1)
    scope = dict(product.constants)
    scope.update(picked)
    scope["total"] = Decimal(str(base["roll_len_m"])) * 10
    scope["pieces"] = 10
    scope["space_deduction"] = resolve_space_deduction(product, scope, DECIMAL)
    scope["space_deduction_ratio"] = resolve_space_deduction_ratio(product)
    scope.update({"terms_enabled": 0, "main_price_incl": 0,
                  "unit_price": 0, "fx_rate": 1})
    return {s["code"]: s["value"] for s in worked_example(product, scope)}


class TestFormulaEquivalence:
    """没有数据行，就用「表格公式 vs 我们的公式」逐点比对。"""

    @pytest.mark.parametrize("case", CASES)
    def test_matches_sheet_formula_pointwise(self, case):
        de, di, dw, dt, n, w, s_cm, l = case
        steps = _steps(
            _with_option(), de=de, di=di, dw=dw, dt=dt, n=n,
            height_m=w, mesh_mm=Decimal(str(s_cm)) * 10, roll_len_m=l,
        )
        ours = Decimal(str(steps["weight_base_kg"]))          # 未落定，可比全精度
        theirs = sheet_weight(de, di, dw, dt, n, w, s_cm, l)
        assert abs(ours - theirs) / theirs < Decimal("1e-20"), (
            f"与表格公式不等价：ours={ours} theirs={theirs}"
        )

    def test_the_two_experience_constants_are_actually_used(self):
        """80 与 140 是表格里的经验项；去掉任一项都会改变结果。

        这条防的是"整理公式时把经验项弄丢"——
        丢了之后量纲照样对、数字照样出得来，但**值错了**。
        """
        base = dict(de=2.5, di=2.5, dw=2.5, dt=2.0, n=13,
                    height_m=1.88, mesh_mm=Decimal("300"), roll_len_m=100)
        got = Decimal(str(_steps(_with_option(), **base)["weight_base_kg"]))
        # 手工把两个经验项去掉后的值
        de, di, dw, dt = Decimal("2.5"), Decimal("2.5"), Decimal("2.5"), Decimal("2.0")
        n, w_mm, s_mm = Decimal("13"), Decimal("1880"), Decimal("300")
        without = Decimal("0.00617") * 100 * (
            2 * de ** 2 + di ** 2 * (n - 2) + w_mm * dw ** 2 / s_mm
        )
        # 只去掉 140 那一项
        without_twist = Decimal("0.00617") * 100 * (
            2 * de ** 2 + di ** 2 * (n - 2)
            + (w_mm + 80) * dw ** 2 / s_mm
        )
        assert got != without, "丢掉了 140 那项（拧花）"
        assert got != without_twist, "丢掉了 (N−2)×140 的拧花项"
        assert got > without_twist > without


class TestProductShape:
    def test_registered_and_costs_by_weight(self):
        product = get("deer_net")
        assert product.name == "鹿网"
        # 表格的成本公式：除勾花网（按面积）外都按重量
        assert product.cost_unit == "CNY/kg"

    def test_ships_with_zero_options(self):
        product = get("deer_net")
        assert [v.name for v in product.variants] == ["coating"]
        assert product.variants[0].options == (), "本产品不预置任何档位"

    def test_pricing_key_shows_the_empty_dim(self):
        dims = {d["field"]: d for d in describe_product(get("deer_net"))["pricing_key"]}
        assert dims["coating_code"]["options"] == []
        assert dims["de"]["kind"] == "numeric"

    def test_documented_as_unverifiable_against_data(self):
        """文档必须写明"没有真实数据可核对"，否则后人会以为已用数据验过。"""
        joined = " ".join(get("deer_net").notes)
        assert "没有真实数据可核对" in joined
