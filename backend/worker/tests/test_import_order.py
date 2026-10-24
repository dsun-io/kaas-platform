"""R-D 整单批量导入（2026-10-23）—— 内核解析 + Worker 端点。

钉死的口径（见 shared/contracts/export-quote.ts「整单批量导入」段）：
  · 单表 + 产品列：一行 = 订单里的一个产品行，规格列 = 各产品模板列的并集；
  · 每行**先按产品列定位产品**，再用该产品自己的列映射解析规格（复用单产品表头识别）；
  · 坏行不阻断其它行：行照返回，row_errors 说明原因；warning 只进 issues；
  · 公共列：产品 / 件数（卷）/ 成本 必填；成本口径 / 包装方式 / 本行利润率 可选；
  · 返回的 JSON 形状必须逐字段对上契约（含默认值），前端直接填入报价工作台。
"""
from __future__ import annotations

import csv
import io
import sys
from contextlib import contextmanager
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import pytest  # noqa: E402

from kaas_common.export_quote import product_keys  # noqa: E402
from kaas_common.export_quote.importers import (  # noqa: E402
    ImportError_,
    order_template_columns,
    order_template_headers,
    parse_order_table,
    template_headers,
)
from kaas_common.export_quote.products import get as get_product  # noqa: E402

pytestmark = pytest.mark.unit

COMMON_HEADERS = [
    "产品",
    "件数（卷）",
    "成本",
    "成本口径（含税/不含税）",
    "包装方式",
    "本行利润率（%）",
]

PREVIEW_KEYS = {
    "source_name", "sheet", "total_data_rows", "usable_rows", "error_count",
    "warning_count", "products", "mapping", "ignored_columns", "issues",
    "rows", "expected_columns",
}

TEMPLATE_INFO_KEYS = {
    "product_keys", "headers", "columns", "max_rows", "max_mb",
    "data_sheet", "notes",
}


# ── 夹具 ────────────────────────────────────────────────────────────────────

def products():
    return [get_product(k) for k in ("field_fence", "chain_link", "deer_net")]


def field_fence():
    return get_product("field_fence")


def headers_of(specs=None):
    return order_template_headers(specs if specs is not None else products())


def api_products():
    """端点里的产品顺序 = 注册表 key 排序（_quotable_specs 的插入顺序）。"""
    return [get_product(k) for k in sorted(product_keys())]


def make_csv(rows, headers=None):
    """行是 dict：只写该行出现的列，其余留空（模拟真实整单表）。"""
    hs = headers if headers is not None else headers_of()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(hs)
    for row in rows:
        writer.writerow([row.get(h, "") for h in hs])
    return buf.getvalue().encode("utf-8")


def parse(rows, specs=None, headers=None, filename="整单表.csv"):
    specs = specs if specs is not None else products()
    hs = headers if headers is not None else headers_of(specs)
    return parse_order_table(make_csv(rows, hs), specs, filename)


def complete_field_row(**over):
    """牛栏网一行完整规格（避免"缺变体"噪声影响别的断言）。"""
    row = {
        "产品": "牛栏网",
        "件数（卷）": "2",
        "成本": "5.5",
        "网高(m)": "1.2",
        "竖丝间距(cm)": "10",
        "表面处理": "热镀锌 40g/㎡",
        "工艺": "无波款",
    }
    row.update(over)
    return row


# ═════════════════════════════════════════════════════════════════════════════
# 模板列 = 公共列 + 各产品模板列并集
# ═════════════════════════════════════════════════════════════════════════════

