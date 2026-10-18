"""DAP / DDP 两档贸易术语：模板结构 + 阶梯计算。

为什么单独一个文件
------------------
`test_export_quote_engine.py` 里的 TERMS 是**手写的最小配置**，用来验证引擎的
累加/校验逻辑；这里验证的是**平台默认模板**（`terms_template.py` 的
`DEFAULT_EXPORT_TERMS`）本身：新增的 DAP / DDP 两档能不能被引擎算出来、
口径是不是「DDP = DAP + 进口税费」。

锁定的事实：
  · 阶梯是 EXW → FOB → CFR → CIF → DAP → DDP，逐档累加，每档只列本档新增
  · 新费用项 `destination_charges` / `import_taxes` 都是 `per_shipment`
    —— 不需要新的 mode：mode 只决定「怎么摊」，不决定「谁承担」
  · `quote_as=DAP` 时只多算目的港费用；`quote_as=DDP` 时再多算进口税费，
    且两者之差恰好等于 import_taxes 摊到单件的金额
  · 默认 `quote_as` 仍是 `CIF`（新增档位不能悄悄改变默认对外报价口径）
"""
from decimal import Decimal as D

import pytest

from app.services.export_quote.terms import ladder_from_dict
from app.services.export_quote.terms_template import (
    DEFAULT_EXPORT_TERMS,
    default_terms_template,
)

pytestmark = pytest.mark.unit

# 一件 = 一卷；整批 10 件、单件净重 100kg，EXW 单件 100 元（数字取整便于核对）
PIECES = D("10")
WEIGHT = D("100")
EXW = D("100")

# 目的港费用与进口税费按**整批**填（per_shipment），引擎 ÷ 件数摊到单卷
DESTINATION_CHARGES = D("1500")
IMPORT_TAXES = D("800")

RUNG_CODES = ["EXW", "FOB", "CFR", "CIF", "DAP", "DDP"]


def filled_template() -> dict:
    """把模板原样回传、只把 value 填成数字 —— 与界面的行为一致。"""
    tpl = default_terms_template()
    for key, amount in (
        ("inland_freight", D("2000")),
        ("port_charges", D("500")),
        ("customs_fee", D("300")),
        ("ocean_freight", D("120")),   # 元 / 吨
        ("insurance", D("0.003")),     # 费率（CIF 加成投保）
        ("destination_charges", DESTINATION_CHARGES),
        ("import_taxes", IMPORT_TAXES),
    ):
        tpl["items"][key]["value"] = str(amount)
    return tpl


def compute(quote_as: str):
    """按指定 `quote_as` 构造模板 → 过 `ladder_from_dict` → 逐档累加。"""
    tpl = filled_template()
    tpl["quote_as"] = quote_as
    ladder = ladder_from_dict(tpl)
    assert ladder is not None
    return ladder, ladder.compute(EXW, WEIGHT, PIECES)


# ─────────────────────────────────────────────────────────────────────────────
# 模板结构
# ─────────────────────────────────────────────────────────────────────────────
class TestTemplateShape:
    def test_ladder_ends_with_dap_then_ddp(self):
        assert [r["code"] for r in DEFAULT_EXPORT_TERMS["ladder"]] == RUNG_CODES

    def test_new_rungs_only_add_their_own_item(self):
        rungs = {r["code"]: r for r in DEFAULT_EXPORT_TERMS["ladder"]}
        assert rungs["DAP"]["items"] == ["destination_charges"]
        assert rungs["DDP"]["items"] == ["import_taxes"]

    def test_labels_carry_full_english_names(self):
        rungs = {r["code"]: r for r in DEFAULT_EXPORT_TERMS["ladder"]}
        assert rungs["EXW"]["label_en"] == "Ex Works"
        assert rungs["FOB"]["label_en"] == "Free On Board"
        assert rungs["CFR"]["label_en"] == "Cost and Freight"
        assert rungs["CIF"]["label_en"] == "Cost, Insurance and Freight"
        assert rungs["DAP"]["label"] == "到门价（目的地交货）"
        assert rungs["DAP"]["label_en"] == "Delivered at Place"
        assert rungs["DDP"]["label"] == "完税到门价（含进口税费）"
        assert rungs["DDP"]["label_en"] == "Delivered Duty Paid"

    def test_new_items_are_per_shipment_and_have_no_preset_amount(self):
        for key in ("destination_charges", "import_taxes"):
            item = DEFAULT_EXPORT_TERMS["items"][key]
            # 不需要新 mode：两者都是整批一次的费用
            assert item["mode"] == "per_shipment", key
            assert item["value"] is None, key
            assert item["unit_hint"] == "元 / 整批", key
            assert item["name"] and item["name_en"], key

    def test_new_items_notes_state_what_is_included(self):
        """DAP 不含进口税费、DDP 按目的国实缴填 —— 这是两档的分界线。"""
        dest_note = DEFAULT_EXPORT_TERMS["items"]["destination_charges"]["note"]
        assert "不含进口关税与增值税" in dest_note
        tax_note = DEFAULT_EXPORT_TERMS["items"]["import_taxes"]["note"]
        assert "DDP" in tax_note

    def test_quote_as_default_stays_cif(self):
        assert DEFAULT_EXPORT_TERMS["quote_as"] == "CIF"
        assert default_terms_template()["quote_as"] == "CIF"

    def test_new_rungs_do_not_trip_the_incoterms_audit(self):
        ladder = ladder_from_dict(filled_template())
        assert ladder is not None
        assert ladder.audit() == []


