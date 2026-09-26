"""单证渲染器单元测试(不依赖数据库/外部服务)"""
import pytest

from app.renderers import trade_doc_renderer


MINIMAL_DATA = {
    "seller": {"company": "安平县恒泰金属丝网制品有限公司", "address": "河北省安平县"},
    "buyer": {"company": "Australian Rural Fencing Pty Ltd"},
    "currency": "USD",
    "total_amount": 26450.0,
    "items": [
        {"product_name": "牛栏网 Cattle Fence", "qty": 500, "qty_unit": "Rolls",
         "unit_price": 28.5, "line_amount": 14250.0},
    ],
}


@pytest.mark.unit
def test_list_templates_covers_all_doc_types():
    types = {t["doc_type"] for t in trade_doc_renderer.get_available_templates()}
    assert types == {"quotation", "pi", "contract", "ci", "pl", "bl", "co", "insurance", "other"}


@pytest.mark.unit
def test_get_template_fields():
    fields = trade_doc_renderer.get_template_fields("pi")
    assert fields is not None
    assert "seller" in fields and "items" in fields and "bank_info" in fields
    assert trade_doc_renderer.get_template_fields("nonexistent") is None


@pytest.mark.unit
@pytest.mark.parametrize("doc_type", ["quotation", "pi", "contract", "ci", "pl", "bl", "co", "insurance", "other"])
def test_render_all_doc_types_without_exception(doc_type):
    html = trade_doc_renderer.render_trade_doc(doc_type, MINIMAL_DATA)
    assert "<html" in html
    # 占位符不应残留(除自定义 content 外)
    assert "$seller" not in html
    assert "$buyer" not in html


@pytest.mark.unit
def test_render_fills_values_and_formats_amount():
    html = trade_doc_renderer.render_trade_doc("pi", {**MINIMAL_DATA, "pi_no": "PI-TEST-0001"})
    assert "安平县恒泰金属丝网制品有限公司" in html
    assert "Australian Rural Fencing Pty Ltd" in html
    assert "PI-TEST-0001" in html
    assert "26,450.00" in html  # 金额千分位格式化
    assert "牛栏网" in html


@pytest.mark.unit
def test_render_unknown_type_raises():
    with pytest.raises(ValueError, match="不支持的单证类型"):
        trade_doc_renderer.render_trade_doc("unknown_type", {})


@pytest.mark.unit
def test_render_with_missing_optional_fields_safe():
    # 缺失字段由 _RenderDict 渲染为空串，不抛异常也不残留 $placeholder
    html = trade_doc_renderer.render_trade_doc("quotation", {"currency": "USD"})
    assert "<html" in html
    assert "$remarks" not in html


# ── 英文印刷级单证能力 ──────────────────────────────────────────────────────

@pytest.mark.unit
@pytest.mark.parametrize("amount,currency,expected", [
    (26450.0, "USD", "SAY US DOLLARS TWENTY-SIX THOUSAND FOUR HUNDRED AND FIFTY ONLY"),
    (1000.5, "USD", "SAY US DOLLARS ONE THOUSAND AND CENTS FIFTY ONLY"),
    (0, "USD", "SAY US DOLLARS ZERO ONLY"),
    (1250000, "EUR", "SAY EUROS ONE MILLION TWO HUNDRED AND FIFTY THOUSAND ONLY"),
    (15, "CNY", "SAY CHINESE YUAN FIFTEEN ONLY"),
])
def test_amount_in_words(amount, currency, expected):
    """金额英文大写供报关与信用证审单使用"""
    assert trade_doc_renderer.amount_in_words(amount, currency) == expected


@pytest.mark.unit
def test_amount_in_words_invalid_returns_empty():
    assert trade_doc_renderer.amount_in_words(None) == ""
    assert trade_doc_renderer.amount_in_words("abc") == ""
    assert trade_doc_renderer.amount_in_words(-1) == ""


@pytest.mark.unit
def test_item_columns_are_fixed_per_doc_type():
    """商业发票不得出现毛净重列（属装箱单），但必须含 HS Code"""
    html = trade_doc_renderer.render_trade_doc("ci", MINIMAL_DATA)
    assert "G.W. (KGS)" not in html
    assert "N.W. (KGS)" not in html
    assert "HS Code" in html


@pytest.mark.unit
def test_packing_list_has_package_and_weight_columns():
    html = trade_doc_renderer.render_trade_doc("pl", MINIMAL_DATA)
    assert "Packages" in html
    assert "G.W. (KGS)" in html
    assert "Meas. (CBM)" in html


@pytest.mark.unit
def test_date_reformatted_to_international_style():
    html = trade_doc_renderer.render_trade_doc(
        "ci", {**MINIMAL_DATA, "invoice_date": "2026-10-20"})
    assert "20-Oct-2026" in html
    assert "2026-10-20" not in html


@pytest.mark.unit
def test_line_number_is_integer_not_amount():
    html = trade_doc_renderer.render_trade_doc("ci", MINIMAL_DATA)
    assert ">1.00<" not in html


@pytest.mark.unit
def test_total_row_shows_quantity_and_amount():
    html = trade_doc_renderer.render_trade_doc("ci", MINIMAL_DATA)
    assert "TOTAL" in html
    assert "USD 26,450.00" in html
    assert ">500<" in html  # 数量合计由行项汇总


@pytest.mark.unit
def test_auto_totals_derived_from_items():
    """件数/毛重/净重/体积未显式提供时，由行项自动汇总"""
    data = {
        **MINIMAL_DATA,
        "items": [
            {"product_name": "A", "qty": 10, "package": 2,
             "gross_weight": 100, "net_weight": 95, "volume": 1.5},
            {"product_name": "B", "qty": 5, "package": 1,
             "gross_weight": 50, "net_weight": 48, "volume": 0.5},
        ],
    }
    html = trade_doc_renderer.render_trade_doc("pl", data)
    assert "150.00 KGS" in html   # 毛重 100 + 50
    assert "143.00 KGS" in html   # 净重 95 + 48
    assert "2.00 CBM" in html     # 体积 1.5 + 0.5


@pytest.mark.unit
def test_values_are_html_escaped():
    """业务值一律转义，防止单据被注入脚本"""
    html = trade_doc_renderer.render_trade_doc("ci", {
        **MINIMAL_DATA, "shipping_marks": "<script>alert(1)</script>"})
    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


@pytest.mark.unit
def test_other_doc_type_allows_raw_html_content():
    """通用单证的 content 字段按原始 HTML 透传"""
    html = trade_doc_renderer.render_trade_doc("other", {
        **MINIMAL_DATA, "title": "Beneficiary Certificate",
        "content": "<p>We hereby certify.</p>"})
    assert "<p>We hereby certify.</p>" in html


@pytest.mark.unit
def test_shared_print_style_is_inlined():
    """共享样式注入到模板，且不残留占位符"""
    html = trade_doc_renderer.render_trade_doc("ci", MINIMAL_DATA)
    assert "/*__SHARED_STYLE__*/" not in html
    assert "@page" in html
    assert "table.items" in html