class TestOrderTemplateColumns:
    def test_common_columns_fixed_order(self):
        cols = order_template_columns(products())
        assert [c.header for c in cols if c.kind == "common"] == COMMON_HEADERS
        # 公共列必须排在最前（前端模板按 columns 顺序写表头）
        assert [c.header for c in cols[:len(COMMON_HEADERS)]] == COMMON_HEADERS
        assert all(not c.products for c in cols if c.kind == "common")

    def test_spec_columns_are_union_in_product_order(self):
        specs = products()
        expected = []
        for spec in specs:
            for header in template_headers(spec):
                if header not in expected:
                    expected.append(header)
        cols = order_template_columns(specs)
        assert [c.header for c in cols if c.kind == "spec"] == expected
        assert order_template_headers(specs) == [c.header for c in cols]

    def test_column_declares_applicable_products(self):
        by_header = {c.header: c for c in order_template_columns(products())}
        # 牛栏网独有
        assert by_header["网高(m)"].products == ["牛栏网"]
        assert by_header["网高(m)"].unit == "m"
        # 三家共用
        assert set(by_header["表面处理"].products) == {"牛栏网", "勾花网", "鹿网"}
        # 同名字列：按产品名列出
        assert by_header["丝径/线径(mm)"].products == ["勾花网"]
        assert by_header["件数（卷）"].kind == "common"

    def test_cost_basis_options_are_chinese_aliases(self):
        by_header = {c.header: c for c in order_template_columns(products())}
        assert by_header["成本口径（含税/不含税）"].options == ["不含税", "含税"]

    def test_packaging_options_union(self):
        pkg_a = {"id": "pkg-a", "name": "编织袋", "method": "编织袋", "is_default": True}
        pkg_b = {"id": "pkg-b", "name": "木箱", "method": "木箱"}
        custom = [replace(field_fence(), packaging=[pkg_a, pkg_b])]
        by_header = {c.header: c for c in order_template_columns(custom)}
        assert by_header["包装方式"].options == ["编织袋", "木箱"]

    def test_empty_product_list_has_only_common_columns(self):
        assert order_template_headers([]) == COMMON_HEADERS


# ═════════════════════════════════════════════════════════════════════════════
# 多产品单表解析
# ═════════════════════════════════════════════════════════════════════════════

