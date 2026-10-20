"""C7：批量导入支持 .xlsx —— 纯标准库读取器 + 端点接线。

背景
----
上传侧此前显式拒绝 xlsx（`400 xlsx_not_supported`），理由是 openpyxl 依赖 C 扩展、
打不进 Cloudflare Python Workers（Pyodide）。但 xlsx 本质是「zip + XML」，
标准库 `zipfile` + `xml.etree.ElementTree` 足够把值读出来 —— 本文件用**手写的最小
xlsx**（zipfile 写 XML，不依赖 openpyxl）钉死读取器行为，再测两个导入端点。

覆盖
----
- 工作表：默认第一张 / `sheet=` 指定 / 不存在时列出可用表名；
- 单元格：sharedStrings、inlineStr、富文本 run（跳过 rPh 注音）、公式缓存字符串、
  布尔、错误值、t="d" ISO 日期、数值与空单元格占位；
- 合并单元格：区域内每格取左上角的值；
- 日期：内置 numFmtId=14 / 自定义 numFmtId=164 → ISO；纯时间格式；未知 numFmt → 数值 + warning；
- 上限与坏文件：行数超限、列数超限、非 zip、zip 里没有 workbook、老 .xls 指路；
- 回归：CSV 行为不变；xlsx 与 CSV 共用同一个 `parse_table` 字段映射；
- 端点：`/import/preview`、`/import/calculate` 对 xlsx 返回 200 且字段正确。
"""
from __future__ import annotations

import io
import json
import sys
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

from kaas_common.export_quote import (  # noqa: E402
    ImportError_,
    parse_table,
    read_xlsx,
)
from kaas_common.export_quote.importers import MAX_ROWS  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=False)

_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"

# 与 CSV 用例同一套表头（field_fence 的自由数值列 + 两个变体包）
HEADERS = ["网高(m)", "竖丝间距(cm)", "边丝径(mm)", "表面处理", "工艺"]
ROWS = [
    ["1.2", "10", "2.0", "热镀锌 40g/㎡", "无波款"],
    ["1.5", "15", "2.5", "热镀锌 200g/㎡", "波弯款"],
]


