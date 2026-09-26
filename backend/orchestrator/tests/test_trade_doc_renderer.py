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
    # safe_substitute 保证缺失字段不抛异常
    html = trade_doc_renderer.render_trade_doc("quotation", {"currency": "USD"})
    assert "<html" in html
