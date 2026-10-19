from __future__ import annotations

import sys
from pathlib import Path

# S4（2026-10-19）：报价引擎真源已迁到 backend/kaas_common/export_quote；
# 本文件从 orchestrator 测试迁来，仅重定向 import，断言不变。
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

"""批量导入测试：引擎逐行模式 + 表格解析 + 导入接口。

锁定的事实：
  · 给了 spec_rows 就**只算那些行**，不再展开 64 个组合
  · 一行坏**不拖垮整批**：好行照算，坏行要报出「第几行/哪一列/什么值/期望什么」
  · 认得出我们自己导出的表头（中/英/内部字段三种写法），且**单位随表头走**
    （竖丝间距(cm)=10 → 100mm；mesh_mm=100 → 保持 100）
  · 重复行会被跳过而不是算两遍
  · 导入结果与逐条输入的结果必须一致（这是「批量」可信的前提）
  · 闭环：导出 → 上传 → 重算，结果与原文件完全一致
"""
from datetime import date
from decimal import Decimal as D

import pytest

from kaas_common.export_quote import (
    EngineError,
    QuoteRequest,
    build,
    spec_from_partial,
)
from kaas_common.export_quote.importers import (
    ImportError_,
    build_template_csv,
    parse_table,
    template_headers,
)
from kaas_common.export_quote.pricing import policy_from_dict
from kaas_common.export_quote.products import field_fence

pytestmark = pytest.mark.unit

BASE = "/api/v1/export-quote"


def spec():
    return field_fence.build_spec()


def policy():
    return policy_from_dict({
        "input_vat_rate": D("0.10"),
        "output_vat": {"rate": D("0"), "mode": "additive"},
        "profit": {"mode": "fixed", "value": D("0.1")},
        "refund": {"refund_ratio": D("1"), "give_ratio": D("0.8")},
        # 印花税已并入杂税（misc_fee_rate，对齐平台默认 0.03）
        "misc_fee_rate": D("0.03"),
    })


def req(**kw):
    base = dict(
        product_key="field_fence",
        policy=policy(),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        quote_date=date(2026, 9, 24),
    )
    base.update(kw)
    return QuoteRequest(**base)


# 尺寸类是**自由数值**（2026-10-11 裁决：没有"丝径方案"），逐行给出实际值。
ROW_A = {"de": 2.0, "dm": 2.0, "dv": 2.0, "roll_len_m": 100, "roll_dia_m": 0.30,
         "height_m": 1.2, "mesh_mm": 100,
         "coating": "热镀锌 40g/㎡", "wave": "无波款"}
ROW_B = {"de": 2.5, "dm": 2.5, "dv": 2.5, "roll_len_m": 50, "roll_dia_m": 0.25,
         "height_m": 1.5, "mesh_mm": 150,
         "coating": "热镀锌 200g/㎡", "wave": "波弯款"}