class TestParseMultiProductRows:
    def test_three_products_in_one_table(self):
        result = parse([
            complete_field_row(),
            {
                "产品": "勾花网", "件数（卷）": "3", "成本": "12",
                "丝径/线径(mm)": "2.5", "网孔/刺尖间距(cm)": "5", "宽度(m)": "1.8",
            },
            {
                "产品": "deer_net", "件数（卷）": "1", "成本": "30",
                "边丝直径(mm)": "2.5", "横丝根数": "10", "单件长度(m)": "100",
            },
        ])
        body = result.to_dict()
        assert set(body) == PREVIEW_KEYS
        assert body["total_data_rows"] == 3
        assert body["usable_rows"] == 3
        assert body["error_count"] == 0
        assert body["warning_count"] == 0
        assert body["sheet"] == "CSV"
        assert [p["product_key"] for p in body["products"]] == [
            "field_fence", "chain_link", "deer_net"]
        assert all(p["rows"] == 1 for p in body["products"])

        rows = body["rows"]
        assert [r["product_key"] for r in rows] == [
            "field_fence", "chain_link", "deer_net"]
        assert [r["row"] for r in rows] == [1, 2, 3]
        # 公共字段
        assert rows[0]["pieces"] == 2
        assert rows[0]["cost"] == 5.5
        assert rows[0]["cost_basis"] == "pretax"
        assert rows[0]["packaging_method"] is None
        assert rows[0]["packaging_id"] is None
        assert rows[0]["profit_pct"] is None
        assert rows[0]["row_errors"] == []
        # 规格：单位随表头走（竖丝间距(cm)=10 → 内部 100mm）
        assert rows[0]["spec"]["height_m"] == Decimal("1.2")
        assert rows[0]["spec"]["mesh_mm"] == Decimal("100")
        assert rows[0]["spec"]["coating"] == "热镀锌 40g/㎡"
        assert rows[0]["spec"]["wave"] == "无波款"
        # 没填的自由数值用产品默认值补齐（返回的行是完整规格）
        assert rows[0]["spec"]["de"] == Decimal("2.0")
        assert rows[0]["spec"]["roll_len_m"] == Decimal("100")
        # 勾花网 / 鹿网各自的字段
        assert rows[1]["spec"]["mesh_cm"] == Decimal("5")
        assert rows[1]["spec"]["width_m"] == Decimal("1.8")
        assert rows[2]["spec"]["height_m"] == Decimal("1.5")  # 默认值
        assert rows[2]["spec"]["roll_len_m"] == Decimal("100")
        assert rows[2]["spec"]["n"] == Decimal("10")

    def test_mapping_and_expected_columns(self):
        body = parse([complete_field_row()]).to_dict()
        assert body["expected_columns"] == headers_of()
        assert body["mapping"]["产品"] == "产品"
        assert body["mapping"]["件数（卷）"] == "件数"
        assert body["mapping"]["成本口径（含税/不含税）"] == "成本口径"
        assert body["mapping"]["竖丝间距(cm)"] == "规格:mesh_mm"
        assert body["mapping"]["表面处理"] == "规格:coating"
        assert body["ignored_columns"] == []

    def test_product_matched_by_key_or_name(self):
        body = parse([
            complete_field_row(**{"产品": "field_fence"}),
            complete_field_row(**{"产品": "牛栏网"}),
        ]).to_dict()
        assert body["error_count"] == 0
        assert [r["product_key"] for r in body["rows"]] == ["field_fence", "field_fence"]
        assert [r["product_name"] for r in body["rows"]] == ["牛栏网", "牛栏网"]

    def test_alias_header_is_still_recognised(self):
        """不是模板表头的别名列（「网高」）也能按产品认出来 —— 复用单产品别名表。"""
        hs = ["网高" if h == "网高(m)" else h for h in headers_of()]
        body = parse(
            [{"产品": "牛栏网", "件数（卷）": "1", "成本": "3",
              "网高": "1.5", "表面处理": "热镀锌 40g/㎡", "工艺": "无波款"}],
            headers=hs,
        ).to_dict()
        assert body["error_count"] == 0
        assert body["rows"][0]["spec"]["height_m"] == Decimal("1.5")

    def test_other_product_column_value_is_ignored_with_warning(self):
        """填了别的产品的规格列：不阻断，但必须提示"已忽略"。"""
        body = parse([complete_field_row(**{"丝径/线径(mm)": "2.5"})]).to_dict()
        assert body["error_count"] == 0
        assert body["warning_count"] == 1
        assert "不适用于产品" in body["issues"][0]["message"]
        assert body["issues"][0]["row"] == 1
        assert "d" not in body["rows"][0]["spec"]
        assert body["rows"][0]["row_errors"] == []


# ═════════════════════════════════════════════════════════════════════════════
# 行级校验：坏行不阻断其它行
# ═════════════════════════════════════════════════════════════════════════════

