"""`crawl_one` 的状态机测试（注入 fetcher / ai_runner，不起网络、不连库）。

四种 `crawl_status` 是与前端的**契约**，每一种都必须被写出来：

    no_website / blocked / failed / success

漏写任何一种，对应那批线索就会一直挂在"待爬"，界面上看不出
是失败了还是没人爬 —— 这类"静默挂着"比报错更难查。
"""
import pytest

from app.services.lead_crawl import crawl_one

pytestmark = pytest.mark.unit


class _Lead:
    """够用的假线索行（真实行是 SQLAlchemy 模型，字段一致）。"""

    def __init__(self, website="https://factory.example.com", **kw):
        self.id = 7
        self.website = website
        self.product_name = None
        self.product_name_cn = None
        self.product_image_url = None
        self.spec_raw = None
        self.spec_normalized = None
        self.link_url = None
        self.crawl_status = "pending"
        self.crawled_at = None


class _Ai:
    async def __call__(self, db, tenant_id, task_key, payload):
        return {"result": {}}


HTML = ('<html><head><title>Acme</title></head><body><h1>Chain link fence</h1>'
        '<meta property="og:image" content="https://x/i.png">'
        '<a href="/products/fence">x</a></body></html>')


def _fetcher(status=200, html=HTML):
    async def _f(url):
        return status, html
    return _f


class TestNoWebsite:
    async def test_marks_no_website_without_fetching(self):
        called = []

        async def _f(url):
            called.append(url)
            return 200, HTML

        lead = _Lead(website="")
        got = await crawl_one(None, "t1", lead, fetcher=_f, ai_runner=_Ai())
        assert got["status"] == "no_website"
        assert lead.crawl_status == "no_website"
        assert called == [], "没有网址就不该发请求"
        assert lead.crawled_at is not None


class TestBlocked:
    async def test_internal_url_is_blocked_before_fetching(self):
        called = []

        async def _f(url):
            called.append(url)
            return 200, HTML

        lead = _Lead(website="http://169.254.169.254/latest/meta-data/")
        got = await crawl_one(None, "t1", lead, fetcher=_f, ai_runner=_Ai())
        assert got["status"] == "blocked"
        assert lead.crawl_status == "blocked"
        assert called == [], "被拦下的地址**绝不能**真的发请求"

    async def test_scheme_less_website_gets_https_prefix(self):
        """线索里的网址常不带协议；补 https 之后再判安全性，不能先判空。"""
        seen = []

        async def _f(url):
            seen.append(url)
            return 200, HTML

        lead = _Lead(website="factory.example.com")
        await crawl_one(None, "t1", lead, fetcher=_f, ai_runner=_Ai())
        assert seen == ["https://factory.example.com"]


class TestSuccess:
    async def test_extracts_and_writes_fields(self):
        lead = _Lead()
        got = await crawl_one(None, "t1", lead, fetcher=_fetcher(), ai_runner=_Ai())
        assert got["status"] == "success"
        assert lead.crawl_status == "success"
        assert lead.product_name == "Chain link fence"
        assert lead.product_image_url == "https://x/i.png"
        assert lead.spec_raw
        assert lead.link_url == "https://factory.example.com/products/fence"
        assert lead.crawled_at is not None

    async def test_http_error_status_becomes_failed(self):
        lead = _Lead()
        got = await crawl_one(None, "t1", lead, fetcher=_fetcher(status=404),
                              ai_runner=_Ai())
        assert got["status"] == "failed"
        assert lead.crawl_status == "failed"

    async def test_empty_body_becomes_failed(self):
        lead = _Lead()
        got = await crawl_one(None, "t1", lead, fetcher=_fetcher(html=""),
                              ai_runner=_Ai())
        assert got["status"] == "failed"

    async def test_fetch_exception_is_caught_not_raised(self):
        """单条失败必须收成状态，不能抛出去 —— 否则批量爬取会整批中断。"""
        async def _boom(url):
            raise RuntimeError("连不上")

        lead = _Lead()
        got = await crawl_one(None, "t1", lead, fetcher=_boom, ai_runner=_Ai())
        assert got["status"] == "failed"
        assert "连不上" in got["error"]

    async def test_missing_field_does_not_overwrite_existing(self):
        """抽不到就保持原值 —— 别拿 None 把已有数据擦掉。"""
        lead = _Lead()
        lead.product_image_url = "https://keep/i.png"
        html = "<body><h1>P</h1></body>"      # 没有 og:image
        await crawl_one(None, "t1", lead, fetcher=_fetcher(html=html),
                        ai_runner=_Ai())
        assert lead.product_image_url == "https://keep/i.png"
