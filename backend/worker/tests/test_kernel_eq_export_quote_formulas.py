from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""牛栏网计算逻辑测试：波弯款、实际占用体积、净重、边丝重等。

这些用例的作用是**把口径钉死在测试里**：任何一次改动若把
「波弯款按每 100 米 +3kg」「实际占用体积要扣 2.5 m³」这类口径改坏，
会立刻失败，而不是等到报价单发出去才发现。

同时校验「计算逻辑可被业务读到」：每条公式都必须带单位与口径说明，
并能按给定规格逐步代入自证 —— 否则业务永远要回头问开发。
"""
from datetime import date
from decimal import Decimal as D, ROUND_HALF_UP

import pytest

from kaas_common.export_quote import (
    QuoteRequest,
    build,
    describe_calculations,
    describe_product,
    describe_space,
    worked_example,
)
from kaas_common.export_quote.formulas import PRICE_METRICS
from kaas_common.export_quote.models import pricing_key_of, pricing_key_value
from kaas_common.export_quote.products import field_fence

pytestmark = pytest.mark.unit

# 与产品定义 constants['pi'] 保持一致
PI_STR = "3.14159265358979323846"


def spec():
    return field_fence.build_spec()


# 尺寸类现在是**自由数值**（2026-10-11 裁决：没有"丝径方案"这回事）。
# 下面把旧的枚举空间显式写成 spec_rows，让按规格定位的用例读起来仍然直观，
# 同时正好演示新模型的用法：**空间由调用方按行给**，不由产品定义展开。
_INNER = {
    "内丝2.0": {"dm": 2.0, "dv": 2.0, "roll_len_m": 100, "roll_dia_m": 0.30},
    "内丝2.5": {"dm": 2.5, "dv": 2.5, "roll_len_m": 50, "roll_dia_m": 0.25},
}
WIRE_SPLIT = {
    "全丝2.0": {"de": 2.0, **_INNER["内丝2.0"]},
    "全丝2.5": {"de": 2.5, **_INNER["内丝2.5"]},
    "边丝2.5+内丝2.0": {"de": 2.5, **_INNER["内丝2.0"]},
}

_COATINGS = ("热镀锌 40g/㎡", "热镀锌 200g/㎡", "热镀锌 260g/㎡",
             "电镀锌", "PVC涂塑(黑色)")
_WAVES = ("无波款", "波弯款")


def legacy_space() -> list:
    """旧的枚举空间：2 边丝径 × 2 内丝径 × 2 网高 × 2 间距 × 5 表面处理 × 2 工艺。"""
    return [
        {"de": de, "height_m": h, "mesh_mm": mesh, "coating": c, "wave": w,
         **inner}
        for de in (2.0, 2.5)
        for inner in _INNER.values()
        for h in (1.2, 1.5)
        for mesh in (100, 150)
        for c in _COATINGS
        for w in _WAVES
    ]


def _num(v):
    """float → Decimal 归一，便于与 spec 里的数值比较。

    尺寸类是自由数值，`spec` 里存的是 Decimal；而 0.3 / 1.2 这类小数
    在二进制里不精确，`Decimal('0.3') == 0.3` 会得到 False。
    """
    if isinstance(v, bool) or v is None:
        return v
    if isinstance(v, (int, float)):
        return D(str(v))
    return v


def find(res, wire=None, **want):
    """按规格取值定位一行；给 `wire`（旧方案名）会展开成 边丝径 + 内丝径。"""
    if wire is not None:
        want.update(WIRE_SPLIT[wire])
    for r in res.rows:
        if all(_num(r.spec.get(k)) == _num(v) for k, v in want.items()):
            return r
    raise LookupError(want)


def build_res():
    return build(QuoteRequest(
        product_key="field_fence",
        policy=_policy(),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        quote_date=date(2026, 9, 24),
        spec_rows=legacy_space(),
    ))


def _policy():
    from kaas_common.export_quote.pricing import policy_from_dict
    return policy_from_dict({
        "input_vat_rate": D("0.10"),
        "output_vat": {"rate": D("0"), "mode": "additive"},
        "profit": {"mode": "fixed", "value": D("0.1")},
        "refund": {"refund_ratio": D("1"), "give_ratio": D("0.8")},
        # 印花税已并入杂税（misc_fee_rate，对齐平台默认 0.03）
        "misc_fee_rate": D("0.03"),
    })


# ─────────────────────────────────────────────────────────────────────────────
# 波弯款
# ─────────────────────────────────────────────────────────────────────────────
class TestWaveBend:
    """波弯款按每 100 米增重 3kg 折算。"""

    @pytest.mark.parametrize("wire,roll_len,expect", [
        ("全丝2.0", 100, D("3")),            # 100 米卷 → +3kg
        ("边丝2.5+内丝2.0", 100, D("3")),     # 100 米卷 → +3kg
        ("全丝2.5", 50, D("1.5")),           # 50 米卷 → 只 +1.5kg
    ])
    def test_increment_follows_roll_length(self, wire, roll_len, expect):
        res = build_res()
        plain = find(res, wire=wire, height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="无波款")
        waved = find(res, wire=wire, height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="波弯款")
        assert plain.spec["roll_len_m"] == roll_len
        assert D(str(waved.derived["wave_add_kg"])) == expect

    def test_no_wave_adds_nothing(self):
        res = build_res()
        for r in res.rows:
            if r.spec["wave"] == "无波款":
                assert D(str(r.derived["wave_add_kg"])) == 0
                assert (D(str(r.derived["weight_per_piece_kg"]))
                        == D(str(r.derived["weight_base_kg"])).quantize(D("0.0001")))

    def test_net_weight_is_base_plus_wave(self):
        res = build_res()
        for r in res.rows:
            assert (D(str(r.derived["weight_base_kg"]))
                    + D(str(r.derived["wave_add_kg"]))).quantize(D("0.0001")) == \
                D(str(r.derived["weight_per_piece_kg"]))

    def test_wave_only_changes_weight_not_volume(self):
        """波弯不改变卷径，因此不影响体积。"""
        res = build_res()
        plain = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="无波款")
        waved = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="波弯款")
        assert plain.derived["volume_per_piece_m3"] == waved.derived["volume_per_piece_m3"]
        assert plain.derived["roll_dia_cm"] == waved.derived["roll_dia_cm"]

    def test_wave_makes_the_roll_more_expensive(self):
        """同样规格下波弯款单卷更重 → 单卷售价更高，但每米价也更贵。"""
        res = build_res()
        plain = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="无波款")
        waved = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                     coating="热镀锌 40g/㎡", wave="波弯款")
        assert (D(str(waved.piece["price_per_piece"]))
                > D(str(plain.piece["price_per_piece"])))
        assert (D(str(waved.piece["price_per_meter"]))
                > D(str(plain.piece["price_per_meter"])))


# ─────────────────────────────────────────────────────────────────────────────
# 实际占用体积
# ─────────────────────────────────────────────────────────────────────────────
class TestEffectiveVolume:
    """实际占用体积 = 长方体累计总体积 × 装柜系数（= 1 − 扣减比例 4%）。"""

    def test_deduction_is_ratio_not_fixed_amount(self):
        """**按比例**扣减（2026-10-11 用户裁决）。

        固定额（原 2.5 m³/单）不随数量缩放，小单上会扣除超过总体积。
        """
        sd = spec().space_deduction
        assert sd.mode == "ratio"
        assert D(str(sd.value)) == D("0.04")
        assert sd.ratio == sd.value
        assert sd.note, "扣减口径必须写明，业务要看懂为什么扣"

    def test_box_volume_is_box_per_piece_times_count(self):
        """长方体总体积用**单卷长方体体积**累加（不是圆柱体净体积）。"""
        res = build_res()
        for r in res.rows:
            for oname in ("o30000", "o50000"):
                m = r.orders[oname]
                unit = D(str(r.derived["volume_box_per_piece_m3"]))
                assert D(str(m["volume_box_m3"])) == (D(str(m["pieces"])) * unit)

    def test_effective_equals_box_times_stowage_factor(self):
        res = build_res()
        q = D("0.0001")
        for r in res.rows:
            for oname in ("o30000", "o50000"):
                m = r.orders[oname]
                box = D(str(m["volume_box_m3"]))
                eff = D(str(m["volume_effective_m3"]))
                assert eff == (box * (D("1") - D("0.04"))).quantize(q)

    def test_deduction_scales_with_quantity(self):
        """扣减**随数量缩放**（用户口径：「发的数量越少，需要扣减的值越小」）。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        ded = {
            oname: D(str(r.orders[oname]["volume_box_m3"]))
            - D(str(r.orders[oname]["volume_effective_m3"]))
            for oname in ("o30000", "o50000")
        }
        assert ded["o30000"] > 0 and ded["o50000"] > 0
        assert ded["o50000"] > ded["o30000"], "量越大扣得越多（比例，而非固定额）"

    def test_tiny_order_never_gets_negative_volume(self):
        """回归：固定扣减 2.5 m³ 时，< 2314 米（23 卷）的单子实际占用体积为**负数**。

        这个数是要给货代/报关的，负体积是明确的错误。改成比例后不会发生。
        """
        tiny = build(QuoteRequest(
            product_key="field_fence",
            policy=_policy(),
            fx_rate=D("6.7019"),
            orders=field_fence.order_specs((100,)),
                quote_date=date(2026, 9, 24),
            spec_rows=[{"coating": "热镀锌 40g/㎡", "wave": "无波款"}],
        ))
        m = tiny.rows[0].orders["o100"]
        assert D(str(m["pieces"])) == D("1")
        assert D(str(m["volume_effective_m3"])) > 0, "小单不得出现负体积"

    def test_net_volume_is_cylinder(self):
        """单卷净体积按**实际圆柱体**：π/4 × 卷径² × 网高。"""
        res = build_res()
        q = D("0.0001")
        for r in res.rows:
            dia_m = D(str(r.derived["roll_dia_cm"])) / D("100")
            h = D(str(r.spec["height_m"]))
            want = (D(PI_STR) / D("4") * dia_m * dia_m * h).quantize(
                q, rounding=ROUND_HALF_UP)
            assert D(str(r.derived["volume_per_piece_m3"])) == want, r.index

    def test_box_volume_per_piece_is_circumscribed_square_prism(self):
        """单卷长方体体积按**外接方柱**：卷径² × 网高。"""
        res = build_res()
        q = D("0.0001")
        for r in res.rows:
            dia_m = D(str(r.derived["roll_dia_cm"])) / D("100")
            h = D(str(r.spec["height_m"]))
            want = (dia_m * dia_m * h).quantize(q, rounding=ROUND_HALF_UP)
            assert D(str(r.derived["volume_box_per_piece_m3"])) == want, r.index

    def test_cylinder_is_about_78_percent_of_box(self):
        """圆柱体比外接方柱小约 π/4 ≈ 78.54%，两者不能混用。

        两者都先落定到 4 位小数，故比值有微小量化误差，用容差判断。
        """
        res = build_res()
        for r in res.rows:
            cyl = D(str(r.derived["volume_per_piece_m3"]))
            box = D(str(r.derived["volume_box_per_piece_m3"]))
            ratio = cyl / box
            assert abs(ratio - D(PI_STR) / D("4")) < D("0.001"), (r.index, ratio)

    def test_customer_volume_numbers_unchanged_by_cylinder_switch(self):
        """对外报的体积仍是长方体口径，故客户看到的数字不受圆柱体改动影响。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(r.derived["volume_box_per_piece_m3"])) == D("0.1080")
        assert D(str(r.orders["o30000"]["volume_box_m3"])) == D("32.4000")
        # 32.4 × (1 − 0.04) = 31.1040（按比例扣，不再是 −2.5）
        assert D(str(r.orders["o30000"]["volume_effective_m3"])) == D("31.1040")
        # 54.0 × (1 − 0.04) = 51.8400
        assert D(str(r.orders["o50000"]["volume_effective_m3"])) == D("51.8400")

    def test_roll_diameter_default_and_override(self):
        """卷径有默认值（随丝径方案联动）且可覆盖。"""
        res = build_res()
        long_roll = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                         coating="热镀锌 40g/㎡", wave="无波款")
        short_roll = find(res, wire="全丝2.5", height_m=1.2, mesh_mm=100,
                          coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(long_roll.derived["roll_dia_cm"])) == D("30.0")
        assert D(str(short_roll.derived["roll_dia_cm"])) == D("25.0")

        from kaas_common.export_quote import QuoteRequest as QR
        over = build(QR(
            product_key="field_fence",
            policy=_policy(),
            fx_rate=D("6.7019"),
            orders=field_fence.order_specs((30000,)),
                quote_date=date(2026, 9, 24),
            spec_rows=[{"coating": "热镀锌 40g/㎡", "wave": "无波款",
                        "dm": 2.0, "dv": 2.0, "roll_len_m": 100,
                        "roll_dia_m": D("0.32")}],
        ))
        r2 = over.rows[0]
        assert D(str(r2.derived["roll_dia_cm"])) == D("32.00")
        # 体积随之重算
        assert D(str(r2.derived["volume_box_per_piece_m3"])) == D("0.1229")
        assert D(str(r2.derived["volume_per_piece_m3"])) == D("0.0965")

    def test_50m_roll_diameter_is_25cm(self):
        res = build_res()
        r = find(res, wire="全丝2.5", height_m=1.5, mesh_mm=150,
                 coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(r.derived["roll_dia_cm"])) == 25
        assert r.spec["roll_len_m"] == 50

    def test_effective_volume_is_less_than_box(self):
        res = build_res()
        for r in res.rows:
            for oname in ("o30000", "o50000"):
                m = r.orders[oname]
                assert D(str(m["volume_effective_m3"])) < D(str(m["volume_box_m3"]))


# ─────────────────────────────────────────────────────────────────────────────
# 其它派生量
# ─────────────────────────────────────────────────────────────────────────────
class TestOtherDerivedMetrics:
    def test_edge_weight_formula(self):
        res = build_res()
        q = D("0.0001")
        for r in res.rows:
            L = D(str(r.spec["roll_len_m"]))
            de = D(str(r.spec["de"]))
            # 引擎声明的是 ROUND_HALF_UP，测试必须用同一口径，否则 3.85625 会差一分
            want = (D("0.01234") * L * de * de).quantize(q, rounding=ROUND_HALF_UP)
            assert D(str(r.derived["edge_weight_kg"])) == want, (r.index, want)

    def test_edge_weight_hand_value(self):
        """0.01234 × 50 × 2.5² = 3.85625 → 3.8563（半进位）。"""
        res = build_res()
        r = find(res, wire="全丝2.5", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(r.derived["edge_weight_kg"])) == D("3.8563")

    def test_base_weight_formula_reproduces_hand_value(self):
        """1.2m / 10cm / 全丝2.0 / 100m 无波 → 65.402 kg（手工核对值）。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(r.derived["weight_per_piece_kg"])) == D("65.4020")

    def test_roll_count_depends_on_wire_option(self):
        res = build_res()
        for r in res.rows:
            for oname, total in (("o30000", D("30000")), ("o50000", D("50000"))):
                want = total / D(str(r.spec["roll_len_m"]))
                assert D(str(r.orders[oname]["pieces"])) == want

    def test_fx_price_derived_from_displayed_cny_price(self):
        """外币价用已展示的人民币单卷价折算，保证客户复算一致。"""
        res = build_res()
        for r in res.rows:
            want = (D(str(r.piece["price_per_piece"])) / D("6.7019")).quantize(D("0.0001"))
            assert D(str(r.piece["price_per_piece_fx"])) == want


