"""出口报价引擎测试：规格展开、价链落地、订单指标、术语阶梯、三遍核验。

锁定的事实：
  · 牛栏网 5 表面处理 × 2 工艺 = 10 个**枚举**组合；尺寸类（丝径/网高/间距/卷长/卷径）
    是**自由数值**（2026-10-11 用户裁决），每个组合带一份，不参与笛卡尔积
  · 单卷售价 × 卷数 = 总价，且 每米价 × 总米数 = 总价，两者必须同时成立
  · 实际占用体积 = 长方体体积 × 装柜系数 0.96（= 1 − 扣减比例 4%，**按比例**而非固定额）
  · 报价有效期 7 天
  · 核验必须**抓得住**被篡改的数值 —— 发现不了错误的核验等于没有核验
  · 换产品只换产品类，引擎一行不改（用内联探针 spec 反证通用性）
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.services.export_quote import (
    DEFAULT_VALIDITY_DAYS,
    EngineError,
    QuoteRequest,
    RateSetRegistry,
    build,
    expand_specs,
    order_scopes,
    product_keys,
    verify_all,
    verify_invariants,
    verify_precision,
    verify_rate_set,
    verify_roundtrip,
    verify_terms,
)
from app.services.export_quote.models import Axis, ProductSpec, VariantGroup
from app.services.export_quote.products import field_fence
from app.services.export_quote.rates import normalize_hs
from app.services.export_quote.report import build_customer_view, build_internal_view, write_csv, write_xlsx

pytestmark = pytest.mark.unit

D = Decimal
RATE_SET_CODE = "CN-2026-09"


def policy(**kw):
    """牛栏网基线政策：进项 10 个点、利润 0.1 元/kg、让利 80%、印花税 5% 按利润。"""
    return {
        "input_vat_rate": 0.10,
        "output_vat": {"rate": 0.0, "mode": "additive"},
        "profit": {"mode": "fixed", "value": 0.1},
        "refund": {"refund_ratio": "auto", "give_ratio": 0.8},
        "stamp": {"rate": 0.05, "base": "profit"},
    }


def request(**kw) -> QuoteRequest:
    from app.services.export_quote.pricing import policy_from_dict

    cfg = policy()
    cfg.update(kw.pop("policy_overrides", {}))
    base = dict(
        product_key="field_fence",
        policy=policy_from_dict(cfg),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        rate_set=RateSetRegistry.from_dir().get(RATE_SET_CODE),
        quote_date=date(2026, 9, 24),
    )
    base.update(kw)
    return QuoteRequest(**base)


@pytest.fixture(scope="module")
def result():
    return build(request())


# ─────────────────────────────────────────────────────────────────────────────
# 规格展开
# ─────────────────────────────────────────────────────────────────────────────
class TestSpecExpansion:
    def test_field_fence_combos_match_surface_options(self):
        # 5 表面处理 × 2 工艺 = 10；尺寸类是自由数值，不进笛卡尔积
        assert len(expand_specs(field_fence.build_spec())) == 5 * 2

    def test_every_enumerated_option_is_covered_exactly_once(self, result):
        """可枚举的（表面处理 × 工艺）必须充分排列且不重复。

        尺寸类不在这里断言"覆盖" —— 它们是连续量，本身没有"枚举取值"可覆盖。
        """
        combos = [
            (r.spec["coating"], r.spec["wave"])
            for r in result.rows
        ]
        assert len(set(combos)) == 5 * 2, "组合必须充分排列且不重复"
        # 每个组合都要带齐尺寸类（默认值或调用方给的行）
        for r in result.rows:
            for key in ("de", "dm", "dv", "height_m", "mesh_mm", "roll_len_m",
                        "roll_dia_m", "n"):
                assert r.spec[key] is not None, f"组合缺少数值参数 {key}"

    def test_engine_is_product_agnostic(self):
        """引擎只认 ProductSpec、不认识任何具体产品：换一份 spec 就能展开，引擎代码一行不改。

        用**测试内联的探针 spec** 验证通用性（不注册进产品表）——
        产品表里只放真实产品，不为了验证而挂一个假产品（假产品会漏进业务的产品清单）。
        """
        probe = ProductSpec(
            key="__engine_probe__",
            name="通用性探针",
            cost_field="cost_per_kg",
            axes=[Axis("length_m", (6, 12), "定尺(m)", "Length (m)")],
            variants=[
                VariantGroup(
                    "size",
                    (
                        {"name": "A", "od_mm": 32, "cost_per_kg": 4.0},
                        {"name": "B", "od_mm": 48, "cost_per_kg": 3.9},
                        {"name": "C", "od_mm": 60, "cost_per_kg": 3.8},
                    ),
                    "规格",
                    "Size",
                )
            ],
        )
        assert len(expand_specs(probe)) == 2 * 3, "引擎应按 spec 展开，与具体产品无关"
        assert "__engine_probe__" not in product_keys(), "探针不得进入产品表"


# ─────────────────────────────────────────────────────────────────────────────
# 价链落地（与手工核对值一致）
# ─────────────────────────────────────────────────────────────────────────────
class TestPriceChainOnRows:
    def test_pretax_cost_is_4_4_and_5_6(self, result):
        """客户口径：4.4/5.6 已是税前成本（4.5/5.7 含 0.1 利润，不得再加一次）。"""
        by_coating = {r.spec["coating"]: r.price["cost_pretax"] for r in result.rows}
        assert by_coating["热镀锌 40g/㎡"] == D("4.4")
        assert by_coating["热镀锌 200g/㎡"] == D("5.6")

    def test_quote_matches_hand_verified_values(self, result):
        seen = {}
        for r in result.rows:
            seen.setdefault(r.spec["coating"], r.price["quote_excl_vat"])
        assert seen["热镀锌 40g/㎡"] == D("4.6028")
        assert seen["热镀锌 200g/㎡"] == D("5.8294")

    def test_export_zero_rated_means_no_output_vat(self, result):
        for r in result.rows:
            assert r.price["output_vat"] == 0
            assert r.price["quote_incl_vat"] == r.price["quote_excl_vat"]

    def test_profit_counted_exactly_once(self, result):
        """重复加利润的回归：税前报价必须等于税前成本 + 0.1。"""
        for r in result.rows:
            assert r.price["pretax_quote"] == D(r.price["cost_pretax"]) + D("0.1000")
            assert r.price["profit_amount"] == D("0.1000")

    def test_refund_warning_present_when_rebate_unconfirmed(self, result):
        """退税率未核实 → 必须有诊断提示，不能悄悄按全额可退算。"""
        joined = " ".join(result.diagnostics)
        assert "出口退税率" in joined or "退税" in joined


# ─────────────────────────────────────────────────────────────────────────────
# 单卷 / 订单指标
# ─────────────────────────────────────────────────────────────────────────────
class TestPieceAndOrderMetrics:
    def test_piece_weight_matches_formula(self, result):
        for r in result.rows:
            expect = D("0.00617") * D(str(r.spec["roll_len_m"])) * (
                D("2") * D(str(r.spec["de"])) ** 2
                + (D("10") - 2) * D(str(r.spec["dm"])) ** 2
                + D(str(r.spec["dv"])) ** 2
                * (D(str(r.derived["height_mm"])) + D("9") * D("50"))
                / D(str(r.spec["mesh_mm"]))
            )
            wave = D(str(r.derived["wave_add_kg"]))
            got = D(str(r.derived["weight_per_piece_kg"]))
            base = D(str(r.derived["weight_base_kg"]))
            assert (base + wave).quantize(D("0.0001")) == got
            assert abs(got - (expect + wave)) < D("0.0001"), (
                f"单卷重量与公式不符: {got} vs {expect + wave}"
            )

    def test_wave_adds_3kg_per_100m(self):
        r = build(request())
        plain = [x for x in r.rows if x.spec["wave"] == "无波款"][0]
        waved = [x for x in r.rows if x.spec["wave"] == "波弯款"][0]
        # 同规格对比：波弯款比无波款每 100 米多 3kg
        same = [
            (a, b)
            for a in r.rows if a.spec["wave"] == "无波款"
            for b in r.rows if b.spec["wave"] == "波弯款"
            if a.spec["coating"] == b.spec["coating"]
        ]
        assert same, "找不到同规格的波弯/无波配对"
        for a, b in same:
            delta = D(str(b.derived["wave_add_kg"]))
            assert delta == D("3") * D(str(a.spec["roll_len_m"])) / D("100")
            assert D(str(b.derived["weight_per_piece_kg"])) - D(
                str(a.derived["weight_per_piece_kg"])
            ) == delta
        assert plain and waved

    def test_roll_length_is_a_free_value_defaulting_to_100m(self, result):
        """卷长是**自由数值**参数（默认 100m），不再由"丝径方案"联动决定。"""
        assert all(r.spec["roll_len_m"] == 100 for r in result.rows)

    def test_roll_length_accepts_any_value(self):
        """50 米卷不是"另一个方案"，就是把 roll_len_m 填成 50。"""
        r = build(request(spec_rows=[{
            "coating": "热镀锌 40g/㎡", "wave": "无波款",
            "roll_len_m": 50, "roll_dia_m": 0.25,
        }], orders=field_fence.order_specs((30000,))))
        assert r.rows[0].spec["roll_len_m"] == 50
        assert r.rows[0].spec["roll_dia_m"] == D("0.25")

    def test_volume_is_box_times_stowage_factor(self, result):
        """按比例扣：实际占用 = 长方体总体积 × (1 − 0.04)。

        固定额（原 2.5 m³/单）在 < 2314 米的单子上会算出**负体积**。
        """
        q = D("0.0001")
        for r in result.rows:
            for order in ("o30000", "o50000"):
                box = D(str(r.orders[order]["volume_box_m3"]))
                eff = D(str(r.orders[order]["volume_effective_m3"]))
                assert eff == (box * (D("1") - D("0.04"))).quantize(q)
                assert eff > 0, "实际占用体积永远不该是负数"

    def test_total_price_equals_unit_times_quantity(self, result):
        """铁律：单价 × 数量 = 总价，两个口径都要严格成立。"""
        for r in result.rows:
            for order in ("o30000", "o50000"):
                m = r.orders[order]
                pieces = D(str(m["pieces"]))
                piece_price = D(str(r.piece["price_per_piece"]))
                assert D(str(m["total_price"])) == (pieces * piece_price).quantize(D("0.01"))
                # 每米口径
                meters = D(str(r.piece["price_per_meter"]))
                total_m = D("30000") if order == "o30000" else D("50000")
                assert D(str(m["total_price"])) == (meters * total_m).quantize(D("0.01"))

    def test_fx_price_equals_cny_over_rate(self, result):
        for r in result.rows:
            fx = D(str(r.piece["price_per_piece_fx"]))
            assert fx == (D(str(r.piece["price_per_piece"])) / D("6.7019")).quantize(
                D("0.0001")
            )

    def test_order_scopes_expose_labels(self, result):
        scopes = list(order_scopes(result))
        assert len(scopes) == len(result.rows) * len(result.request.orders)
        row, order, scope = scopes[0]
        assert order.name in ("o30000", "o50000")
        assert scope["order_name"] == order.name
        assert scope["order_label"] == order.label
        assert scope["total"] == order.total


# ─────────────────────────────────────────────────────────────────────────────
# 有效性 / 报错
# ─────────────────────────────────────────────────────────────────────────────
class TestValidityAndErrors:
    def test_default_validity_is_7_days(self):
        assert DEFAULT_VALIDITY_DAYS == 7

    def test_valid_until_is_quote_date_plus_7(self, result):
        assert result.quote_date == date(2026, 9, 24)
        assert result.valid_until == date(2026, 10, 1)

    def test_custom_validity(self):
        r = build(request(validity_days=30))
        assert r.valid_until == date(2026, 9, 24) + timedelta(days=30)

    def test_unknown_product_raises(self):
        with pytest.raises(EngineError, match="未注册"):
            build(request(product_key="nope"))

    def test_missing_product_key_raises(self):
        with pytest.raises(EngineError, match="product_key"):
            build(request(product_key=""))

    def test_no_orders_raises(self):
        with pytest.raises(EngineError, match="订单量"):
            build(request(orders=[]))

    def test_bad_fx_raises(self):
        """回归：汇率 0 曾被静默当成 1，会让美元价等于人民币价。"""
        with pytest.raises(EngineError, match="汇率"):
            build(request(fx_rate=D("0")))

    def test_negative_fx_raises(self):
        with pytest.raises(EngineError, match="汇率"):
            build(request(fx_rate=D("-6.7")))

    def test_absent_fx_defaults_to_one(self):
        r = build(request(fx_rate=None))
        assert r.rows[0].piece["price_per_piece_fx"] == r.rows[0].piece["price_per_piece"]

    def test_bad_rate_set_code_raises(self):
        with pytest.raises(Exception):
            RateSetRegistry.from_dir().get("NOPE")


# ─────────────────────────────────────────────────────────────────────────────
# 三遍核验
# ─────────────────────────────────────────────────────────────────────────────
class TestVerification:
    def test_all_passes_on_real_quote(self, result):
        rep = verify_all(result)
        assert rep.ok, rep.summary()

    def test_precision_passes_agree_decimal_vs_fraction(self, result):
        rep = verify_precision(result)
        assert rep.ok, rep.summary()
        assert rep.checks > 0

    def test_invariants_pass(self, result):
        rep = verify_invariants(result)
        assert rep.ok, rep.summary()
        # 牛栏网声明了 18 条关系式 × 行数 × 订单数
        assert rep.checks >= 10 * 18

    def test_rate_set_audit_warns_on_unconfirmed_rebate(self, result):
        rep = verify_rate_set(result)
        assert any("退税率" in i.field for i in rep.warnings()), rep.summary()

    # ---------- 故障注入：核验必须抓得住错 ----------
    def test_precision_check_catches_tampered_price(self, result):
        row = result.rows[0]
        original = row.price["quote_excl_vat"]
        row.price["quote_excl_vat"] = original + D("0.0001")
        try:
            rep = verify_precision(result)
            assert not rep.ok, "第2遍 Fraction 重算必须发现被改动的售价"
            assert rep.errors()
        finally:
            row.price["quote_excl_vat"] = original
        assert verify_precision(result).ok

    def test_invariant_check_catches_broken_total(self, result):
        row = result.rows[3]
        original = row.orders["o30000"]["total_price"]
        row.orders["o30000"]["total_price"] = original + D("1.00")
        try:
            rep = verify_invariants(result)
            assert not rep.ok, "总价与单价×数量不一致必须被抓到"
        finally:
            row.orders["o30000"]["total_price"] = original

    def test_invariant_check_catches_wrong_space_deduction(self, result):
        row = result.rows[5]
        original = row.orders["o50000"]["volume_effective_m3"]
        row.orders["o50000"]["volume_effective_m3"] = original + D("2")
        try:
            assert not verify_invariants(result).ok
        finally:
            row.orders["o50000"]["volume_effective_m3"] = original

    def test_rate_set_audit_catches_expired_archive(self, result):
        """报价日挪到档案生效期之外必须报错，避免误用旧税率。"""
        original = result.quote_date
        result.quote_date = date(2019, 1, 1)
        try:
            rep = verify_rate_set(result)
            assert not rep.ok, "档案不覆盖报价日必须报错"
        finally:
            result.quote_date = original


# ─────────────────────────────────────────────────────────────────────────────
# 术语阶梯
# ─────────────────────────────────────────────────────────────────────────────
TERMS = {
    "quote_as": "CIF",
    "items": {
        "inland": {"name": "内陆运费", "name_en": "Inland freight", "mode": "per_shipment",
                   "value": "2000"},
        "customs": {"name": "报关费", "name_en": "Customs clearance", "mode": "per_shipment",
                    "value": "500"},
        "ocean": {"name": "海运运费", "name_en": "Ocean freight", "mode": "per_shipment",
                  "source": "freight.ocean.value"},
        "insurance": {"name": "保险费", "name_en": "Insurance", "mode": "insurance_of_cif",
                      "source": "insurance.rate", "cif_factor": "1.1"},
    },
    "ladder": [
        {"code": "EXW"},
        {"code": "FOB", "label": "FOB", "items": ["inland", "customs"]},
        {"code": "CFR", "label": "CFR", "items": ["ocean"]},
        {"code": "CIF", "label": "CIF", "items": ["insurance"]},
    ],
}

PRICE_INPUTS = {"freight": {"ocean": {"value": "480"}}, "insurance": {"rate": "0.003"}}


class TestTermLadder:
    def test_ladder_is_monotonic_and_flags_incoterms_mistakes(self, result):
        from app.services.export_quote.terms import ladder_from_dict

        r = build(request(terms=ladder_from_dict(TERMS), price_inputs=PRICE_INPUTS))
        assert r.quote_as == "CIF"
        rows = r.rows[:6]
        for row in rows:
            for order in ("o30000", "o50000"):
                exw = D(str(row.terms["EXW"][order]["price_incl"]))
                fob = D(str(row.terms["FOB"][order]["price_incl"]))
                cfr = D(str(row.terms["CFR"][order]["price_incl"]))
                cif = D(str(row.terms["CIF"][order]["price_incl"]))
                assert exw < fob < cfr < cif, "各档必须严格递增"
                assert row.terms["EXW"][order]["fees"] == {}
                # per_shipment 费用要摊到单件上，整批 480 元
                pieces = D(str(row.orders[order]["pieces"]))
                assert D(str(row.terms["CFR"][order]["fees"]["ocean"])) == (
                    D("480") / pieces
                ).quantize(D("0.0001"))
                assert D(str(row.terms["CFR"][order]["fees"]["ocean"])) * pieces == D("480")

    def test_terms_verifier_passes(self, result):
        from app.services.export_quote.terms import ladder_from_dict

        r = build(request(terms=ladder_from_dict(TERMS), price_inputs=PRICE_INPUTS))
        rep = verify_terms(r)
        assert rep.ok, rep.summary()

    def test_terms_verifier_catches_tampered_rung(self, result):
        from app.services.export_quote.terms import ladder_from_dict

        r = build(request(terms=ladder_from_dict(TERMS), price_inputs=PRICE_INPUTS))
        row = r.rows[0]
        order = "o30000"
        original = row.terms["CIF"][order]["price_incl"]
        row.terms["CIF"][order]["price_incl"] = D(original) + D("0.01")
        try:
            assert not verify_terms(r).ok, "阶梯递增关系被破坏必须被抓到"
        finally:
            row.terms["CIF"][order]["price_incl"] = original


# ─────────────────────────────────────────────────────────────────────────────
# 输出投影
# ─────────────────────────────────────────────────────────────────────────────
class TestViews:
    INTERNAL_LABELS = ("税前成本", "含税采购价", "加工利润", "进项税额", "让利额", "自留可退税额")

    def test_customer_columns_exclude_internal_flags(self, result):
        internal_cols = result.columns("internal")
        customer_cols = result.columns("customer")
        assert any(c.internal for c in internal_cols), "内部视图必须含成本税额列"
        assert not any(c.internal for c in customer_cols), "客户视图不得含 internal 列"
        assert len(customer_cols) < len(internal_cols)

    def test_customer_view_never_renders_cost_labels(self, result):
        """铁律：对外展示不得暴露成本利润率 —— 标签层面就要保证。"""
        texts = _all_strings(build_customer_view(result))
        for label in self.INTERNAL_LABELS:
            assert not any(label in t for t in texts), f"客户视图泄露了「{label}」"

    def test_internal_view_does_render_cost_labels(self, result):
        texts = _all_strings(build_internal_view(result))
        for label in ("税前成本", "加工利润", "进项税额"):
            assert any(label in t for t in texts), f"内部视图缺少「{label}」"

    def test_customer_view_row_and_column_shape(self, result):
        view = build_customer_view(result)
        header = view["header"]
        assert len(view["rows"]) == 10
        assert all(len(row) == len(header) for row in view["rows"])

    def test_customer_view_has_bilingual_headers(self, result):
        zh = build_customer_view(result)["header"]
        en = build_customer_view(result, english=True)["header"]
        assert zh and en
        assert len(zh) == len(en) == len(result.columns("customer"))
        assert any(_has_cjk(h) for h in zh), "中文视图应有中文表头"
        assert not any(_has_cjk(h) for h in en), "英文视图不应出现汉字"
        # 英文表头必须来自 label_en，不是照搬中文
        cols = result.columns("customer")
        assert en == [(c.label_en or c.label) for c in cols]
        assert sum(1 for c in cols if c.label_en) >= len(cols) - 2, (
            "绝大多数列都应提供英文表头，方便直接给客户"
        )

    def test_write_csv_and_verify_roundtrip(self, result, tmp_path):
        path = tmp_path / "quote.csv"
        write_csv(result, str(path), view="internal")
        assert path.exists()
        rep = verify_roundtrip(result, str(path))
        assert rep.ok, rep.summary()

    def test_write_xlsx_and_verify_roundtrip(self, result, tmp_path):
        path = tmp_path / "quote.xlsx"
        write_xlsx(result, str(path))
        assert path.exists()
        rep = verify_roundtrip(result, str(path))
        assert rep.ok, rep.summary()

    def test_roundtrip_catches_tampered_file(self, result, tmp_path):
        """第3遍读回必须能发现文件被改过。"""
        path = tmp_path / "tampered.csv"
        write_csv(result, str(path), view="internal")
        lines = path.read_text(encoding="utf-8-sig").splitlines()
        cells = lines[-1].split(",")
        cells[0] = "999"
        lines[-1] = ",".join(cells)
        path.write_text("\n".join(lines), encoding="utf-8-sig")
        rep = verify_roundtrip(result, str(path))
        assert not rep.ok, "文件与内存值不一致必须被抓到"


def _has_cjk(text) -> bool:
    """是否含汉字（区分中英表头；³、± 之类的符号不算汉字）。"""
    return any("\u4e00" <= ch <= "\u9fff" for ch in str(text))


def _all_strings(payload) -> list:
    """收集视图输出里所有字符串（表头、标签等）。"""
    out: list = []
    if isinstance(payload, str):
        out.append(payload)
    elif isinstance(payload, dict):
        for v in payload.values():
            out.extend(_all_strings(v))
    elif isinstance(payload, (list, tuple)):
        for v in payload:
            out.extend(_all_strings(v))
    return out


class TestHSNormalization:
    def test_field_fence_hs_is_normalizable(self):
        for hs in field_fence.HS_CODES:
            assert normalize_hs(hs) == hs