class TestRowLevelErrors:
    def test_unknown_product_is_row_error(self):
        body = parse([
            complete_field_row(),
            {"产品": "不存在产品", "件数（卷）": "1", "成本": "1"},
        ]).to_dict()
        assert body["total_data_rows"] == 2
        assert body["usable_rows"] == 1
        assert body["error_count"] == 1
        issue = body["issues"][0]
        assert (issue["row"], issue["column"], issue["severity"]) == (2, "产品", "error")
        assert "未识别的产品" in issue["message"]
        assert body["rows"][1]["row_errors"]  # 该行仍返回，但标记不可用

    def test_missing_required_values(self):
        body = parse([
            complete_field_row(**{"件数（卷）": ""}),
            complete_field_row(**{"成本": ""}),
            complete_field_row(**{"成本": "abc"}),
            complete_field_row(**{"件数（卷）": "-2"}),
        ]).to_dict()
        assert body["usable_rows"] == 0
        by_row = {i["row"]: i for i in body["issues"] if i["severity"] == "error"}
        assert set(by_row) == {1, 2, 3, 4}
        assert "缺少「件数（卷）」" in by_row[1]["message"]
        assert "缺少「成本」" in by_row[2]["message"]
        assert "不是数字" in by_row[3]["message"]
        assert "必须大于 0" in by_row[4]["message"]

    def test_missing_required_column_raises_whole_table_error(self):
        hs = [h for h in headers_of() if h != "成本"]
        with pytest.raises(ImportError_) as exc:
            parse([complete_field_row()], headers=hs)
        assert "缺少必需列" in str(exc.value)
        assert "成本" in str(exc.value)

    def test_numeric_out_of_range(self):
        body = parse([
            complete_field_row(**{"网高(m)": "5"}),        # 牛栏网上限 3
            complete_field_row(**{"边丝径(mm)": "0.1"}),   # 下限 0.3
        ]).to_dict()
        assert body["usable_rows"] == 0
        messages = [i["message"] for i in body["issues"] if i["severity"] == "error"]
        assert any("大于上界" in m for m in messages)
        assert any("小于下界" in m for m in messages)

    def test_cost_basis_column(self):
        body = parse([
            complete_field_row(**{"成本口径（含税/不含税）": "含税"}),
            complete_field_row(**{"成本口径（含税/不含税）": "不含税"}),
            complete_field_row(),
            complete_field_row(**{"成本口径（含税/不含税）": "随便写"}),
        ]).to_dict()
        assert body["rows"][0]["cost_basis"] == "incl_tax"
        assert body["rows"][1]["cost_basis"] == "pretax"
        assert body["rows"][2]["cost_basis"] == "pretax"  # 默认值
        assert body["rows"][3]["row_errors"]
        assert body["usable_rows"] == 3

    def test_profit_pct_column(self):
        body = parse([
            complete_field_row(**{"本行利润率（%）": "8.5"}),
            complete_field_row(),
        ]).to_dict()
        assert body["rows"][0]["profit_pct"] == 8.5
        assert body["rows"][1]["profit_pct"] is None

    def test_variant_package_required_per_row(self):
        body = parse([
            complete_field_row(),
            complete_field_row(**{"表面处理": "", "工艺": ""}),
        ]).to_dict()
        assert body["usable_rows"] == 1
        assert body["error_count"] == 2
        columns = {i["column"] for i in body["issues"] if i["severity"] == "error"}
        assert columns == {"表面处理", "工艺"}
        assert body["rows"][1]["row_errors"]

    def test_duplicate_rows_warn_but_stay_usable(self):
        body = parse([complete_field_row(), complete_field_row()]).to_dict()
        assert body["usable_rows"] == 2
        assert body["error_count"] == 0
        assert body["warning_count"] == 1
        assert "重复" in body["issues"][0]["message"]
        assert body["issues"][0]["row"] == 2

    def test_non_applicable_column_different_units_not_accepted(self):
        """「网孔/刺尖间距(cm)」是勾花网的列，鹿网只能用 (mm) 列 —— 不能被跨产品认领。

        跨产品认领会把 15cm 当 15mm 收下（差十倍且静默），所以这里断言：
        鹿网行填 (cm) 列 → 值被忽略（warning），(mm) 列才是它的落点。
        """
        body = parse([
            {"产品": "鹿网", "件数（卷）": "1", "成本": "30",
             "网孔/刺尖间距(cm)": "15", "网孔/刺尖间距(mm)": "150"},
        ]).to_dict()
        assert body["error_count"] == 0
        assert body["rows"][0]["spec"]["mesh_mm"] == Decimal("150")
        assert body["warning_count"] == 1
        assert "不适用于产品" in body["issues"][0]["message"]

    def test_empty_table_and_header_only_raise(self):
        with pytest.raises(ImportError_):
            parse_order_table(b"", products(), "empty.csv")
        with pytest.raises(ImportError_) as exc:
            parse_order_table(make_csv([]), products(), "header-only.csv")
        assert "没有数据行" in str(exc.value)


# ═════════════════════════════════════════════════════════════════════════════
# 包装方式 → packaging_id（Lead 2026-10-24 契约微调）
# ═════════════════════════════════════════════════════════════════════════════

PKG_BAG = {"id": "pkg-a", "name": "编织袋", "method": "编织袋", "is_default": True}
PKG_BOX = {"id": "pkg-b", "name": "木箱", "method": "木箱", "is_default": False}


