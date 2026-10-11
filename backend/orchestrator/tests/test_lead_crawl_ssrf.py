"""SSRF 防护测试：`is_safe_crawl_url`。

这是**安全件**，而且是从 worker 逐行搬过来的 —— 所以测试要盯住
"哪些必须被拒"，而不只是"公网地址能过"。

判据来自 worker 的 `_BLOCKED_HOST_RE`（回环 / 私有网段 / 链路本地 /
云元数据 169.254.x / IPv6 私网）。**少一条判断就是一个 SSRF 洞**，
所以下面把每一类都单独钉一条。
"""
import pytest

from app.services.lead_crawl import (
    http_get_text,
    is_safe_crawl_url,
    next_redirect_url,
)

pytestmark = pytest.mark.unit


class TestAllowsPublicHttp:
    @pytest.mark.parametrize("url", [
        "http://example.com",
        "https://example.com/products",
        "https://www.alibaba.com/catalog?x=1",
        "https://sub.deep.example.co.uk/path",
        "example.com",              # 无协议 → 由调用方补 https 后再判；此处应拒绝
    ][:4])
    def test_public_hosts_pass(self, url):
        assert is_safe_crawl_url(url) is True


class TestRejectsBlockedHosts:
    """每一类封禁都必须单独钉住 —— 少一类就是一个洞。"""

    @pytest.mark.parametrize("url", [
        "http://localhost/",
        "http://localhost:8080/admin",
        "http://127.0.0.1/",
        "http://127.1.2.3/",
        "http://0.0.0.0/",
        "http://10.0.0.1/",
        "http://10.255.255.254/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",   # 云元数据（最危险的一条）
        "http://172.16.0.1/",
        "http://172.31.255.254/",
        "http://[::1]/",
        "http://fc00::1/",
        "http://fd12:3456::1/",
        "http://fe80::1/",
    ])
    def test_blocked_by_regex(self, url):
        assert is_safe_crawl_url(url) is False

    def test_172_block_is_ranged_not_a_blanket_prefix(self):
        """`172.` 整段封掉会误杀合法公网地址 —— 只该封 172.16–172.31。

        这条防的是"为了省事把正则写宽"。写宽了功能会莫名其妙坏掉，
        而且没人会往 SSRF 上想。
        """
        assert is_safe_crawl_url("http://172.15.0.1/") is True
        assert is_safe_crawl_url("http://172.32.0.1/") is True
        assert is_safe_crawl_url("http://172.16.0.1/") is False
        assert is_safe_crawl_url("http://172.31.0.1/") is False


class TestRejectsBadShape:
    @pytest.mark.parametrize("url", [
        "ftp://example.com/",            # 非 http(s)
        "file:///etc/passwd",
        "javascript:alert(1)",
        "http:///nohost",
        "http://",
        "",
    ])
    def test_rejected(self, url):
        assert is_safe_crawl_url(url) is False

    def test_bare_hostname_without_dot_is_rejected(self):
        """内网常靠短主机名访问（`http://intranet/`）—— 无点一律拒绝。"""
        assert is_safe_crawl_url("http://intranet/") is False
        assert is_safe_crawl_url("http://my-server/") is False

    def test_none_is_rejected_not_crashing(self):
        assert is_safe_crawl_url(None) is False


class TestRedirectHopValidation:
    """**逐跳校验**：只校验请求前的 URL 挡不住"302 跳到内网"。

    这是本次移植时发现的绕过面 —— worker 侧用的是 `redirect: "follow"`，
    存在同一个洞。
    """

    def test_relative_location_is_resolved_against_current(self):
        got = next_redirect_url("https://example.com/a/b", "/products")
        assert got == "https://example.com/products"

    def test_absolute_public_location_passes(self):
        assert next_redirect_url(
            "https://example.com/", "https://other.example.org/x") \
            == "https://other.example.org/x"

    @pytest.mark.parametrize("location", [
        "http://127.0.0.1/",
        "http://localhost/",
        "http://169.254.169.254/latest/meta-data/",   # 云元数据：最经典的 SSRF 目标
        "http://10.0.0.1/",
        "http://192.168.0.1/",
        "http://[::1]/",
        "file:///etc/passwd",
    ])
    def test_internal_redirect_is_refused(self, location):
        assert next_redirect_url("https://example.com/", location) is None

    def test_empty_location_is_refused(self):
        assert next_redirect_url("https://example.com/", "") is None
        assert next_redirect_url("https://example.com/", None) is None


class TestGuardRunsBeforeAnyNetwork:
    """尺子必须在**任何网络动作之前**执行 —— 否则它只是事后检查。"""

    async def test_unsafe_url_raises_without_requesting(self):
        for url in ("http://127.0.0.1/", "http://169.254.169.254/",
                    "file:///etc/passwd", "http://localhost/"):
            with pytest.raises(ValueError):
                await http_get_text(url)

    async def test_no_scheme_raises(self):
        with pytest.raises(ValueError):
            await http_get_text("example.com")