# ─────────────────────────────────────────────────────────────────────────────
# 计算
# ─────────────────────────────────────────────────────────────────────────────
class TestDapDdpCompute:
    def test_dap_adds_exactly_the_destination_charges(self):
        _, out = compute("DAP")
        # 本档只新增一项，金额 = 整批 ÷ 件数
        assert out["DAP"]["fees"] == {"destination_charges": DESTINATION_CHARGES / PIECES}
        assert (
            out["DAP"]["subtotal_excl"] - out["CIF"]["subtotal_excl"]
            == DESTINATION_CHARGES / PIECES
        )

    def test_ddp_equals_dap_plus_import_taxes(self):
        """DDP 口径的验收断言：多出来的正好是进口关税及税费。"""
        _, out = compute("DDP")
        assert out["DDP"]["fees"] == {"import_taxes": IMPORT_TAXES / PIECES}
        assert (
            out["DDP"]["subtotal_excl"] - out["DAP"]["subtotal_excl"]
            == IMPORT_TAXES / PIECES
        )
        # 也按整批核对一次（避免只看单件、漏掉摊分的整数倍误差）
        dap_total = out["DAP"]["total_excl"]
        ddp_total = out["DDP"]["total_excl"]
        assert ddp_total - dap_total == IMPORT_TAXES

    def test_dap_and_ddp_are_quoted_when_requested(self):
        for code in ("DAP", "DDP"):
            ladder, out = compute(code)
            assert ladder.quote_as == code
            # 请求的档位必须真的出现在阶梯输出里
            assert out[code]["subtotal_excl"] > 0

    def test_ladder_stays_strictly_increasing(self):
        """EXW < FOB < CFR < CIF < DAP < DDP —— 逐档累加不能出现倒挂。"""
        _, out = compute("DDP")
        prices = [out[code]["subtotal_excl"] for code in RUNG_CODES]
        assert prices == sorted(prices)
        assert len(set(prices)) == len(prices)
        assert out["EXW"]["fees"] == {}


# ─────────────────────────────────────────────────────────────────────────────
# 走一遍真实引擎（build → 术语阶梯投影 → verify_terms）
# ─────────────────────────────────────────────────────────────────────────────
def engine_build(quote_as: str):
    """用牛栏网的基线政策跑完整引擎，而不是只调 `TermLadder.compute`。"""
    from datetime import date

    from app.services.export_quote import (
        QuoteRequest,
        RateSetRegistry,
        build,
        verify_terms,
    )
    from app.services.export_quote.pricing import policy_from_dict
    from app.services.export_quote.products import field_fence

    tpl = filled_template()
    tpl["quote_as"] = quote_as
    req = QuoteRequest(
        product_key="field_fence",
        policy=policy_from_dict({
            "input_vat_rate": D("0.10"),
            "output_vat": {"rate": D("0"), "mode": "additive"},
            "profit": {"mode": "fixed", "value": D("0.1")},
            "refund": {"refund_ratio": "auto", "give_ratio": D("0.8")},
            "stamp": {"rate": D("0.05"), "base": "profit"},
        }),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000,)),
        rate_set=RateSetRegistry.from_dir().get("CN-2026-09"),
        quote_date=date(2026, 9, 24),
        terms=ladder_from_dict(tpl),
    )
    return build(req), verify_terms


class TestEngineLevel:
    def test_build_projects_dap_and_ddp_rows(self):
        result, _ = engine_build("DDP")
        assert result.quote_as == "DDP"
        assert list(result.term_codes)[-2:] == ["DAP", "DDP"]

    def test_engine_ddp_equals_dap_plus_import_taxes_and_verifies(self):
        result, verify_terms = engine_build("DDP")
        for row in result.rows[:3]:
            for order in ("o30000",):
                dap = row.terms["DAP"][order]
                ddp = row.terms["DDP"][order]
                pieces = D(str(row.orders[order]["pieces"]))
                expected = (IMPORT_TAXES / pieces).quantize(D("0.0001"))
                assert ddp["subtotal_excl"] - dap["subtotal_excl"] == expected
        rep = verify_terms(result)
        assert rep.ok, rep.summary()
