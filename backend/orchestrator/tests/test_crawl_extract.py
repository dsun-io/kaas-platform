"""产品信息抽取测试：`kaas_common.crawl_extract`。

**这段代码在此之前从未被测过。** 它原先住在 worker 的 `chain.py` 里，
而那个文件依赖 Pyodide、在 CPython 测试环境里 import 不了 ——
于是一段最容易出错（正则 / HTML 变体 / 实体转义）的逻辑一直是黑盒。

搬进 `kaas_common` 后，本文件测的就是 worker 实际执行的那份代码。

口径提醒：这是**确定性脚本，AI 不参与**；抽不到就回 `None`，
**绝不猜** —— 猜错的产品名会被当成真实数据进线索池，比空着更糟。
"""
import pytest

from kaas_common.crawl_extract import (
    abs_url,
    extract_product_from_html,
    meta_content,
    strip_html,
)

pytestmark = pytest.mark.unit

BASE = "https://factory.example.com/about"


class TestStripHtml:
    def test_removes_tags_and_collapses_whitespace(self):
        assert strip_html("<p>a   b</p>\n<i>c</i>") == "a b c"

    def test_drops_script_and_style_bodies(self):
        """脚本/样式里的文字不是页面内容，混进规格原文会变成噪音。"""
        got = strip_html("<style>.a{color:red}</style><script>var x=1</script>ok")
        assert got == "ok"

    def test_decodes_common_entities(self):
        assert strip_html("A&amp;B &lt;c&gt; &quot;d&quot; &#39;e&#39;") \
            == 'A&B <c> "d" \'e\''

    def test_empty_input_is_safe(self):
        assert strip_html("") == ""
        assert strip_html(None) == ""


class TestMetaContent:
    def test_reads_property_and_name(self):
        html = ('<meta property="og:image" content="https://x/i.png">'
                '<meta name="description" content="desc">')
        assert meta_content(html, ("og:image",)) == "https://x/i.png"
        assert meta_content(html, ("description",)) == "desc"

    def test_case_insensitive_keys(self):
        html = '<meta property="OG:IMAGE" content="https://x/i.png">'
        assert meta_content(html, ("og:image",)) == "https://x/i.png"

    def test_missing_returns_none_not_empty_string(self):
        assert meta_content("<meta name='x' content='y'>", ("nope",)) is None
        assert meta_content("", ("og:image",)) is None


class TestAbsUrl:
    def test_absolute_passes_through(self):
        assert abs_url(BASE, "https://a/b") == "https://a/b"

    def test_protocol_relative(self):
        assert abs_url(BASE, "//cdn.example.com/i.png") == "https://cdn.example.com/i.png"

    def test_root_relative(self):
        assert abs_url(BASE, "/products/x") == "https://factory.example.com/products/x"

    def test_path_relative(self):
        assert abs_url(BASE, "products/x") == "https://factory.example.com/products/x"

    def test_leading_dot_slash_is_stripped(self):
        assert abs_url(BASE, "./products/x") == "https://factory.example.com/products/x"


class TestExtractProduct:
    def test_h1_wins_over_title_and_source_is_reported(self):
        """产品名优先级 h1 > title，且必须回报名字的来源。

        title 往往带"公司名 - 首页"这类噪音；下游排查"名字不对"时，
        知道它来自 h1 还是 title 是关键线索。
        """
        html = "<html><head><title>Acme - 首页</title></head><body><h1>镀锌牛栏网</h1></body></html>"
        got = extract_product_from_html(html, BASE)
        assert got["product_name"] == "镀锌牛栏网"
        assert got["product_name_source"] == "h1"
        assert got["page_title"] == "Acme - 首页"

    def test_falls_back_to_title(self):
        html = "<html><head><title>Chain link fence</title></head><body></body></html>"
        got = extract_product_from_html(html, BASE)
        assert got["product_name"] == "Chain link fence"
        assert got["product_name_source"] == "title"

    def test_no_name_returns_none_not_guess(self):
        got = extract_product_from_html("<html><body><p>hi</p></body></html>", BASE)
        assert got["product_name"] is None
        assert got["product_name_source"] is None

    def test_og_image_is_taken(self):
        html = '<meta property="og:image" content="https://x/i.png"><h1>P</h1>'
        assert extract_product_from_html(html, BASE)["product_image_url"] == "https://x/i.png"

    def test_spec_raw_prefers_description_then_body(self):
        html = ('<meta name="description" content="DESC">'
                '<body><h1>P</h1><p>BODY</p></body>')
        spec = extract_product_from_html(html, BASE)["spec_raw"]
        assert spec.startswith("DESC")
        assert "BODY" in spec

    def test_spec_body_is_truncated(self):
        """规格原文会入库，必须有上限，否则一条巨型页面就能把行撑爆。"""
        html = "<body>" + ("x" * 5000) + "</body>"
        spec = extract_product_from_html(html, BASE)["spec_raw"]
        assert len(spec) <= 1200

    def test_product_link_is_absolutized(self):
        html = '<a href="/products/fence">牛栏网</a>'
        assert extract_product_from_html(html, BASE)["link_url"] \
            == "https://factory.example.com/products/fence"

    def test_non_product_link_is_not_a_product_link(self):
        """只有命中产品页特征路径才算；随便一个 `/about` 不该被当成产品页。"""
        html = '<a href="/about">关于我们</a>'
        assert extract_product_from_html(html, BASE)["link_url"] is None

    def test_empty_html_does_not_crash(self):
        got = extract_product_from_html("", BASE)
        assert got["product_name"] is None
        assert got["product_image_url"] is None
        assert got["link_url"] is None
