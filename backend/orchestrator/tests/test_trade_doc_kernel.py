"""共享内核 trade_doc 纯单测（无 DB、无三方依赖，可直接跑）。"""
from decimal import Decimal

import pytest

# 本文件是纯函数测试（无 DB、无外部服务）⇒ 必须进 `-m unit` 门禁。
# 2026-10-11 补：此前漏标，导致「单证内容边界（金额/行项不得被 custom 覆盖）」等
# 回归只有全量跑才看得见 —— 漏标的代价是门禁形同虚设。
pytestmark = pytest.mark.unit

from kaas_common.trade_doc import (
    RuleError, PngError,
    assert_draft, assert_derivable, assert_transition, can_transition,
    check_line_amount, line_amount, validate_confirm, validate_items,
    apply_scheme, compose_fields, derive_payload, resolve_scheme, scheme_names,
    format_doc_no, month_of, doc_no_prefix,
    is_png, png_size, validate_seal_image,
    build_messages, parse_translation,
    PROTECTED_CUSTOM_FIELDS, append_audit, diff_custom, protected_custom_fields,
)
from kaas_common.trade_doc.payload_shared import build_render_data


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


# ─── 手工内容（custom）的边界：受保护字段 + 审计（2026-10-11 用户裁决）─────

class TestCustomBoundary:
    """`custom` 不得覆盖金额与行项；覆盖动作要留痕。判定在共享内核，两端共用。"""

    def test_protected_fields_are_amount_and_items(self):
        assert PROTECTED_CUSTOM_FIELDS == ("items", "total_amount")

    def test_protected_custom_fields_reports_only_present_ones(self):
        assert protected_custom_fields({"total_amount": 1, "remarks": "x"}) == ["total_amount"]
        assert protected_custom_fields({"remarks": "x"}) == []
        assert protected_custom_fields(None) == []
        assert protected_custom_fields("不是字典") == []

    def test_render_data_ignores_protected_custom(self):
        """核心断言：**即便库里存着**伪造的 custom，渲染出的单据也不受它影响。"""
        data = build_render_data(
            doc_type="pi", doc_no="PI-1", doc_status="draft", currency="USD",
            total_amount=100,
            custom={"total_amount": 999999, "items": [{"product_name": "假行项"}]},
        )
        assert data["total_amount"] == 100
        assert "items" not in data

    def test_render_data_still_applies_normal_custom(self):
        data = build_render_data(
            doc_type="pi", doc_no="PI-1", doc_status="draft", currency="USD",
            total_amount=100, custom={"remarks": "1) 有效\n2) 换行"},
        )
        assert data["remarks"] == "1) 有效\n2) 换行"

    def test_diff_custom_is_field_level_and_digests_long_values(self):
        img = "data:image/png;base64," + "A" * 500
        changed = diff_custom(
            {"remarks": "旧", "company_stamp": img},
            {"remarks": "新", "company_stamp": img},
        )
        assert changed == {"remarks": {"from": "旧", "to": "新"}}
        changed2 = diff_custom({"company_stamp": img}, {"company_stamp": "data:image/png;base64,BB"})
        assert changed2["company_stamp"]["from"].startswith("<str ")

    def test_append_audit_ignores_client_supplied_audit_and_caps(self):
        prev = {"sources": {}, "custom": {"remarks": "旧"},
                "_audit": [{"at": "t0", "by": "u0", "changed": {"x": {"from": 1, "to": 2}}}]}
        forged = {"sources": {}, "custom": {"remarks": "新"},
                  "_audit": [{"at": "假", "by": "假", "changed": {}}]}
        out = append_audit(forged, previous_payload=prev, actor_id="u1",
                           before_custom={"remarks": "旧"}, after_custom={"remarks": "新"},
                           at="t1")
        assert [e["by"] for e in out["_audit"]] == ["u0", "u1"]  # 客户端那条被丢弃
        assert out["_audit"][-1]["changed"] == {"remarks": {"from": "旧", "to": "新"}}
        # 无改动不新增条目
        same = append_audit({"custom": {"remarks": "新"}}, previous_payload=out,
                            actor_id="u2", before_custom={"remarks": "新"},
                            after_custom={"remarks": "新"}, at="t2")
        assert len(same["_audit"]) == len(out["_audit"])

    def test_append_audit_caps_entries(self):
        payload = {"custom": {"n": 0}}
        for i in range(25):
            payload = append_audit({"custom": {"n": i + 1}}, previous_payload=payload,
                                   actor_id="u", before_custom={"n": i},
                                   after_custom={"n": i + 1}, at=f"t{i}")
        assert len(payload["_audit"]) == 20