# ─────────────────────────────────────────────────────────────────────────────
# 计算逻辑可读性
# ─────────────────────────────────────────────────────────────────────────────
class TestCalculationIsExplainable:
    def test_every_metric_has_unit_and_note(self):
        """每条公式都必须带单位与口径说明 —— 否则业务看不懂。"""
        calc = describe_calculations(spec())
        missing = []
        for stage in ("derived", "piece", "order"):
            for f in calc[stage]:
                if not f["unit"]:
                    missing.append((f["code"], "unit"))
                if not f["note"]:
                    missing.append((f["code"], "note"))
                if not f["label"] or f["label"] == f["code"]:
                    missing.append((f["code"], "label"))
        assert not missing, f"缺少单位/口径/中文名: {missing}"

    def test_space_description_matches_product_combos(self):
        space = describe_space(spec())
        # 尺寸类改成自由数值后，产品定义的**枚举**空间只剩 表面处理 6 × 工艺 2
        assert space["combo_count"] == 12
        assert "48" not in space["formula"]  # formula 只描述轴，不含结论数字
        assert space["summary"]

    def test_product_description_contains_deduction_and_invariants(self):
        d = describe_product(spec())
        assert d["space_deduction"]["note"]
        assert d["space_deduction"]["mode"] == "ratio"
        assert D(str(d["space_deduction"]["value"])) == D("0.04")
        assert len(d["invariants"]) >= 18
        assert d["params"]

    def test_worked_example_reproduces_verified_numbers(self):
        """逐步代入必须复现手工核对值，否则「自证」没意义。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="波弯款")
        scope: dict = {}
        scope.update(spec().constants)
        scope.update(r.spec)
        scope.update(r.derived)
        scope.update(r.price)
        for k, v in r.price.items():
            scope["price_" + k] = v
        scope.update(r.piece)
        scope["total"] = 30000
        scope["space_deduction"] = D("0")
        scope["space_deduction_ratio"] = D("0.04")
        scope["terms_enabled"] = 0
        scope["main_price_incl"] = r.piece["price_per_piece"]
        scope["unit_price"] = r.price["quote_final"]

        got = {s["code"]: s["value"] for s in worked_example(spec(), scope)}
        assert D(got["wave_add_kg"]) == D("3")
        assert D(got["weight_per_piece_kg"]) == D("68.4020")
        # 圆柱体净体积与长方体体积是两个口径
        assert D(got["volume_per_piece_m3"]) == D("0.0848")
        assert D(got["volume_box_per_piece_m3"]) == D("0.1080")
        assert D(got["volume_box_m3"]) == D("32.4000")
        assert D(got["volume_effective_m3"]) == D("31.1040")
        assert D(got["pieces"]) == D("300")
        # 波弯款单卷 324.74 元 → 300 卷 97422.00 元（基准表第 2 行；
        # 2026-10-19 口径变更：印花税并入杂税 3%，旧值 314.84 / 94452.00）
        assert D(got["price_per_piece"]) == D("324.74")
        assert D(got["total_price"]) == D("97422.00")

    def test_worked_example_reproduces_plain_row_total(self):
        """无波款单卷 310.50 元 → 300 卷 93150.00 元（基准表第 1 行；
        2026-10-19 口径变更：印花税并入杂税 3%，旧值 301.03 / 90309.00）。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        scope: dict = {}
        scope.update(spec().constants)
        scope.update(r.spec)
        scope.update(r.derived)
        scope.update(r.price)
        for k, v in r.price.items():
            scope["price_" + k] = v
        scope.update(r.piece)
        scope["total"] = 30000
        scope["space_deduction"] = D("0")
        scope["space_deduction_ratio"] = D("0.04")
        scope["terms_enabled"] = 0
        scope["main_price_incl"] = r.piece["price_per_piece"]
        scope["unit_price"] = r.price["quote_final"]
        got = {s["code"]: s["value"] for s in worked_example(spec(), scope)}
        assert D(got["wave_add_kg"]) == 0
        assert D(got["weight_per_piece_kg"]) == D("65.4020")
        assert D(got["volume_per_piece_m3"]) == D("0.0848")
        assert D(got["volume_box_per_piece_m3"]) == D("0.1080")
        assert D(got["price_per_piece"]) == D("310.50")
        assert D(got["total_price"]) == D("93150.00")

    def test_filtered_example_still_resolves_dependencies(self):
        """只返回关心的量，但依赖项仍要被求值 —— 否则下游算出空结果。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        scope: dict = {}
        scope.update(spec().constants)
        scope.update(r.spec)
        scope.update(r.derived)
        scope["total"] = 30000
        scope["space_deduction"] = D("0")
        scope["space_deduction_ratio"] = D("0.04")
        scope["pieces"] = D("300")
        only = ["wave_add_kg", "volume_box_m3", "volume_effective_m3"]
        steps = worked_example(spec(), scope, only)
        assert [s["code"] for s in steps] == only
        vals = {s["code"]: s["value"] for s in steps}
        assert vals["volume_box_m3"] is not None, "依赖项被跳过导致空结果"
        assert D(vals["volume_effective_m3"]) == D("31.1040")

    def test_price_metrics_are_flagged_separately(self):
        """价格类量要能与数量口径区分开，便于调用方决定是否计算。"""
        assert "total_price" in PRICE_METRICS
        assert "volume_effective_m3" not in PRICE_METRICS

    def test_every_declared_metric_appears_in_description(self):
        p = spec()
        calc = describe_calculations(p)
        described = {f["code"] for stage in calc for f in calc[stage]}
        declared = {f.name for f in p.derived} | {f.name for f in p.piece_metrics} \
            | {f.name for f in p.order_metrics}
        assert described == declared


class TestPricingKey:
    """定价键必须**跨入口稳定**。

    这条被真实事故验证过：界面回传的值经过 JSON 会把 2.0 变成 2，
    而引擎拿到的还是 2.0（浮点）。两边各自拼字符串就成了
    `de=2` 与 `de=2.0` 两把钥匙 —— 症状是「成本存进去了，
    界面不显示、报价也不变」，业务眼里就是"存不上"。
    所以取值一律规范化，且下面这些入口必须拼出同一个键。
    """

    def test_float_and_int_spell_the_same_key(self):
        p = field_fence.build_spec()
        as_float = pricing_key_of(p, {"de": 2.0, "coating_code": "zinc_40"})
        as_int = pricing_key_of(p, {"de": 2, "coating_code": "zinc_40"})
        as_str = pricing_key_of(p, {"de": "2", "coating_code": "zinc_40"})
        assert as_float == as_int == as_str == "de=2|coating_code=zinc_40"

    def test_no_trailing_zero_or_scientific_notation(self):
        """2.0 → "2"（不是 "2.0"）；100 → "100"（不是 "1E+2"）。"""
        assert pricing_key_value(2.0) == "2"
        assert pricing_key_value(2.5) == "2.5"
        assert pricing_key_value(100) == "100"
        assert pricing_key_value(30000) == "30000"
        assert pricing_key_value(0.30) == "0.3"
        assert pricing_key_value("zinc_40") == "zinc_40"

    def test_matrix_options_are_the_same_keys_the_engine_looks_up(self):
        """界面拿到的取值清单，必须能拼出引擎查价用的那个键。

        界面只负责把 value 原样回传，所以两处必须完全一致 ——
        这一条正是把「存了却查不到」钉死的地方。
        """
        p = field_fence.build_spec()
        dims = {d["field"]: d for d in describe_product(p)["pricing_key"]}

        # 边丝径是**自由数值**：没有可选值清单，但维度**不能消失** ——
        # 消失了界面就少一列，而查价键仍带着它，又变成"存了却查不到"。
        assert dims["de"]["kind"] == "numeric"
        assert dims["de"]["options"] == []
        # 可枚举的那一维照旧：取值必须已规范成字符串，否则过一遍 JSON 就会变样
        assert all(isinstance(o["value"], str)
                   for o in dims["coating_code"]["options"])

        # 同一个表面处理，不同的边丝径拼出**不同**的键（用实际填入的值，不枚举）
        rows = [
            pricing_key_of(p, {"de": de, "coating_code": c["value"]})
            for de in (2, 2.3, 2.5)
            for c in dims["coating_code"]["options"]
        ]
        assert rows[0] == "de=2|coating_code=zinc_40"
        assert "de=2.3|coating_code=zinc_40" in rows, "自由数值必须进键"
        assert "de=2.5|coating_code=pvc_black" in rows
        assert len(set(rows)) == len(rows), "组合必须互不相同，否则会互相覆盖"

    def test_missing_dimension_yields_no_key(self):
        """少一个维度就不能拼键 —— 宁可回退，也不要用半截键查到错价。"""
        p = field_fence.build_spec()
        assert pricing_key_of(p, {"de": 2.0}) == ""
        assert pricing_key_of(p, {}) == ""