# ═════════════════════════════════════════════════════════════════════════════
# 手写最小 xlsx（zip + XML，绝不依赖 openpyxl）
# ═════════════════════════════════════════════════════════════════════════════
def _col_letters(index: int) -> str:
    """0 → A，25 → Z，26 → AA。"""
    letters = ""
    n = index + 1
    while n:
        n, rem = divmod(n - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def _xml_cell(ref: str, cell) -> str:
    """单元格 → XML。cell 支持：普通 str/数字、None（空）、以及下列元组：

    ("inline", 文本) / ("inlineRich", [片段…]) / ("rph", 正文, 注音) /
    ("str", 文本) / ("bool", True/False) / ("err", "#N/A") / ("iso", "2026-10-20") /
    ("num", 数值, 样式索引) / ("txt", 文本, 样式索引)
    """
    if isinstance(cell, tuple):
        kind = cell[0]
        if kind == "num":
            return '<c r="%s" s="%s"><v>%s</v></c>' % (ref, cell[2], cell[1])
        if kind == "txt":
            return '<c r="%s" s="%s" t="s"><v>%s</v></c>' % (ref, cell[2], cell[1])
        if kind == "inline":
            return ('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>'
                    % (ref, escape(cell[1])))
        if kind == "inlineRich":
            runs = "".join("<r><t>%s</t></r>" % escape(part) for part in cell[1])
            return '<c r="%s" t="inlineStr"><is>%s</is></c>' % (ref, runs)
        if kind == "rph":
            return (
                '<c r="%s" t="inlineStr"><is>'
                "<r><t>%s</t></r><rPh sb=\"0\" eb=\"1\"><t>%s</t></rPh>"
                "</is></c>" % (ref, escape(cell[1]), escape(cell[2]))
            )
        if kind == "str":
            return '<c r="%s" t="str"><v>%s</v></c>' % (ref, escape(cell[1]))
        if kind == "bool":
            return '<c r="%s" t="b"><v>%s</v></c>' % (ref, "1" if cell[1] else "0")
        if kind == "err":
            return '<c r="%s" t="e"><v>%s</v></c>' % (ref, escape(cell[1]))
        if kind == "iso":
            return '<c r="%s" t="d"><v>%s</v></c>' % (ref, escape(cell[1]))
        raise AssertionError("未知测试单元格类型: %r" % (kind,))
    if isinstance(cell, bool):
        return '<c r="%s" t="b"><v>%s</v></c>' % (ref, "1" if cell else "0")
    if isinstance(cell, (int, float)):
        return '<c r="%s"><v>%s</v></c>' % (ref, cell)
    raise AssertionError("字符串/空单元格请用 tuple 或 shared 辅助")  # pragma: no cover


def _shared_cell(ref: str, index: int) -> str:
    return '<c r="%s" t="s"><v>%d</v></c>' % (ref, index)


class _SheetSpec:
    """一张表的测试数据：普通字符串自动进 sharedStrings；`("raw", xml片段)` 原样塞入。"""

    def __init__(self, name: str, rows: list[list]):
        self.name = name
        self.rows = rows


def make_xlsx(
    sheets: list[_SheetSpec],
    *,
    merges: dict[str, list[str]] | None = None,
    styles_xml: str | None = None,
    date1904: bool = False,
    omit_workbook: bool = False,
) -> bytes:
    """把若干张表写成最小可解析 xlsx。字符串默认走共享字符串表。"""
    owner_of: dict[str, int] = {}
    shared: list[str] = []
    for sheet in sheets:
        for row in sheet.rows:
            for cell in row:
                if isinstance(cell, str):
                    if cell not in owner_of:
                        owner_of[cell] = len(shared)
                        shared.append(cell)

    series = []
    for index, sheet in enumerate(sheets, start=1):
        merges_for_sheet = (merges or {}).get(sheet.name, [])
        parts = [
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
            '<worksheet xmlns="%s" xmlns:r="%s">' % (_MAIN, _REL),
            "<sheetData>",
        ]
        for r_i, row in enumerate(sheet.rows, start=1):
            if not row:
                continue
            parts.append('<row r="%d">' % r_i)
            for c_i, cell in enumerate(row):
                ref = "%s%d" % (_col_letters(c_i), r_i)
                if cell is None:
                    continue
                if isinstance(cell, str):
                    parts.append(_shared_cell(ref, owner_of[cell]))
                else:
                    parts.append(_xml_cell(ref, cell))
            parts.append("</row>")
        parts.append("</sheetData>")
        if merges_for_sheet:
            parts.append('<mergeCells count="%d">' % len(merges_for_sheet))
            for ref in merges_for_sheet:
                parts.append('<mergeCell ref="%s"/>' % ref)
            parts.append("</mergeCells>")
        parts.append("</worksheet>")
        series.append("".join(parts))

    overrides = [
        '<Override PartName="/xl/workbook.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml"'
        ' ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ]
    sheet_entries = []
    workbook_rels = []
    for index in range(1, len(series) + 1):
        sheet_entries.append(
            '<sheet name="%s" sheetId="%d" r:id="rId%d"/>'
            % (escape(sheets[index - 1].name), index, index)
        )
        workbook_rels.append(
            '<Relationship Id="rId%d" Type="%s/worksheet" Target="worksheets/sheet%d.xml"/>'
            % (index, _REL, index)
        )
        overrides.append(
            '<Override PartName="/xl/worksheets/sheet%d.xml"'
            ' ContentType="application/vnd.openxmlformats-officedocument'
            '.spreadsheetml.worksheet+xml"/>' % index
        )
    if shared:
        overrides.append(
            '<Override PartName="/xl/sharedStrings.xml"'
            ' ContentType="application/vnd.openxmlformats-officedocument'
            '.spreadsheetml.sharedStrings+xml"/>'
        )

    default_styles = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="%s">'
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
        '<cellXfs count="5">'
        '<xf numFmtId="0"/>'                                  # 0 General
        '<xf numFmtId="14" applyNumberFormat="1"/>'           # 1 内置日期
        '<xf numFmtId="164" applyNumberFormat="1"/>'          # 2 自定义日期
        '<xf numFmtId="2" applyNumberFormat="1"/>'            # 3 0.00（非日期）
        '<xf numFmtId="999" applyNumberFormat="1"/>'          # 4 未定义的 numFmt
        "</cellXfs></styleSheet>" % _MAIN
    )

    files: dict[str, bytes] = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            + "".join(overrides)
            + "</Types>"
        ).encode("utf-8"),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="%s">'
            '<Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>" % (_PKG_REL, _REL)
        ).encode("utf-8"),
        "xl/styles.xml": (styles_xml or default_styles).encode("utf-8"),
    }
    if not omit_workbook:
        files["xl/workbook.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="%s" xmlns:r="%s">'
            '%s<sheets>%s</sheets></workbook>'
            % (_MAIN, _REL,
               '<workbookPr date1904="1"/>' if date1904 else "",
               "".join(sheet_entries))
        ).encode("utf-8")
        files["xl/_rels/workbook.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="%s">%s</Relationships>'
            % (_PKG_REL, "".join(workbook_rels))
        ).encode("utf-8")
        for index, xml in enumerate(series, start=1):
            files["xl/worksheets/sheet%d.xml" % index] = xml.encode("utf-8")
    if shared:
        files["xl/sharedStrings.xml"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<sst xmlns="%s" count="%d" uniqueCount="%d">%s</sst>'
            % (_MAIN, len(shared), len(shared),
               "".join("<si><t>%s</t></si>" % escape(text) for text in shared))
        ).encode("utf-8")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, payload in files.items():
            zf.writestr(name, payload)
    return buffer.getvalue()