class TestPackagingColumn:
    def _custom(self):
        return [replace(field_fence(), packaging=[PKG_BAG, PKG_BOX])]

    def _parse(self, rows):
        specs = self._custom()
        return parse(rows, specs=specs, headers=headers_of(specs))

    def test_method_matched_to_id(self):
        body = self._parse([
            complete_field_row(**{"包装方式": "木箱"}),
        ]).to_dict()
        assert body["error_count"] == 0
        row = body["rows"][0]
        assert row["packaging_method"] == "木箱"   # 原文回显
        assert row["packaging_id"] == "pkg-b"      # 前端行草稿直接用

    def test_unknown_method_warns_not_errors(self):
        body = self._parse([
            complete_field_row(**{"包装方式": "纸箱"}),
        ]).to_dict()
        assert body["error_count"] == 0
        assert body["warning_count"] == 1
        assert body["usable_rows"] == 1
        row = body["rows"][0]
        assert row["packaging_method"] == "纸箱"
        assert row["packaging_id"] is None
        assert row["row_errors"] == []

    def test_duplicate_method_takes_first(self):
        specs = [replace(field_fence(), packaging=[
            PKG_BOX, {**PKG_BOX, "id": "pkg-b2"}])]
        body = parse(
            [complete_field_row(**{"包装方式": "木箱"})],
            specs=specs, headers=headers_of(specs),
        ).to_dict()
        assert body["rows"][0]["packaging_id"] == "pkg-b"

    def test_empty_packaging_means_product_default(self):
        body = self._parse([complete_field_row()]).to_dict()
        row = body["rows"][0]
        assert row["packaging_method"] is None
        assert row["packaging_id"] is None


# ═════════════════════════════════════════════════════════════════════════════
# xlsx 通路（与 CSV 共用 read_table；预览要回报「实际读了哪张表」）
# ═════════════════════════════════════════════════════════════════════════════

def make_xlsx(rows, headers=None, sheet_name="整单表"):
    openpyxl = pytest.importorskip("openpyxl")
    hs = headers if headers is not None else headers_of()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = sheet_name
    ws.append(hs)
    for row in rows:
        ws.append([row.get(h, "") for h in hs])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestXlsxOrderTable:
    def test_reports_actual_sheet(self):
        body = parse_order_table(
            make_xlsx([complete_field_row()]), products(), "整单表.xlsx",
        ).to_dict()
        assert body["sheet"] == "整单表"
        assert body["total_data_rows"] == 1
        assert body["usable_rows"] == 1
        assert body["rows"][0]["spec"]["mesh_mm"] == Decimal("100")

    def test_missing_sheet_falls_back_to_first_sheet(self):
        """表名不命中 → 读第一张（与 xlsx 读取器同一兜底），但 sheet 要报真实表名。"""
        body = parse_order_table(
            make_xlsx([complete_field_row()]), products(), "整单表.xlsx",
            sheet="不存在",
        ).to_dict()
        assert body["sheet"] == "整单表"
        assert any("没有名为" in i["message"] for i in body["issues"])


# ═════════════════════════════════════════════════════════════════════════════
# Worker 端点（API 级）：template-info / preview
# ═════════════════════════════════════════════════════════════════════════════

from _bootstrap import load_main  # noqa: E402

worker_main = load_main()

from fastapi.testclient import TestClient  # noqa: E402

import quote_api  # noqa: E402

client = TestClient(worker_main.app, raise_server_exceptions=True)

MEMBER = {"id": 3, "account_type": "internal", "role": "member", "team_id": 2,
          "status": "active"}


class _FakeDb:
    """quote_api._db 的最小替身：可报价产品发现层用不到真库（返回空即可）。"""

    def __init__(self):
        self.queries: list[str] = []

    async def fetch(self, request, sql, *args, table=None):
        self.queries.append(sql)
        return []


