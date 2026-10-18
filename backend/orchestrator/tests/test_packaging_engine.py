"""包装费用（需求 20）：产品级多包装 / 默认包装 / 规格区间 / 计入成本。"""
from dataclasses import replace
from datetime import date
from decimal import Decimal as D

import pytest

from app.services.export_quote.engine import EngineError, QuoteRequest, build, _packaging_fee, _pick_packaging
from app.services.export_quote.pricing import policy_from_dict
from app.services.export_quote.products import field_fence

pytestmark = pytest.mark.unit


def _policy():
    return policy_from_dict({
        "input_vat_rate": 0.10,
        "output_vat": {"rate": 0.0, "mode": "additive"},
        "profit": {"mode": "fixed", "value": 0.1},
        "refund": {"refund_ratio": "auto", "give_ratio": 0.8},
        "stamp": {"rate": 0.05, "base": "profit"},
    })


def _request(product=None, packaging_id=""):
    return QuoteRequest(
        product_key="field_fence",
        product=product,
        policy=_policy(),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000,)),
        quote_date=date(2026, 9, 24),
        packaging_id=packaging_id,
    )


def _product(packaging):
    return replace(field_fence.build_spec(), packaging=packaging)


PKG_A = {
    "id": "pkg-a", "name": "编织袋", "method": "编织袋", "is_default": True,
    "created_at": "2026-01-01T00:00:00+00:00", "mode": "per_piece",
    "amount": 0, "ranges": [],
}
PKG_B = {
    "id": "pkg-b", "name": "木箱", "method": "木箱", "is_default": False,
    "created_at": "2026-02-01T00:00:00+00:00", "mode": "per_piece",
    "amount": 0, "ranges": [],
}


class TestPickPackaging:
    def test_default_wins(self):
        assert _pick_packaging(_product([PKG_B, PKG_A]), "")["id"] == "pkg-a"

    def test_earliest_created_when_no_default(self):
        a = {**PKG_A, "is_default": False}
        b = {**PKG_B, "created_at": "2026-03-01T00:00:00+00:00"}
        assert _pick_packaging(_product([b, a]), "")["id"] == "pkg-a"

    def test_explicit_id(self):
        assert _pick_packaging(_product([PKG_A, PKG_B]), "pkg-b")["id"] == "pkg-b"

    def test_unknown_id_raises(self):
        with pytest.raises(EngineError):
            _pick_packaging(_product([PKG_A]), "pkg-x")

    def test_no_packaging(self):
        assert _pick_packaging(_product([]), "") is None


class TestPackagingFee:
    def test_no_packaging_is_zero(self):
        fee, pkg, rng = _packaging_fee(_product([]), "", {})
        assert fee == 0 and pkg is None and rng is None

    def test_range_left_closed_right_open(self):
        pkg = {
            **PKG_A,
            "ranges": [
                {"field": "height_m", "min": 0, "max": 2, "amount": 1},
                {"field": "height_m", "min": 2, "max": None, "amount": 2},
            ],
        }
        product = _product([pkg])
        assert _packaging_fee(product, "", {"height_m": 1.5})[0] == D("1")
        assert _packaging_fee(product, "", {"height_m": 2})[0] == D("2")
        assert _packaging_fee(product, "", {"height_m": 2.5})[0] == D("2")

    def test_fallback_amount_when_no_range_matches(self):
        pkg = {
            **PKG_A,
            "amount": 3,
            "ranges": [{"field": "height_m", "min": 0, "max": 1, "amount": 1}],
        }
        assert _packaging_fee(_product([pkg]), "", {"height_m": 9})[0] == D("3")

    def test_overlapping_ranges_raise(self):
        pkg = {
            **PKG_A,
            "ranges": [
                {"field": "height_m", "min": 0, "max": 2, "amount": 1},
                {"field": "height_m", "min": 1, "max": 3, "amount": 2},
            ],
        }
        with pytest.raises(EngineError):
            _packaging_fee(_product([pkg]), "", {"height_m": 1.5})


class TestEngineAddsPackagingCost:
    def test_cost_pretax_increases_by_packaging_fee(self):
        base = build(_request(_product([{**PKG_A, "amount": 0}])))
        packed = build(_request(_product([{**PKG_A, "amount": 5}])))
        delta = packed.rows[0].price["cost_pretax"] - base.rows[0].price["cost_pretax"]
        assert delta == D("5")

    def test_explicit_packaging_choice_changes_cost(self):
        product = _product([
            {**PKG_A, "amount": 1},
            {**PKG_B, "amount": 9},
        ])
        default = build(_request(product))
        chosen = build(_request(product, packaging_id="pkg-b"))
        delta = chosen.rows[0].price["cost_pretax"] - default.rows[0].price["cost_pretax"]
        assert delta == D("8")


class TestSpecRoundtrip:
    def test_numeric_and_piece_inputs_survive_dict_roundtrip(self):
        """2026-10-18 缺陷回归：租户产品复制系统定义后丢了数值参数。

        原 spec_from_dict 漏了 numeric_inputs/piece_inputs/params，导致
        「派生公式求值失败：未定义变量 height_m」。
        """
        from app.services.export_quote.tenant_products import spec_from_dict, spec_to_dict

        original = field_fence.build_spec()
        restored = spec_from_dict(spec_to_dict(original))
        assert len(restored.numeric_inputs) == len(original.numeric_inputs)
        assert [n.key for n in restored.numeric_inputs] == [n.key for n in original.numeric_inputs]
        assert len(restored.piece_inputs) == len(original.piece_inputs)
        assert restored.numeric_inputs[0].default == original.numeric_inputs[0].default
