"""Kaas v2 · DeepSeekClient 集成测试 (§13 T9)

使用 respx mock DeepSeek API。
"""
import os
import pytest
pytestmark = pytest.mark.unit
import json
import pytest
import httpx
import respx
from app.services.llm_client import DeepSeekClient, ZhipuClient


class TestDeepSeekClient:
    """DeepSeek Function Calling API 测试。"""

    @pytest.fixture
    def deepseek_client(self, monkeypatch):
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test-123")
        monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        monkeypatch.setenv("DEEPSEEK_MODEL", "deepseek-chat")
        monkeypatch.setenv("LLM_TIMEOUT_SECONDS", "5")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")
        return DeepSeekClient()

    @pytest.mark.anyio
    async def test_function_call_normal(self, deepseek_client):
        """function_call 正常返回 → 解析 tool_calls 成功。"""
        mock_response = {
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "extract_product_spec",
                            "arguments": json.dumps({"mesh_size": "50x50", "wire_diameter": 2.5})
                        }
                    }]
                }
            }]
        }
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").respond(
                status_code=200, json=mock_response
            )
            result = await deepseek_client.function_call(
                prompt="我要50x50丝径2.5的牛栏网",
                function_name="extract_product_spec",
                function_schema={
                    "name": "extract_product_spec",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "mesh_size": {"type": "string"},
                            "wire_diameter": {"type": "number"},
                        }
                    }
                },
                context={"product_category": "牛栏网"},
            )
        assert result == {"mesh_size": "50x50", "wire_diameter": 2.5}

    @pytest.mark.anyio
    async def test_function_call_malformed_response(self, deepseek_client):
        """function_call 返回格式异常 → raise。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").respond(
                status_code=200, json={"choices": []}
            )
            with pytest.raises((IndexError, KeyError)):
                await deepseek_client.function_call(
                    prompt="test", function_name="f",
                    function_schema={"parameters": {"properties": {}}},
                )

    @pytest.mark.anyio
    async def test_generate_script_normal(self, deepseek_client):
        """generate_script 正常返回 → 文本包含'参考价'。"""
        mock_response = {
            "choices": [{
                "message": {
                    "content": "您好，牛栏网当前参考价 12.5 CNY/m²，参考价 - 需人工确认。"
                }
            }]
        }
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").respond(
                status_code=200, json=mock_response
            )
            script = await deepseek_client.generate_script({
                "product_category": "牛栏网",
                "spec_summary": "50x50 2.5mm",
                "price_range": "12.5 CNY/m²",
            })
        assert "参考价" in script
        assert "牛栏网" in script

    @pytest.mark.anyio
    async def test_timeout_raises(self, deepseek_client):
        """超时 → httpx.TimeoutException。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").mock(
                side_effect=httpx.TimeoutException("timeout")
            )
            with pytest.raises(httpx.TimeoutException):
                await deepseek_client.function_call(
                    prompt="test", function_name="f",
                    function_schema={"parameters": {"properties": {}}},
                )

    @pytest.mark.anyio
    async def test_401_raises(self, deepseek_client):
        """401 → raise（API key 错误）。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").respond(
                status_code=401, json={"error": "Unauthorized"}
            )
            with pytest.raises((httpx.HTTPStatusError, Exception)):
                await deepseek_client.function_call(
                    prompt="test", function_name="f",
                    function_schema={"parameters": {"properties": {}}},
                )

    @pytest.mark.anyio
    async def test_close_cleans_up(self, deepseek_client):
        """close 正常清理。"""
        await deepseek_client.close()


class TestZhipuClient:
    """智谱 GLM-4 客户端基础测试。"""

    @pytest.fixture
    def zhipu_client(self, monkeypatch):
        monkeypatch.setenv("ZHIPU_API_KEY", "zhipu-test-key")
        monkeypatch.setenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
        monkeypatch.setenv("ZHIPU_MODEL", "glm-4")
        monkeypatch.setenv("LLM_TIMEOUT_SECONDS", "5")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")
        return ZhipuClient()

    @pytest.mark.anyio
    async def test_function_call_normal(self, zhipu_client):
        """智谱 function_call 正常返回。"""
        mock_response = {
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "extract",
                            "arguments": json.dumps({"mesh_size": "60x60"})
                        }
                    }]
                }
            }]
        }
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://open.bigmodel.cn/api/paas/v4/v1/chat/completions").respond(
                status_code=200, json=mock_response
            )
            result = await zhipu_client.function_call(
                prompt="60x60石笼网",
                function_name="extract",
                function_schema={"parameters": {"properties": {"mesh_size": {"type": "string"}}}},
            )
        assert result == {"mesh_size": "60x60"}