def sheet(name: str, rows: list[list]) -> _SheetSpec:
    return _SheetSpec(name, rows)


def spec():
    from kaas_common.export_quote.products import field_fence

    return field_fence.build_spec()


# ═════════════════════════════════════════════════════════════════════════════
# 读取器：字符串 / 数值 / 空占位 / 类型
# ═════════════════════════════════════════════════════════════════════════════
class TestReaderBasics:
    def test_shared_strings_numbers_and_empty_placeholder(self):
        blob = make_xlsx([sheet("规格表", [
            ["网高(m)", None, "竖丝间距(cm)"],     # B1 缺失 → 空占位
            ["1.2", None, 10],                     # B2 缺失 → 空占位
        ])])
        grid = read_xlsx(blob)
        assert grid == [["网高(m)", "", "竖丝间距(cm)"], ["1.2", "", "10"]]

    def test_inline_strings(self):
        blob = make_xlsx([sheet("规格表", [
            [("inline", "网高(m)"), ("inline", "竖丝间距(cm)")],
            [("inline", "1.2"), ("inline", "10")],
        ])])
        assert read_xlsx(blob) == [["网高(m)", "竖丝间距(cm)"], ["1.2", "10"]]

    def test_rich_text_runs_joined_and_phonetic_skipped(self):
        blob = make_xlsx([sheet("规格表", [
            [("inlineRich", ["网", "高(m)"]), ("rph", "漢字", "かんじ")],
        ])])
        assert read_xlsx(blob) == [["网高(m)", "漢字"]]

    def test_formula_cached_string_bool_error_and_iso_date(self):
        blob = make_xlsx([sheet("规格表", [
            [("str", "=A1&A2"), ("bool", True), ("err", "#N/A"), ("iso", "2026-10-20T00:00:00Z")],
        ])])
        assert read_xlsx(blob) == [["=A1&A2", "TRUE", "#N/A", "2026-10-20T00:00:00"]]

    def test_scientific_notation_normalized(self):
        blob = make_xlsx([sheet("规格表", [[("num", "1E+2", 0), ("num", "1.200", 0)]])])
        assert read_xlsx(blob) == [["100", "1.2"]]


