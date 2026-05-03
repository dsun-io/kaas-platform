"""Kaas v2 · FastGPT KB Client 集成测试 (§13 T9)

使用 respx mock FastGPT searchTest API。
"""
import pytest
pytestmark = pytest.mark.unit
import httpx
import respx
from unittest.mock import patch
from app.services.kb_client import StubKBClient, FastGPTKBClient


class TestStubKBClient:
    """StubKBClient 使用 dataset_ids 查找。"""

    async def test_search_with_dataset_ids(self):
        stub = StubKBClient()
        results = await stub.search(
            dataset_ids=["custom:cust-1:牛栏网", "standard:牛栏网"],
            query="50x50 2.5mm",
            top_k=3,
        )
        assert len(results) > 0
        assert all("unit_price" in r for r in results)

    async def test_search_unknown_category(self):
        stub = StubKBClient()
        results = await stub.search(
            dataset_ids=["standard:unknown"],
            query="test",
        )
        assert results == []

    async def test_search_top_k_limits_results(self):
        stub = StubKBClient()
        results = await stub.search(
            dataset_ids=["standard:牛栏网"],
            query="test",
            top_k=1,
        )
        assert len(results) <= 1


class TestFastGPTKBClient:
    """FastGPT searchTest API 集成测试。"""

    @pytest.fixture
    def fastgpt_client(self, monkeypatch):
        monkeypatch.setenv("KB_PROVIDER", "fastgpt")
        monkeypatch.setenv("FASTGPT_BASE_URL", "https://fastgpt-test.example.com")
        monkeypatch.setenv("FASTGPT_API_KEY_LIANKAI", "fg-test-key")
        monkeypatch.setenv("KB_TIMEOUT_SECONDS", "5")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

        mock_cfg = {"fastgpt_api_key_ref": "ENV:FASTGPT_API_KEY_LIANKAI"}
        # load_tenant_config is imported inside FastGPTKBClient.__init__
        with patch("app.domain.tenant_config.load_tenant_config", return_value=mock_cfg):
            return FastGPTKBClient(tenant_id="liankai")

    @pytest.mark.anyio
    async def test_search_normal(self, fastgpt_client):
        """searchTest 正常返回 → chunks 解析正确。"""
        mock_response = {
            "list": [
                {"q": "50x50 牛栏网", "a": "12.5 CNY/m²", "score": 0.95, "datasetId": "ds-1"},
                {"q": "60x60 牛栏网", "a": "15.0 CNY/m²", "score": 0.82, "datasetId": "ds-1"},
            ]
        }
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://fastgpt-test.example.com/api/core/dataset/searchTest").respond(
                status_code=200, json=mock_response
            )
            results = await fastgpt_client.search(
                dataset_ids=["ds-1"], query="牛栏网 50x50", top_k=3,
            )
        assert len(results) == 2
        assert results[0]["content"] == "12.5 CNY/m²"
        assert results[0]["score"] == 0.95
        assert results[0]["dataset_id"] == "ds-1"

    @pytest.mark.anyio
    async def test_search_empty_results(self, fastgpt_client):
        """空结果 → 返回 []。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://fastgpt-test.example.com/api/core/dataset/searchTest").respond(
                status_code=200, json={"list": []}
            )
            results = await fastgpt_client.search(
                dataset_ids=["ds-1"], query="unknown", top_k=3,
            )
        assert results == []

    @pytest.mark.anyio
    async def test_search_data_key_compatibility(self, fastgpt_client):
        """response 格式兼容 data key（非 list）。"""
        mock_response = {
            "data": [
                {"q": "80x100", "a": "8.5 CNY/m²", "score": 0.88, "datasetId": "ds-2"},
            ]
        }
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://fastgpt-test.example.com/api/core/dataset/searchTest").respond(
                status_code=200, json=mock_response
            )
            results = await fastgpt_client.search(
                dataset_ids=["ds-2"], query="石笼网", top_k=3,
            )
        assert len(results) == 1
        assert results[0]["content"] == "8.5 CNY/m²"

    @pytest.mark.anyio
    async def test_search_timeout_raises(self, fastgpt_client):
        """超时 → raise。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://fastgpt-test.example.com/api/core/dataset/searchTest").mock(
                side_effect=httpx.TimeoutException("timeout")
            )
            with pytest.raises(httpx.TimeoutException):
                await fastgpt_client.search(
                    dataset_ids=["ds-1"], query="test", top_k=3,
                )
