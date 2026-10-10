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

from app.services.export_quote import (
    QuoteRequest,
    RateSetRegistry,
    build,
    describe_calculations,
    describe_product,
    describe_space,
    worked_example,
)
from app.services.export_quote.formulas import PRICE_METRICS
from app.services.export_quote.models import pricing_key_of, pricing_key_value
from app.services.export_quote.products import field_fence

pytestmark = pytest.mark.unit

# 与产品定义 constants['pi'] 保持一致
PI_STR = "3.14159265358979323846"


def spec():
    return field_fence.build_spec()


# 丝径拆分前的「方案名」→ 拆分后的 (边丝径, 内丝径)。
# 保留旧名是为了让下面按规格定位的用例读起来仍然直观（对应关系是确定的）。
WIRE_SPLIT = {
    "全丝2.0": {"de": 2.0, "inner_wire": "内丝2.0"},
    "全丝2.5": {"de": 2.5, "inner_wire": "内丝2.5"},
    "边丝2.5+内丝2.0": {"de": 2.5, "inner_wire": "内丝2.0"},
}


def find(res, wire=None, **want):
    """按规格取值定位一行；给 `wire`（旧方案名）会展开成 边丝径 + 内丝径。"""
    if wire is not None:
        want.update(WIRE_SPLIT[wire])
    for r in res.rows:
        if all(r.spec.get(k) == v for k, v in want.items()):
            return r
    raise LookupError(want)


def build_res():
    return build(QuoteRequest(
        product_key="field_fence",
        policy=_policy(),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        rate_set=RateSetRegistry.from_dir().get("CN-2026-09"),
        quote_date=date(2026, 9, 24),
    ))