# ═════════════════════════════════════════════════════════════════════════════
# 读取器：工作表选择 / 合并单元格 / 日期 / 上限 / 坏文件
# ═════════════════════════════════════════════════════════════════════════════
class TestSheetsAndMerges:
    def test_default_first_sheet_and_named_sheet(self):
        blob = make_xlsx([
            sheet("规格表", [["A"], ["1"]]),
            sheet("第二张", [["B"], ["2"]]),
        ])
        assert read_xlsx(blob) == [["A"], ["1"]]
        assert read_xlsx(blob, sheet="第二张") == [["B"], ["2"]]

    def test_unknown_sheet_falls_back_to_first_with_warning(self):
        """表名拼错不静默：回退第一张（旧 openpyxl 路径的兼容语义）+ 明确 warning。"""
        warnings: list[str] = []
        blob = make_xlsx([
            sheet("规格表", [["A"], ["1"]]),
            sheet("第二张", [["B"], ["2"]]),
        ])
        assert read_xlsx(blob, sheet="不存在", warnings=warnings) == [["A"], ["1"]]
        assert any("不存在" in message and "规格表" in message for message in warnings)

    def test_merged_cells_take_top_left_value(self):
        blob = make_xlsx(
            [sheet("规格表", [
                ["尺寸", None, None, "工艺"],
                ["1.2", "10", "2.0", "无波款"],
            ])],
            merges={"规格表": ["A1:C1"]},
        )
        grid = read_xlsx(blob)
        assert grid[0] == ["尺寸", "尺寸", "尺寸", "工艺"]
        # 数据行不受影响
        assert grid[1] == ["1.2", "10", "2.0", "无波款"]

    def test_header_only_sheet_is_trimmed_to_header(self):
        blob = make_xlsx([sheet("规格表", [
            ["网高(m)", "竖丝间距(cm)"],
            [None, None],                       # Excel 里"设过格式但没填"的空行
        ])])
        assert read_xlsx(blob) == [["网高(m)", "竖丝间距(cm)"]]


class TestDates:
    def test_builtin_and_custom_date_formats_to_iso(self):
        blob = make_xlsx([sheet("规格表", [[
            ("num", 45000, 1),     # numFmtId=14 内置日期
            ("num", 45000, 2),     # numFmtId=164 自定义 yyyy-mm-dd
            ("num", 0.5, 1),       # 纯时间 12:00:00
            ("num", 45000, 3),     # numFmtId=2（0.00）不是日期
        ]])])
        assert read_xlsx(blob) == [["2023-03-15", "2023-03-15", "12:00:00", "45000"]]

    def test_unknown_numfmt_keeps_number_and_records_warning(self):
        warnings: list[str] = []
        blob = make_xlsx([sheet("规格表", [[("num", 45000, 4)]])])
        assert read_xlsx(blob, warnings=warnings) == [["45000"]]
        assert any("numFmtId=999" in message for message in warnings)

    def test_date1904_system(self):
        blob = make_xlsx([sheet("规格表", [[("num", 0, 1)]])], date1904=True)
        assert read_xlsx(blob) == [["1904-01-01"]]


class TestLimitsAndBadFiles:
    def test_row_limit(self):
        rows = [["网高(m)"]] + [[str(i)] for i in range(MAX_ROWS + 2)]
        blob = make_xlsx([sheet("规格表", rows)])
        with pytest.raises(ImportError_, match="超过上限"):
            read_xlsx(blob)

    def test_col_limit(self):
        # 造一个第 300 列（0 基 299 > MAX_COLS=256）的单元格
        xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="%s"><sheetData><row r="1">'
            '<c r="%s1"><v>1</v></c></row></sheetData></worksheet>'
            % (_MAIN, _col_letters(299))
        )
        blob = make_xlsx([sheet("规格表", [["A"]])])
        buffer = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(blob)) as src:
            files = {name: src.read(name) for name in src.namelist()}
        files["xl/worksheets/sheet1.xml"] = xml.encode("utf-8")
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            for name, payload in files.items():
                zf.writestr(name, payload)
        with pytest.raises(ImportError_, match="列数超过上限"):
            read_xlsx(buffer.getvalue())

    def test_not_a_zip(self):
        with pytest.raises(ImportError_, match="zip"):
            read_xlsx(b"this is not a spreadsheet")

    def test_zip_without_workbook_is_not_xlsx(self):
        # zip 是合法的，但里面没有 xl/workbook.xml（例如把别的 zip 改后缀）
        blob = make_xlsx([sheet("规格表", [["A"]])], omit_workbook=True)
        with pytest.raises(ImportError_, match="workbook"):
            read_xlsx(blob)

    def test_old_xls_guidance(self):
        ole2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 32
        with pytest.raises(ImportError_, match="xlsx"):
            parse_table(ole2, spec(), "old.xls")
        # 没有后缀也一样指路（按 OLE2 魔数识别）
        with pytest.raises(ImportError_, match="xlsx"):
            parse_table(ole2, spec(), "")


