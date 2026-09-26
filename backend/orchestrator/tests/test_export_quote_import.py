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

from app.services.export_quote import (
    EngineError,
    QuoteRequest,
    RateSetRegistry,
    build,
    spec_from_partial,
)
from app.services.export_quote.importers import (
    ImportError_,
    build_template_csv,
    parse_table,
    template_headers,
)
from app.services.export_quote.pricing import policy_from_dict
from app.services.export_quote.products import field_fence

pytestmark = pytest.mark.unit

BASE = "/api/v1/export-quote"
RATE_SET = "CN-2026-09"


def spec():
    return field_fence.build_spec()


def policy():
    return policy_from_dict({
        "input_vat_rate": D("0.10"),
        "output_vat": {"rate": D("0"), "mode": "additive"},
        "profit": {"mode": "fixed", "value": D("0.1")},
        "refund": {"refund_ratio": D("1"), "give_ratio": D("0.8")},
        "stamp": {"rate": D("0.05"), "base": "profit"},
    })


def req(**kw):
    base = dict(
        product_key="field_fence",
        policy=policy(),
        fx_rate=D("6.7019"),
        orders=field_fence.order_specs((30000, 50000)),
        rate_set=RateSetRegistry.from_dir().get(RATE_SET),
        quote_date=date(2026, 9, 24),
    )
    base.update(kw)
    return QuoteRequest(**base)


ROW_A = {"de": 2.0, "inner_wire": "内丝2.0", "height_m": 1.2, "mesh_mm": 100,
         "coating": "普锌40g/㎡", "wave": "无波款"}
ROW_B = {"de": 2.5, "inner_wire": "内丝2.5", "height_m": 1.5, "mesh_mm": 150,
         "coating": "重镀锌≥200g/㎡", "wave": "波弯款"}