def _policy():
    from app.services.export_quote.pricing import policy_from_dict
    return policy_from_dict({
        "input_vat_rate": D("0.10"),
        "output_vat": {"rate": D("0"), "mode": "additive"},
        "profit": {"mode": "fixed", "value": D("0.1")},
        "refund": {"refund_ratio": D("1"), "give_ratio": D("0.8")},
        "stamp": {"rate": D("0.05"), "base": "profit"},
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
    """实际占用体积 = 长方体累计总体积 − 2.5 m³（每单扣一次）。"""

    def test_deduction_is_median_of_two_to_three(self):
        sd = spec().space_deduction
        assert sd.mode == "median"
        assert sd.range == (2, 3)
        assert sd.note, "扣减口径必须写明，业务要看懂为什么扣"

    def test_box_volume_is_box_per_piece_times_count(self):
        """长方体总体积用**单卷长方体体积**累加（不是圆柱体净体积）。"""
        res = build_res()
        for r in res.rows:
            for oname in ("o30000", "o50000"):
                m = r.orders[oname]
                unit = D(str(r.derived["volume_box_per_piece_m3"]))
                assert D(str(m["volume_box_m3"])) == (D(str(m["pieces"])) * unit)

    def test_effective_equals_box_minus_deduction(self):
        res = build_res()
        for r in res.rows:
            for oname in ("o30000", "o50000"):
                m = r.orders[oname]
                assert (D(str(m["volume_effective_m3"]))
                        == D(str(m["volume_box_m3"])) - D("2.5"))

    def test_deduction_applied_once_per_order_not_per_roll(self):
        """每单只扣一次，不随卷数放大。"""
        res = build_res()
        r = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                 coating="热镀锌 40g/㎡", wave="无波款")
        for oname in ("o30000", "o50000"):
            m = r.orders[oname]
            ded = D(str(m["volume_box_m3"])) - D(str(m["volume_effective_m3"]))
            assert ded == D("2.5"), "扣减不该随卷数放大"

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
        assert D(str(r.orders["o30000"]["volume_effective_m3"])) == D("29.9000")
        assert D(str(r.orders["o50000"]["volume_effective_m3"])) == D("51.5000")

    def test_roll_diameter_default_and_override(self):
        """卷径有默认值（随丝径方案联动）且可覆盖。"""
        res = build_res()
        long_roll = find(res, wire="全丝2.0", height_m=1.2, mesh_mm=100,
                         coating="热镀锌 40g/㎡", wave="无波款")
        short_roll = find(res, wire="全丝2.5", height_m=1.2, mesh_mm=100,
                          coating="热镀锌 40g/㎡", wave="无波款")
        assert D(str(long_roll.derived["roll_dia_cm"])) == D("30.0")
        assert D(str(short_roll.derived["roll_dia_cm"])) == D("25.0")

        from app.services.export_quote import QuoteRequest as QR
        over = build(QR(
            product_key="field_fence",
            policy=_policy(),
            fx_rate=D("6.7019"),
            orders=field_fence.order_specs((30000,)),
            rate_set=RateSetRegistry.from_dir().get("CN-2026-09"),
            quote_date=date(2026, 9, 24),
            variant_overrides={"inner_wire": {"内丝2.0": {"roll_dia_m": D("0.32")}}},
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
        # 2×2×2 轴 × 2×5×2 变体包 = 160 组合（表面处理扩到 5 档后）
        assert space["combo_count"] == 160
        assert "48" not in space["formula"]  # formula 只描述轴，不含结论数字
        assert space["summary"]

    def test_product_description_contains_deduction_and_invariants(self):
        d = describe_product(spec())
        assert d["space_deduction"]["note"]
        assert d["space_deduction"]["range"] == [2, 3]
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
        scope["space_deduction"] = D("2.5")
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
        assert D(got["volume_effective_m3"]) == D("29.9000")
        assert D(got["pieces"]) == D("300")
        # 波弯款单卷 314.84 元 → 300 卷 94452.00 元（基准表第 2 行）
        assert D(got["price_per_piece"]) == D("314.84")
        assert D(got["total_price"]) == D("94452.00")

    def test_worked_example_reproduces_plain_row_total(self):
        """无波款单卷 301.03 元 → 300 卷 90309.00 元（基准表第 1 行）。"""
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
        scope["space_deduction"] = D("2.5")
        scope["terms_enabled"] = 0
        scope["main_price_incl"] = r.piece["price_per_piece"]
        scope["unit_price"] = r.price["quote_final"]
        got = {s["code"]: s["value"] for s in worked_example(spec(), scope)}
        assert D(got["wave_add_kg"]) == 0
        assert D(got["weight_per_piece_kg"]) == D("65.4020")
        assert D(got["volume_per_piece_m3"]) == D("0.0848")
        assert D(got["volume_box_per_piece_m3"]) == D("0.1080")
        assert D(got["price_per_piece"]) == D("301.03")
        assert D(got["total_price"]) == D("90309.00")

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
        scope["space_deduction"] = D("2.5")
        scope["pieces"] = D("300")
        only = ["wave_add_kg", "volume_box_m3", "volume_effective_m3"]
        steps = worked_example(spec(), scope, only)
        assert [s["code"] for s in steps] == only
        vals = {s["code"]: s["value"] for s in steps}
        assert vals["volume_box_m3"] is not None, "依赖项被跳过导致空结果"
        assert D(vals["volume_effective_m3"]) == D("29.9000")

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
        for dim in describe_product(p)["pricing_key"]:
            assert all(isinstance(o["value"], str) for o in dim["options"]), \
                f"{dim['field']} 的取值必须已规范化成字符串，否则过一遍 JSON 就会变样"

        rows = [
            pricing_key_of(p, {"de": o["value"], "coating_code": c["value"]})
            for o in next(d for d in describe_product(p)["pricing_key"] if d["field"] == "de")["options"]
            for c in next(d for d in describe_product(p)["pricing_key"] if d["field"] == "coating_code")["options"]
        ]
        assert rows == [
            "de=2|coating_code=zinc_40",
            "de=2|coating_code=zinc_200",
            "de=2|coating_code=zinc_260",
            "de=2|coating_code=elec_galv",
            "de=2|coating_code=pvc_black",
            "de=2.5|coating_code=zinc_40",
            "de=2.5|coating_code=zinc_200",
            "de=2.5|coating_code=zinc_260",
            "de=2.5|coating_code=elec_galv",
            "de=2.5|coating_code=pvc_black",
        ]
        assert len(set(rows)) == len(rows), "组合必须互不相同，否则会互相覆盖"

    def test_missing_dimension_yields_no_key(self):
        """少一个维度就不能拼键 —— 宁可回退，也不要用半截键查到错价。"""
        p = field_fence.build_spec()
        assert pricing_key_of(p, {"de": 2.0}) == ""
        assert pricing_key_of(p, {}) == ""