# ═════════════════════════════════════════════════════════════════════════════
# 与 CSV 共用 parse_table（同一套字段映射）+ 回归
# ═════════════════════════════════════════════════════════════════════════════
def xlsx_of_rows(rows: list[list] | None = None) -> bytes:
    return make_xlsx([sheet("规格表", [HEADERS] + (rows or ROWS))])


class TestParseTable:
    def test_xlsx_parsed_like_csv(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款\n"
                    "1.5,15,2.5,热镀锌 200g/㎡,波弯款\n")
        from_csv = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        from_xlsx = parse_table(xlsx_of_rows(), spec(), "a.xlsx")
        assert len(from_xlsx.rows) == len(from_csv.rows) == 2
        assert from_xlsx.rows == from_csv.rows
        assert from_xlsx.mapping == from_csv.mapping
        assert "网高(m)" in from_xlsx.mapping

    def test_xlsm_extension_accepted(self):
        table = parse_table(xlsx_of_rows(), spec(), "规格.xlsm")
        assert len(table.rows) == 2

    def test_xlsx_numeric_unknown_style_warning_and_still_usable(self):
        headers = ["网高(m)", "竖丝间距(cm)", "边丝径(mm)", "表面处理", "工艺", "备注"]
        rows = [["1.2", "10", "2.0", "热镀锌 40g/㎡", "无波款", ("num", 45000, 4)]]
        blob = make_xlsx([sheet("规格表", [headers] + rows)])
        table = parse_table(blob, spec(), "a.xlsx")
        assert len(table.rows) == 1
        warnings = [i for i in table.issues if i.severity != "error"]
        assert any("numFmtId=999" in i.message for i in warnings)
        assert "备注" in table.ignored_columns

    def test_csv_behavior_unchanged(self):
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款\n")
        table = parse_table(csv_text.encode("utf-8"), spec(), "a.csv")
        assert len(table.rows) == 1
        # xlsx 也接受同一张表（导出→改→再导入闭环的另一半）
        assert len(parse_table(xlsx_of_rows(), spec(), "a.xlsx").rows) == 2

    def test_openpyxl_export_roundtrip_through_stdlib_reader(self, tmp_path):
        """导出（openpyxl 写）→ 纯 stdlib 读 → 重算：证明读的是真 Excel 文件结构。"""
        pytest.importorskip("openpyxl")
        from datetime import date
        from decimal import Decimal as D

        from kaas_common.export_quote import QuoteRequest, build
        from kaas_common.export_quote.pricing import policy_from_dict
        from kaas_common.export_quote.products import field_fence
        from kaas_common.export_quote.report import write_xlsx

        policy = policy_from_dict({
            "input_vat_rate": D("0.10"),
            "output_vat": {"rate": D("0"), "mode": "additive"},
            "profit": {"mode": "fixed", "value": D("0.1")},
            "refund": {"refund_ratio": D("1"), "give_ratio": D("0.8")},
            "misc_fee_rate": D("0.03"),
        })
        result = build(QuoteRequest(
            product_key="field_fence",
            policy=policy,
            fx_rate=D("6.7019"),
            orders=field_fence.order_specs((30000,)),
            quote_date=date(2026, 9, 24),
        ))
        path = tmp_path / "exported.xlsx"
        write_xlsx(result, str(path))

        table = parse_table(path.read_bytes(), spec(), "exported.xlsx", sheet="内部明细")
        assert len(table.rows) == 12
        # 旧行为兼容：没有「internal」这张表时回退到第一张（内部明细），而不是报错
        fallback = parse_table(
            path.read_bytes(), spec(), "exported.xlsx", sheet="internal"
        )
        assert len(fallback.rows) == 12
        assert any(i.severity != "error" for i in fallback.issues)