# ─────────────────────────────────────────────────────────────────────────────
# 引擎逐行模式
# ─────────────────────────────────────────────────────────────────────────────
class TestSpecRowsMode:
    def test_only_given_rows_are_computed(self):
        res = build(req(spec_rows=[ROW_A, ROW_B]))
        assert res.combo_count == 2
        assert res.request.skipped_spec_rows == 0

    def test_default_still_expands_all_64(self):
        assert build(req()).combo_count == 64

    def test_variant_group_pulls_its_attributes(self):
        """给内丝径就该带出内横丝径、竖丝径与卷长卷径（一选全变）；边丝径来自自己的轴。"""
        spec_ = spec_from_partial(spec(), ROW_B, 1)
        assert spec_["de"] == 2.5, "边丝径来自独立的轴"
        assert spec_["dm"] == 2.5 and spec_["dv"] == 2.5
        assert spec_["roll_len_m"] == 50
        assert spec_["roll_dia_m"] == 0.25
        assert spec_["inner_wire"] == "内丝2.5"

    def test_option_code_also_accepted(self):
        """稳定 code 与 DB 的 value_code 一致，导表里写 code 也要认。"""
        spec_ = spec_from_partial(
            spec(), {"inner_wire_code": "inner_25", "de": 2.0, "height_m": 1.2,
                     "mesh_mm": 100, "coating": "zinc_40", "wave": "no_wave"}, 1)
        assert spec_["inner_wire"] == "内丝2.5"
        assert spec_["coating"] == "普锌40g/㎡"

    def test_bad_row_is_skipped_not_fatal(self):
        res = build(req(spec_rows=[ROW_A, {"de": 2.0, "inner_wire": "不存在",
                                           "height_m": 1.2, "mesh_mm": 100,
                                           "coating": "普锌40g/㎡",
                                           "wave": "无波款"}, ROW_B]))
        assert res.combo_count == 2
        assert res.request.skipped_spec_rows == 1
        joined = " ".join(res.diagnostics)
        assert "第 2 行" in joined
        assert "内丝2.0" in joined, "错误信息要列出可选值"

    def test_missing_axis_reports_which_one(self):
        res = build(req(spec_rows=[ROW_A]))
        bad = dict(ROW_A)
        bad.pop("height_m")
        res = build(req(spec_rows=[ROW_A, bad]))
        assert res.request.skipped_spec_rows == 1
        assert any("缺少规格轴" in d for d in res.diagnostics)

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
            build(req(spec_rows=[{"de": 2.0, "inner_wire": "x", "height_m": 9,
                                  "mesh_mm": 1, "coating": "y", "wave": "z"}]))

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
        """
        with pytest.raises(EngineError, match="不在可选范围"):
            spec_from_partial(spec(), dict(ROW_A, mesh_mm="10cm"), 1)

    def test_batch_matches_single_row_computation(self):
        """批量第 1 行必须与单独传这一行算出的结果一模一样。"""
        batch = build(req(spec_rows=[ROW_A, ROW_B], orders=field_fence.order_specs((30000,))))
        single = build(req(spec_rows=[ROW_A], orders=field_fence.order_specs((30000,))))
        assert batch.rows[0].piece["price_per_piece"] == single.rows[0].piece["price_per_piece"]
        assert (batch.rows[0].orders["o30000"]["total_price"]
                == single.rows[0].orders["o30000"]["total_price"])

    def test_invariants_still_hold_in_row_mode(self):
        from app.services.export_quote import verify_all

        res = build(req(spec_rows=[ROW_A, ROW_B]))
        rep = verify_all(res)
        assert rep.ok, rep.summary()

    def test_verification_runs_on_row_mode(self):
        from app.services.export_quote import verify_invariants

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
        assert "边丝径(mm)" in labels and "内丝径" in labels
        assert "镀锌量" in labels and "工艺" in labels
        assert build_template_csv(spec()).splitlines()[0].count(",") == len(labels) - 1

    def test_parses_our_own_export_headers_with_unit_conversion(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
                    "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.mapping["竖丝间距(cm)"] == "mesh_mm"
        # 10cm 必须换算成 100mm —— 单位认错会整批算错
        assert t.rows[0]["mesh_mm"] == D("100")
        assert t.rows[0]["height_m"] == D("1.2")

    def test_mm_header_is_not_converted(self):
        csv_text = ("height_m,mesh_mm,de,inner_wire,coating,wave\n"
                    "1.2,100,2.0,内丝2.0,普锌40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.rows[0]["mesh_mm"] == D("100")

    def test_accepts_english_and_codes(self):
        csv_text = ("Net Height (m),Vertical Wire Spacing (cm),Edge Wire Dia. (mm),"
                    "Inner Wire Diameter,Zinc Coating,Wave Bend\n"
                    "1.2,10,2.0,inner_20,zinc_40,no_wave\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.rows[0]["inner_wire"] == "内丝2.0"
        assert t.rows[0]["coating"] == "普锌40g/㎡"
        assert t.rows[0]["wave"] == "无波款"

    def test_bad_value_reported_with_row_column_and_options(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
                    "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n"
                    "1.2,10,2.0,乱写的方案,普锌40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert len(t.rows) == 1
        assert len(t.errors) == 1
        err = t.errors[0]
        assert err.row == 2
        assert err.column == "内丝径"
        assert "内丝2.0" in err.message

    def test_ignored_columns_are_listed_not_fatal(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺,备注\n"
                    "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款,客户A\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert t.ignored_columns == ["备注"]
        assert len(t.rows) == 1

    def test_blank_rows_skipped(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
                    "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n"
                    ",,,,,\n"
                    "1.5,15,2.5,内丝2.5,重镀锌≥200g/㎡,波弯款\n")
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
            parse_table("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n".encode("utf-8"),
                        spec(), "a.csv")

    def test_irrelevant_columns_raise(self):
        with pytest.raises(ImportError_, match="没有识别到"):
            parse_table(b"foo,bar\n1,2\n", spec(), "a.csv")

    def test_xls_rejected_with_guidance(self):
        with pytest.raises(ImportError_, match="xlsx"):
            parse_table(b"whatever", spec(), "old.xls")

    def test_parsed_rows_feed_engine_directly(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
                    "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n")
        t = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        res = build(req(spec_rows=t.rows))
        assert res.combo_count == 1
        assert res.rows[0].derived["weight_per_piece_kg"] == D("65.4020")

    def test_roundtrip_export_then_import(self, tmp_path):
        """导出 64 行 → 读回 → 重算，逐行一致（这是本功能的核心价值）。"""
        from app.services.export_quote.report import write_xlsx

        original = build(req(orders=field_fence.order_specs((30000,))))
        path = tmp_path / "exported.xlsx"
        write_xlsx(original, str(path))
        blob = path.read_bytes()

        back = parse_table(blob, spec(), "exported.xlsx", sheet="internal")
        assert len(back.rows) == 64
        recomputed = build(req(spec_rows=back.rows,
                               orders=field_fence.order_specs((30000,))))
        assert recomputed.combo_count == 64
        for a, b in zip(original.rows, recomputed.rows):
            assert (a.piece["price_per_piece"] == b.piece["price_per_piece"])
            assert (a.derived["weight_per_piece_kg"]
                    == b.derived["weight_per_piece_kg"])

    def test_roundtrip_csv(self, tmp_path):
        from app.services.export_quote.report import write_csv

        original = build(req(orders=field_fence.order_specs((30000,))))
        path = tmp_path / "exported.csv"
        write_csv(original, str(path), view="internal")
        back = parse_table(path.read_bytes(), spec(), "exported.csv")
        assert len(back.rows) == 64


# ─────────────────────────────────────────────────────────────────────────────
# 导入接口
# ─────────────────────────────────────────────────────────────────────────────
def _payload(**kw):
    import json

    body = {
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "rate_set_code": RATE_SET,
        "quote_date": "2026-09-24",
        "policy": {
            "input_vat_rate": 0.10, "output_vat_rate": 0.0,
            "profit_mode": "fixed", "profit_value": 0.1,
            "refund_ratio": 1.0, "give_ratio": 0.8,
            "stamp_rate": 0.05, "stamp_base": "profit",
        },
    }
    body.update(kw)
    return json.dumps(body)


CSV_OK = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
          "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n"
          "1.5,15,2.5,内丝2.5,重镀锌≥200g/㎡,波弯款\n")

CSV_MIXED = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
             "1.2,10,2.0,内丝2.0,普锌40g/㎡,无波款\n"
             "1.2,10,2.0,乱写,普锌40g/㎡,无波款\n")


class TestImportApi:
    async def test_template_download(self, async_client):
        r = await async_client.get(f"{BASE}/import/template?format=csv")
        assert r.status_code == 200
        assert "text/csv" in r.headers["content-type"]
        assert "attachment" in r.headers["content-disposition"]
        assert "边丝径(mm)" in r.text
        assert "网高(m)" in r.text

    async def test_preview_reports_mapping_and_issues(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/preview",
            files={"file": ("a.csv", CSV_MIXED.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence"},
        )
        assert r.status_code == 200
        j = r.json()
        assert j["total_data_rows"] == 2
        assert j["usable_rows"] == 1
        assert j["mapping"]["边丝径(mm)"] == "de"
        assert j["mapping"]["内丝径"] == "inner_wire"
        assert j["issues"][0]["row"] == 2
        assert j["expected_columns"]

    async def test_calculate_batch(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": _payload(),
                  "view": "customer"},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["import"]["usable_rows"] == 2
        assert j["import"]["skipped_rows"] == 0
        assert j["spec_rows"] == {"submitted": 2, "computed": 2, "skipped": 0}
        header = j["customer"]["header"]
        idx = {h: k for k, h in enumerate(header)}
        assert len(j["customer"]["rows"]) == 2
        # 与手工核对值一致
        assert j["customer"]["rows"][0][idx["单卷售价(元/卷)"]] == 301.03

    async def test_batch_hides_cost_columns(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": _payload()},
        )
        header = r.json()["customer"]["header"]
        for word in ("税前成本", "加工利润", "进项税额", "让利"):
            assert not any(word in h for h in header)

    async def test_bad_rows_do_not_fail_the_batch(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", CSV_MIXED.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": _payload()},
        )
        assert r.status_code == 200
        j = r.json()
        assert j["import"]["usable_rows"] == 1
        assert j["import"]["skipped_rows"] == 1
        assert j["import"]["issues"][0]["column"] == "内丝径"

    async def test_internal_view_needs_admin(self, async_client):
        files = {"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")}
        r = await async_client.post(
            f"{BASE}/import/calculate", files=files,
            data={"product_key": "field_fence", "payload": _payload(),
                  "view": "internal"},
        )
        assert r.status_code == 403

    async def test_internal_view_for_admin(self, async_client):
        files = {"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")}
        r = await async_client.post(
            f"{BASE}/import/calculate", files=files,
            data={"product_key": "field_fence", "payload": _payload(),
                  "view": "internal"},
            headers={"X-Test-Role": "admin"},
        )
        assert r.status_code == 200
        assert "internal" in r.json()

    async def test_empty_file_rejected(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/preview",
            files={"file": ("a.csv", b"", "text/csv")},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "empty_file"

    async def test_bad_payload_rejected(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": "{not json"},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "bad_payload"

    async def test_bad_view_rejected(self, async_client):
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", CSV_OK.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": _payload(),
                  "view": "nope"},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "bad_view"

    async def test_no_usable_rows_returns_issues(self, async_client):
        csv_bad = ("网高(m),竖丝间距(cm),边丝径(mm),内丝径,镀锌量,工艺\n"
                   "1.2,10,乱写,乱写,普锌40g/㎡,无波款\n")
        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("a.csv", csv_bad.encode("utf-8"), "text/csv")},
            data={"product_key": "field_fence", "payload": _payload()},
        )
        assert r.status_code == 400
        assert r.json()["detail"]["error"] == "no_usable_rows"
        assert r.json()["detail"]["issues"]

    async def test_upload_our_own_export_endpoint_closed_loop(self, async_client):
        """走接口的闭环：导出 → 上传 → 重算，结果一致。"""
        import io as _io
        import os
        import tempfile

        from app.services.export_quote.report import write_xlsx

        res = build(req(orders=field_fence.order_specs((30000,))))
        tmp = os.path.join(tempfile.gettempdir(), "api_roundtrip.xlsx")
        write_xlsx(res, tmp)
        with _io.open(tmp, "rb") as fh:
            blob = fh.read()
        os.remove(tmp)

        r = await async_client.post(
            f"{BASE}/import/calculate",
            files={"file": ("exported.xlsx", blob,
                            "application/vnd.openxmlformats-officedocument"
                            ".spreadsheetml.sheet")},
            data={"product_key": "field_fence", "payload": _payload(),
                  "sheet": "internal", "view": "internal"},
            headers={"X-Test-Role": "admin"},
        )
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["import"]["usable_rows"] == 64
        ih = j["internal"]["header"]
        idx = {h: k for k, h in enumerate(ih)}
        got = [x[idx["单卷售价(元/卷)"]] for x in j["internal"]["rows"]]
        want = [x.piece["price_per_piece"] for x in res.rows]
        # Decimal → float 比较
        assert len(got) == len(want) == 64
        assert all(abs(float(g) - float(w)) < 1e-9 for g, w in zip(got, want))
