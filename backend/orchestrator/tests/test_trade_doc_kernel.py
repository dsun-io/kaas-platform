"""共享内核 trade_doc 纯单测（无 DB、无三方依赖，可直接跑）。"""
from decimal import Decimal

import pytest

from kaas_common.trade_doc import (
    RuleError, PngError,
    assert_draft, assert_derivable, assert_transition, can_transition,
    check_line_amount, line_amount, validate_confirm, validate_items,
    apply_scheme, compose_fields, derive_payload, resolve_scheme, scheme_names,
    format_doc_no, month_of, doc_no_prefix,
    is_png, png_size, validate_seal_image,
    build_messages, parse_translation,
)


# ─── 状态机 ────────────────────────────────────────────────────────────────

class TestStatusMachine:
    def test_draft_can_issue_and_void(self):
        assert can_transition("draft", "issued")
        assert can_transition("draft", "void")

    def test_issued_locked_only_void(self):
        """确认即锁死：issued 不可回到 draft，只能作废。"""
        assert not can_transition("issued", "draft")
        assert can_transition("issued", "void")

    def test_void_terminal(self):
        assert not can_transition("void", "draft")
        assert not can_transition("void", "issued")

    def test_assert_transition_raises_with_code(self):
        with pytest.raises(RuleError) as e:
            assert_transition("issued", "draft")
        assert e.value.code == "ILLEGAL_TRANSITION"

    def test_assert_draft(self):
        assert_draft("draft")  # 不抛
        with pytest.raises(RuleError) as e:
            assert_draft("issued")
        assert e.value.code == "NOT_DRAFT"


# ─── 派生前置 ──────────────────────────────────────────────────────────────

class TestDeriveGate:
    def test_only_issued_source_derivable(self):
        assert_derivable("issued")  # 不抛

    @pytest.mark.parametrize("status", ["draft", "void"])
    def test_unconfirmed_source_rejected(self, status):
        with pytest.raises(RuleError) as e:
            assert_derivable(status, "QUO-202609-0001")
        assert e.value.code == "SOURCE_NOT_CONFIRMED"
        assert "QUO-202609-0001" in e.value.detail


# ─── 金额勾稽 ──────────────────────────────────────────────────────────────

class TestAmounts:
    def test_line_amount_half_up(self):
        assert line_amount("3", "1.005") == Decimal("3.0150")

    def test_check_line_amount_ok(self):
        assert check_line_amount({"qty": 2, "unit_price": "1.5"}) == Decimal("3.0000")

    def test_check_line_amount_mismatch(self):
        with pytest.raises(RuleError) as e:
            check_line_amount({"product_name": "A", "qty": 2, "unit_price": 1.5, "line_amount": 99})
        assert e.value.code == "ITEMS_INVALID"

    def test_missing_price_allowed(self):
        """询价场景：数量或单价暂缺，不强求勾稽。"""
        assert check_line_amount({"qty": 2}) == Decimal(0)


# ─── 行项目 / 确认校验 ─────────────────────────────────────────────────────

class TestValidation:
    def test_items_require_name_and_qty(self):
        res = validate_items([{"product_name": "", "qty": 0}])
        assert not res.ok
        assert any("品名" in i for i in res.issues)

    def test_items_empty_rejected(self):
        assert not validate_items([]).ok

    def test_confirm_requires_buyer(self):
        res = validate_confirm("ci", {"custom": {}}, [{"product_name": "A", "qty": 1, "unit_price": 1}])
        assert not res.ok
        assert any("买方" in i for i in res.issues)

    def test_confirm_ok_with_customer(self):
        res = validate_confirm("ci", {"customer_id": "c1", "custom": {}},
                               [{"product_name": "A", "qty": 1, "unit_price": 1}])
        assert res.ok, res.issues

    def test_confirm_pi_requires_payment_terms(self):
        items = [{"product_name": "A", "qty": 1, "unit_price": 1}]
        res = validate_confirm("pi", {"customer_id": "c1", "custom": {}}, items)
        assert not res.ok
        assert any("payment_terms" in i for i in res.issues)


# ─── 字段合成 / 派生装配 ───────────────────────────────────────────────────