# ═════════════════════════════════════════════════════════════════════════════
# 端点：preview / calculate 接受 .xlsx
# ═════════════════════════════════════════════════════════════════════════════
CUSTOMER = {
    "id": 5, "email": "buyer@qa.test", "display_name": "买家",
    "account_type": "customer", "role": "owner", "status": "active",
    "team_id": 2, "console_access": False,
}


def _as(user: dict) -> None:
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user


def _cleanup() -> None:
    worker_main.app.dependency_overrides.pop(worker_main._get_current_user, None)


def _calculate_payload() -> str:
    return json.dumps({
        "fx_rate": 6.7019,
        "orders": [{"total": 30000, "unit": "m"}],
        "quote_date": "2026-09-24",
    })


class TestImportEndpoints:
    def test_preview_accepts_xlsx(self):
        _as(CUSTOMER)
        try:
            resp = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": (
                    "规格表.xlsx", xlsx_of_rows(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )},
                data={"product_key": "field_fence"},
            )
        finally:
            _cleanup()
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["usable_rows"] == 2
        assert body["total_data_rows"] == 2
        assert body["product_key"] == "field_fence"
        assert body["mapping"]["网高(m)"] == "height_m"
        assert body["expected_columns"]

    def test_calculate_accepts_xlsx(self):
        _as(CUSTOMER)
        try:
            resp = client.post(
                "/api/v1/export-quote/import/calculate",
                files={"file": (
                    "规格表.xlsx", xlsx_of_rows(),
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                )},
                data={"product_key": "field_fence", "payload": _calculate_payload()},
            )
        finally:
            _cleanup()
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["import"]["usable_rows"] == 2
        assert body["import"]["total_data_rows"] == 2
        assert body["meta"]["product_key"] == "field_fence"
        assert len(body["customer"]["rows"]) == 2

    def test_preview_rejects_broken_xlsx_as_parse_error(self):
        _as(CUSTOMER)
        try:
            resp = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": ("坏文件.xlsx", b"PK\x03\x04broken", "application/octet-stream")},
                data={"product_key": "field_fence"},
            )
        finally:
            _cleanup()
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert detail["error"] == "parse_error"
        assert "zip" in detail["message"] or "xlsx" in detail["message"]

    def test_preview_old_xls_gives_guidance(self):
        _as(CUSTOMER)
        ole2 = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 64
        try:
            resp = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": ("旧表.xls", ole2, "application/vnd.ms-excel")},
                data={"product_key": "field_fence"},
            )
        finally:
            _cleanup()
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert detail["error"] == "parse_error"
        assert "xlsx" in detail["message"]

    def test_preview_csv_still_works(self):
        _as(CUSTOMER)
        csv_text = ("网高(m),竖丝间距(cm),边丝径(mm),表面处理,工艺\n"
                    "1.2,10,2.0,热镀锌 40g/㎡,无波款\n").encode("utf-8")
        try:
            resp = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": ("表.csv", csv_text, "text/csv")},
                data={"product_key": "field_fence"},
            )
        finally:
            _cleanup()
        assert resp.status_code == 200, resp.text
        assert resp.json()["usable_rows"] == 1

    def test_preview_honours_sheet_form_field(self):
        """`sheet=` 表单字段要真的透传到读取器（多表模板：说明表在前、数据表在后）。"""
        blob = make_xlsx([
            sheet("填写说明", [["说明"], ["只读这张会被判为没有规格列"]]),
            sheet("规格表", [HEADERS] + ROWS),
        ])
        _as(CUSTOMER)
        try:
            first = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": ("模板.xlsx", blob, "application/octet-stream")},
                data={"product_key": "field_fence"},
            )
            explicit = client.post(
                "/api/v1/export-quote/import/preview",
                files={"file": ("模板.xlsx", blob, "application/octet-stream")},
                data={"product_key": "field_fence", "sheet": "规格表"},
            )
        finally:
            _cleanup()
        # 默认读第一张（说明表）→ 认不出规格列，给出可执行提示
        assert first.status_code == 400, first.text
        assert first.json()["detail"]["error"] == "parse_error"
        # 显式指定数据表 → 正常解析
        assert explicit.status_code == 200, explicit.text
        assert explicit.json()["usable_rows"] == 2