@contextmanager
def quotable_db(user: dict = MEMBER):
    """替换 quote_api._db 与鉴权（两份模块对象都 patch，见 test_tenant_products_team_scope）。"""
    db = _FakeDb()
    targets = {id(quote_api): quote_api}
    live = sys.modules.get("quote_api")
    if live is not None:
        targets.setdefault(id(live), live)
    previous = [(module, module._db) for module in targets.values()]
    for module in targets.values():
        module._db = db
    worker_main.app.dependency_overrides[worker_main._get_current_user] = lambda: user
    try:
        yield db
    finally:
        for module, old in previous:
            module._db = old
        worker_main.app.dependency_overrides.clear()


BASE = "/api/v1/export-quote"


class TestOrderImportEndpoints:
    def test_template_info_all_products(self):
        with quotable_db():
            resp = client.get(f"{BASE}/import/order/template-info")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == TEMPLATE_INFO_KEYS
        assert body["product_keys"] == sorted(product_keys())
        assert body["headers"][:len(COMMON_HEADERS)] == COMMON_HEADERS
        assert len(body["columns"]) == len(body["headers"])
        assert body["data_sheet"] == "整单表"
        assert body["max_rows"] == 2000
        assert body["max_mb"] == 2
        assert body["notes"]
        spec_column = next(c for c in body["columns"] if c["header"] == "网高(m)")
        assert spec_column == {
            "header": "网高(m)", "kind": "spec", "products": ["牛栏网"],
            "unit": "m", "options": [], "note": spec_column["note"],
        }

    def test_template_info_subset_and_unknown(self):
        with quotable_db():
            resp = client.get(
                f"{BASE}/import/order/template-info",
                params={"product_keys": "field_fence"},
            )
            unknown = client.get(
                f"{BASE}/import/order/template-info",
                params={"product_keys": "field_fence,no_such"},
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["product_keys"] == ["field_fence"]
        expected = COMMON_HEADERS + template_headers(field_fence())
        assert body["headers"] == expected
        assert unknown.status_code == 404
        assert unknown.json()["detail"]["error"] == "unknown_product"

    def test_preview_csv_contract_shape(self):
        csv_bytes = make_csv([
            complete_field_row(),
            {"产品": "勾花网", "件数（卷）": "3", "成本": "12",
             "丝径/线径(mm)": "2.5", "网孔/刺尖间距(cm)": "5"},
            {"产品": "不存在", "件数（卷）": "1", "成本": "1"},
        ])
        with quotable_db():
            resp = client.post(
                f"{BASE}/import/order/preview",
                files={"file": ("整单表.csv", csv_bytes, "text/csv")},
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert set(body) == PREVIEW_KEYS
        assert body["source_name"] == "整单表.csv"
        assert body["sheet"] == "CSV"
        assert body["total_data_rows"] == 3
        assert body["usable_rows"] == 2
        assert body["error_count"] == 1
        assert body["products"] == [
            {"product_key": "field_fence", "product_name": "牛栏网", "rows": 1},
            {"product_key": "chain_link", "product_name": "勾花网", "rows": 1},
        ]
        assert body["rows"][0]["spec"]["height_m"] == 1.2  # Decimal → JSON number
        assert body["rows"][0]["spec"]["mesh_mm"] == 100
        assert body["rows"][0]["packaging_id"] is None
        assert body["expected_columns"] == headers_of(api_products())
        assert body["mapping"]["产品"] == "产品"

    def test_preview_missing_required_column_is_parse_error(self):
        hs = [h for h in headers_of() if h != "产品"]
        csv_bytes = make_csv([complete_field_row()], hs)
        with quotable_db():
            resp = client.post(
                f"{BASE}/import/order/preview",
                files={"file": ("整单表.csv", csv_bytes, "text/csv")},
            )
        assert resp.status_code == 400, resp.text
        detail = resp.json()["detail"]
        assert detail["error"] == "parse_error"
        assert "产品" in detail["message"]

    def test_preview_empty_file_is_400(self):
        with quotable_db():
            resp = client.post(
                f"{BASE}/import/order/preview",
                files={"file": ("empty.csv", b"", "text/csv")},
            )
        assert resp.status_code == 400
        assert resp.json()["detail"]["error"] == "empty_file"