class TestPayload:
    def test_manual_wins_over_all(self):
        out = compose_fields(
            defaults={"a": "def", "b": "def"},
            derived={"a": "derived", "b": "derived"},
            subjects={"a": "subject"},
            manual={"a": "manual"},
        )
        assert out["a"] == "manual"
        assert out["b"] == "derived"

    def test_derive_payload_freezes_snapshot(self):
        source = {"custom": {"buyer": "X"}, "sources": {}}
        out = derive_payload(source, source_kind="quote", doc_type="pi", manual={"buyer": "Y"})
        # 手工覆盖派生
        assert out["custom"]["buyer"] == "Y"
        # 快照冻结：源后续变更不影响
        source["custom"]["buyer"] = "CHANGED"
        assert out["sources"]["quote"]["custom"]["buyer"] == "X"
        assert out["derived"]["from_kind"] == "quote"


# ─── 方案物化 ──────────────────────────────────────────────────────────────

class TestSchemes:
    ITEMS = [
        {"product_name": "A", "qty": 100, "unit_price": 1,
         "scheme_prices": {"o30000": {"qty": 300, "unit_price": 0.9}}},
        {"product_name": "B", "qty": 5, "unit_price": 2, "scheme_prices": {}},
    ]

    def test_scheme_names(self):
        assert scheme_names(self.ITEMS) == ["o30000"]

    def test_single_scheme_auto(self):
        assert resolve_scheme(self.ITEMS, None) == "o30000"

    def test_apply_scheme_materializes(self):
        rows = apply_scheme(self.ITEMS, None)
        assert rows[0]["qty"] == 300
        assert Decimal(str(rows[0]["unit_price"])) == Decimal("0.9")
        assert rows[0]["line_amount"] == Decimal("270.0000")
        assert rows[0]["source"] == "generated"
        # 未命中方案价的自由行保持原值
        assert rows[1]["qty"] == 5

    def test_unknown_scheme_rejected(self):
        with pytest.raises(RuleError):
            resolve_scheme(self.ITEMS, "nope")


# ─── 单号 ──────────────────────────────────────────────────────────────────

class TestDocNo:
    def test_format(self):
        import datetime
        assert format_doc_no("pi", datetime.date(2026, 9, 30), 1) == "PI-202609-0001"

    def test_prefix_fallback(self):
        assert doc_no_prefix("pi") == "PI"
        assert doc_no_prefix("mystery") == "MYS"

    def test_month_parse(self):
        assert month_of("PI-202609-0001") == "202609"
        assert month_of("bad") is None


# ─── PNG（替代 Pillow）────────────────────────────────────────────────────

class TestPng:
    @staticmethod
    def _make_png(w=40, h=20):
        import struct, zlib
        # 布局：魔数(8) + len(4)=13 + "IHDR"(4) + 宽高等(13) + CRC(4)
        ihdr = struct.pack(">I4sIIBBBBB", 13, b"IHDR", w, h, 8, 6, 0, 0, 0)
        chunk = ihdr + struct.pack(">I", zlib.crc32(ihdr))
        return b"\x89PNG\r\n\x1a\n" + chunk

    def test_magic_and_size(self):
        data = self._make_png(40, 20)
        assert is_png(data)
        assert png_size(data) == (40, 20)

    def test_not_png(self):
        assert not is_png(b"\xff\xd8jpeg")
        with pytest.raises(PngError) as e:
            png_size(b"\xff\xd8jpeg")
        assert e.value.code == "BAD_IMAGE"

    def test_validate_rejects_oversize(self):
        with pytest.raises(PngError) as e:
            validate_seal_image(b"\x89PNG\r\n\x1a\n" + b"\x00" * 10, max_bytes=5)
        assert e.value.code == "FILE_TOO_LARGE"

    def test_validate_empty(self):
        with pytest.raises(PngError) as e:
            validate_seal_image(b"")
        assert e.value.code == "EMPTY_FILE"


# ─── 翻译 ──────────────────────────────────────────────────────────────────

class TestTranslate:
    def test_build_messages_keeps_keys(self):
        msgs = build_messages({"buyer": "联佳公司", "terms": "T/T 30%"})
        assert msgs[0]["role"] == "system"
        assert "联佳公司" in msgs[1]["content"]

    def test_parse_strict_json(self):
        out = parse_translation('{"buyer": "Lianjia Co."}', {"buyer": "联佳公司", "terms": "T/T"})
        assert out["buyer"] == "Lianjia Co."
        assert out["terms"] == "T/T"  # 未翻译到的回退原值

    def test_parse_fenced_json(self):
        out = parse_translation('```json\n{"buyer": "X"}\n```', {"buyer": "甲"})
        assert out["buyer"] == "X"

    def test_parse_garbage_falls_back(self):
        out = parse_translation("not json at all", {"buyer": "甲"})
        assert out["buyer"] == "甲"
