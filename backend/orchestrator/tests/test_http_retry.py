"""Kaas v2 · HTTP Retry 测试 (§13 T9)"""
import pytest
pytestmark = pytest.mark.unit
import httpx
import respx
from app.services.http_utils import retry_request


@pytest.fixture
async def test_client():
    async with httpx.AsyncClient(base_url="https://test.example.com", timeout=5) as c:
        yield c


class TestRetryRequest:
    """retry_request 重试机制测试。"""

    @pytest.mark.anyio
    async def test_first_500_then_200_success(self, test_client, monkeypatch):
        """首次 500 + 第 2 次 200 → 成功。"""
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "2")
        call_count = [0]

        with respx.mock(assert_all_called=False) as mock:
            def handler(request):
                call_count[0] += 1
                if call_count[0] == 1:
                    return httpx.Response(500, json={"error": "server error"})
                return httpx.Response(200, json={"ok": True})
            mock.post("https://test.example.com/api").mock(side_effect=handler)

            resp = await retry_request(test_client, "POST", "/api", retries=2)
        assert resp.status_code == 200
        assert call_count[0] == 2

    @pytest.mark.anyio
    async def test_timeout_then_retry_success(self, test_client, monkeypatch):
        """超时 + 重试成功 → 成功。"""
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "1")
        call_count = [0]

        with respx.mock(assert_all_called=False) as mock:
            def handler(request):
                call_count[0] += 1
                if call_count[0] == 1:
                    raise httpx.TimeoutException("timeout")
                return httpx.Response(200, json={"ok": True})
            mock.post("https://test.example.com/api").mock(side_effect=handler)

            resp = await retry_request(test_client, "POST", "/api", retries=1)
        assert resp.status_code == 200
        assert call_count[0] == 2

    @pytest.mark.anyio
    async def test_4xx_no_retry(self, test_client, monkeypatch):
        """4xx → 不重试直接返回。"""
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "2")
        call_count = [0]

        with respx.mock(assert_all_called=False) as mock:
            def handler(request):
                call_count[0] += 1
                return httpx.Response(401, json={"error": "Unauthorized"})
            mock.post("https://test.example.com/api").mock(side_effect=handler)

            resp = await retry_request(test_client, "POST", "/api", retries=2)
        assert resp.status_code == 401
        assert call_count[0] == 1  # 不重试

    @pytest.mark.anyio
    async def test_all_500_exceeds_retries(self, test_client, monkeypatch):
        """连续 500 超过重试次数 → raise。"""
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "1")

        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://test.example.com/api").respond(status_code=500, json={"error": "fail"})

            with pytest.raises(httpx.HTTPStatusError):
                await retry_request(test_client, "POST", "/api", retries=1)

    @pytest.mark.anyio
    async def test_success_no_retry_needed(self, test_client, monkeypatch):
        """首次成功 → 不重试。"""
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "2")
        call_count = [0]

        with respx.mock(assert_all_called=False) as mock:
            def handler(request):
                call_count[0] += 1
                return httpx.Response(200, json={"ok": True})
            mock.post("https://test.example.com/api").mock(side_effect=handler)

            resp = await retry_request(test_client, "POST", "/api", retries=2)
        assert resp.status_code == 200
        assert call_count[0] == 1