# ─────────────────────────────────────────────────────────────────────────────
# 引擎逐行模式
# ─────────────────────────────────────────────────────────────────────────────
class TestSpecRowsMode:
    def test_only_given_rows_are_computed(self):
        res = build(req(spec_rows=[ROW_A, ROW_B]))
        assert res.combo_count == 2
        assert res.request.skipped_spec_rows == 0

    def test_default_still_expands_all_combos(self):
        # 尺寸类不进笛卡尔积，只剩 表面处理 5 × 工艺 2
        assert build(req()).combo_count == 12

    def test_numerics_are_used_as_given(self):
        """尺寸类是**自由数值**：给什么就用什么，引擎不查表、不联动。"""
        spec_ = spec_from_partial(spec(), ROW_B, 1)
        assert D(str(spec_["de"])) == D("2.5")
        assert D(str(spec_["dm"])) == D("2.5") and D(str(spec_["dv"])) == D("2.5")
        assert D(str(spec_["roll_len_m"])) == D("50")
        assert D(str(spec_["roll_dia_m"])) == D("0.25")

    def test_variant_group_still_pulls_its_attributes(self):
        """可枚举的（表面处理）仍然"一选全变"：带出 raw_price 与锌层克重。"""
        spec_ = spec_from_partial(spec(), ROW_A, 1)
        assert spec_["coating"] == "热镀锌 40g/㎡"
        assert spec_["coating_code"] == "zinc_40"
        assert D(str(spec_["raw_price"])) == D("4.4")
        assert spec_["zinc_g_m2"] == 40

    def test_option_code_also_accepted(self):
        """稳定 code 与 DB 的 value_code 一致，导表里写 code 也要认。"""
        spec_ = spec_from_partial(
            spec(), {"de": 2.0, "height_m": 1.2,
                     "mesh_mm": 100, "coating": "zinc_40", "wave": "no_wave"}, 1)
        assert spec_["coating"] == "热镀锌 40g/㎡"

    def test_bad_row_is_skipped_not_fatal(self):
        res = build(req(spec_rows=[ROW_A, {"de": 2.0,
                                           "height_m": 1.2, "mesh_mm": 100,
                                           "coating": "不存在的表面处理",
                                           "wave": "无波款"}, ROW_B]))
        assert res.combo_count == 2
        assert res.request.skipped_spec_rows == 1
        joined = " ".join(res.diagnostics)
        assert "第 2 行" in joined
        assert "热镀锌 40g/㎡" in joined, "错误信息要列出可选值"

    def test_out_of_range_numeric_reports_which_field(self):
        """自由数值也要挡住明显填错的（上下界），并说清是哪一项。"""
        res = build(req(spec_rows=[ROW_A, dict(ROW_A, height_m=99)]))
        assert res.request.skipped_spec_rows == 1
        assert any("网高" in d and "上界" in d for d in res.diagnostics)

    def test_unknown_field_reports_available_fields(self):
        bad = dict(ROW_A, 不存在的字段=123)
        res = build(req(spec_rows=[ROW_A, bad]))
        assert res.request.skipped_spec_rows == 1
        assert any("无法识别的规格字段" in d for d in res.diagnostics)

    def test_duplicate_rows_skipped(self):
        res = build(req(spec_rows=[ROW_A, dict(ROW_A)]))
        assert res.combo_count == 1
        assert res.request.skipped_spec_rows == 1
        assert any("重复" in d for d in res.diagnostics)

    def test_all_rows_bad_raises_clearly(self):
        with pytest.raises(EngineError, match="全部无法解析"):
            build(req(spec_rows=[{"de": "很粗", "coating": "y", "wave": "z"}]))

    def test_numeric_axis_tolerates_matching_unit_suffix(self):
        """同单位的后缀可以容忍：1.2m ↔ 1.2（轴本身就是米）。"""
        spec_ = spec_from_partial(spec(), dict(ROW_A, height_m="1.2m"), 1)
        assert D(str(spec_["height_m"])) == D("1.2")
        spec_ = spec_from_partial(spec(), dict(ROW_A, mesh_mm="100mm"), 1)
        assert D(str(spec_["mesh_mm"])) == D("100")

    def test_engine_does_not_cross_convert_units(self):
        """**不跨单位换算**是刻意的安全性质，不是缺陷。

        轴 `mesh_mm` 的单位是毫米；写 "10cm" 若被当成 10 就差了十倍。
        换算是导入器的职责（它按表头单位换算，已单独测过），
        引擎只认声明单位下的取值，避免两处都换算导致双重折算。

        只容忍**与声明单位一致**的后缀（"1.2m" 之于 unit="m"），
        不是无脑 strip 掉尾部字母 —— 那样 "10cm" 会被当成 10mm。
        """
        with pytest.raises(EngineError, match="单位与声明"):
            spec_from_partial(spec(), dict(ROW_A, mesh_mm="10cm"), 1)
        # 与声明单位一致的后缀仍然容忍
        assert D(str(spec_from_partial(
            spec(), dict(ROW_A, mesh_mm="100mm"), 1)["mesh_mm"])) == D("100")

    def test_batch_matches_single_row_computation(self):
        """批量第 1 行必须与单独传这一行算出的结果一模一样。"""
        batch = build(req(spec_rows=[ROW_A, ROW_B], orders=field_fence.order_specs((30000,))))
        single = build(req(spec_rows=[ROW_A], orders=field_fence.order_specs((30000,))))
        assert batch.rows[0].piece["price_per_piece"] == single.rows[0].piece["price_per_piece"]
        assert (batch.rows[0].orders["o30000"]["total_price"]
                == single.rows[0].orders["o30000"]["total_price"])

    def test_invariants_still_hold_in_row_mode(self):
        from kaas_common.export_quote import verify_all

        res = build(req(spec_rows=[ROW_A, ROW_B]))
        rep = verify_all(res)
        assert rep.ok, rep.summary()

    def test_verification_runs_on_row_mode(self):
        from kaas_common.export_quote import verify_invariants

        res = build(req(spec_rows=[ROW_A, ROW_B]))
        rep = verify_invariants(res)
        assert rep.ok, rep.summary()
        assert rep.checks >= 2 * 20


# ─────────────────────────────────────────────────────────────────────────────
# 表格解析
# ─────────────────────────────────────────────────────────────────────────────
class TestImporter:
    def test_template_headers_use_export_labels(self):
        labels = template_headers(spec())
        assert "边丝径(mm)" in labels and "内横丝径(mm)" in labels
        assert "表面处理" in labels and "工艺" in labels
        assert build_template_csv(spec()).splitlines()[0].count(",") == len(labels) - 1

    def test_parses_our_own_export_headers_with_unit_conversion(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内横丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,2.5,热镀锌 40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.mapping["竖丝间距(cm)"] == "mesh_mm"
        # 10cm 必须换算成 100mm —— 单位认错会整批算错
        assert t.rows[0]["mesh_mm"] == D("100")
        assert t.rows[0]["height_m"] == D("1.2")
        # 自由数值不做枚举校验：2.5 直接进来
        assert t.rows[0]["dm"] == D("2.5")

    def test_mm_header_is_not_converted(self):
        csv_text = ("height_m,mesh_mm,de,dm,coating,wave\n"
                    "1.2,100,2.0,2.3,热镀锌 40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.rows[0]["mesh_mm"] == D("100")
        assert t.rows[0]["dm"] == D("2.3")

    def test_accepts_english_and_codes(self):
        csv_text = ("Net Height (m),Vertical Wire Spacing (cm),Edge Wire Dia. (mm),"
                    "Inner Horizontal Wire Dia. (mm),Zinc Coating,Wave Bend\n"
                    "1.2,10,2.0,2.0,zinc_40,no_wave\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.rows[0]["dm"] == D("2.0")
        assert t.rows[0]["coating"] == "热镀锌 40g/㎡"
        assert t.rows[0]["wave"] == "无波款"

    def test_bad_value_reported_with_row_column_and_options(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款\n"
                    "1.2,10,2.0,乱写的表面处理,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert len(t.rows) == 1
        assert len(t.errors) == 1
        err = t.errors[0]
        assert err.row == 2
        assert err.column == "表面处理"
        assert "热镀锌 40g/㎡" in err.message

    def test_ignored_columns_are_listed_not_fatal(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺,备注\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款,客户A\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.ignored_columns == ["备注"]
        assert len(t.rows) == 1

    def test_blank_rows_skipped(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款\n"
                    ",,,,\n"
                    "1.5,15,2.5,热镀锌 200g/㎡,波弯款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.total_data_rows == 2
        assert len(t.rows) == 2

    def test_missing_variant_column_is_flagged(self):
        csv_text = "网高(m),竖丝间距(cm)\n1.2,10\n"
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert any("工艺" in i.message for i in t.errors + t.warnings)

    def test_empty_file_raises(self):
        with pytest.raises(ImportError_, match="空"):
            parse_table(b"", spec(), "a.csv")

    def test_header_only_raises(self):
        with pytest.raises(ImportError_, match="没有数据行"):
            parse_table("网高(m),竖丝间距(cm),边丝径(mm),内丝径,表面处理,工艺\n".encode("utf-8"),
                        spec(), "a.csv")

    def test_irrelevant_columns_raise(self):
        with pytest.raises(ImportError_, match="没有识别到"):
            parse_table(b"foo,bar\n1,2\n", spec(), "a.csv")

    def test_xls_rejected_with_guidance(self):
        with pytest.raises(ImportError_, match="xlsx"):
            parse_table(b"whatever", spec(), "old.xls")

    def test_parsed_rows_feed_engine_directly(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,表面处理,工艺\n"
                    "1.2,10,2.0,内丝2.0,热镀锌 40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        res = build(req(spec_rows=t.rows))
        assert res.combo_count == 1
        assert res.rows[0].derived["weight_per_piece_kg"] == D("65.4020")

    def test_roundtrip_export_then_import(self, tmp_path):
        """导出全部枚举组合 → 读回 → 重算，逐行一致（这是本功能的核心价值）。"""
        from kaas_common.export_quote.report import write_xlsx

        original = build(req(orders=field_fence.order_specs((30000,))))
        path = tmp_path / "exported.xlsx"
        write_xlsx(original, str(path))
        blob = path.read_bytes()

        back = parse_table(blob, spec(), "exported.xlsx", sheet="internal")
        assert len(back.rows) == 12
        recomputed = build(req(spec_rows=back.rows,
                               orders=field_fence.order_specs((30000,))))
        assert recomputed.combo_count == 12
        for a, b in zip(original.rows, recomputed.rows):
            assert (a.piece["price_per_piece"] == b.piece["price_per_piece"])
            assert (a.derived["weight_per_piece_kg"]
                    == b.derived["weight_per_piece_kg"])

    def test_roundtrip_csv(self, tmp_path):
        from kaas_common.export_quote.report import write_csv

        original = build(req(orders=field_fence.order_specs((30000,))))
        path = tmp_path / "exported.csv"
        write_csv(original, str(path), view="internal")
        back = parse_table(path.read_bytes(), spec(), "exported.csv")
        assert len(back.rows) == 12


# ─────────────────────────────────────────────────────────────────────────────
# 导入接口
# ─────────────────────────────────────────────────────────────────────────────
def _payload(**kw):
    import json

    body = {
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
        "policy": {
            "input_vat_rate": 0.10, "output_vat_rate": 0.0,
            "profit_mode": "fixed", "profit_value": 0.1,
            "refund_ratio": 1.0, "give_ratio": 0.8,
            # 印花税已并入杂税：不传 stamp_*（传了也会被忽略），用平台默认 misc 0.03
        },
    }
    body.update(kw)
    return json.dumps(body)


# 尺寸类是自由数值列（不是「丝径方案」下拉）
CSV_OK = ("网高(m),竖丝间距(cm),边丝径(mm),内横丝径(mm),竖丝径(mm),表面处理,工艺\n"
          "1.2,10,2.0,2.0,2.0,热镀锌 40g/㎡,无波款\n"
          "1.5,15,2.5,2.5,2.5,热镀锌 200g/㎡,波弯款\n")

CSV_MIXED = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
             "1.2,10,2.0,热镀锌 40g/㎡,无波款\n"
             "1.2,10,2.0,乱写,无波款\n")



# S4：原 API 级用例依赖已删除的 orchestrator export_quote API 模块；
# worker 侧同一批端点行为由 tests/test_parity_quote.py 覆盖（Q1–Q26）。
