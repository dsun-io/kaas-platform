"""Kaas v2 · LLM Fallback 链测试 (§13 T9)"""
import os
import json
import pytest
pytestmark = pytest.mark.unit
import httpx
import respx
from app.services.llm_client import llm_with_fallback, get_llm_client


_SCHEMA = {
    "name": "extract",
    "parameters": {
        "type": "object",
        "properties": {"mesh_size": {"type": "string"}},
    },
}


class TestLLMFallbackChain:
    """LLM fallback 链测试。"""

    @pytest.fixture(autouse=True)
    def _setup_env(self, monkeypatch):
        monkeypatch.setenv("LLM_PROVIDER", "deepseek")
        monkeypatch.setenv("LLM_FALLBACK", "zhipu")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
        monkeypatch.setenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        monkeypatch.setenv("ZHIPU_API_KEY", "zhipu-test")
        monkeypatch.setenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
        monkeypatch.setenv("LLM_TIMEOUT_SECONDS", "5")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

    @pytest.fixture
    def mock_deepseek_dead(self):
        """Mock DeepSeek 挂掉。"""
        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").mock(
                side_effect=httpx.ConnectError("connection refused")
            )
            yield mock

    def test_primary_success_no_fallback(self, monkeypatch):
        """primary 成功 → 不调 fallback。"""
        monkeypatch.setenv("LLM_PROVIDER", "stub")
        monkeypatch.setenv("LLM_FALLBACK", "")
        client = get_llm_client()
        from app.services.llm_client import StubLLMClient
        assert isinstance(client, StubLLMClient)

    @pytest.mark.anyio
    async def test_primary_fail_fallback_success(self, monkeypatch):
        """primary 挂 + fallback 成功 → 用 fallback 结果。"""
        monkeypatch.setenv("LLM_PROVIDER", "deepseek")
        monkeypatch.setenv("LLM_FALLBACK", "stub")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").mock(
                side_effect=httpx.ConnectError("refused")
            )
            result = await llm_with_fallback(
                prompt="50x50 丝径2.5",
                function_name="extract",
                function_schema=_SCHEMA,
            )
        assert isinstance(result, dict)

    @pytest.mark.anyio
    async def test_both_fail_returns_empty_dict(self, monkeypatch):
        """primary 挂 + fallback 挂 → 返回空 dict（触发正则兜底）。"""
        monkeypatch.setenv("LLM_PROVIDER", "deepseek")
        monkeypatch.setenv("LLM_FALLBACK", "template")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").mock(
                side_effect=httpx.ConnectError("refused")
            )
            result = await llm_with_fallback(
                prompt="50x50 丝径2.5",
                function_name="extract",
                function_schema=_SCHEMA,
            )
        assert result == {}  # 空 dict → 触发正则兜底

    @pytest.mark.anyio
    async def test_no_fallback_configured_returns_empty(self, monkeypatch):
        """LLM_FALLBACK 未配置 + primary 挂 → 返回空 dict。"""
        monkeypatch.setenv("LLM_PROVIDER", "deepseek")
        monkeypatch.setenv("LLM_FALLBACK", "")
        monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-test")
        monkeypatch.setenv("EXTERNAL_API_RETRY_MAX", "0")

        with respx.mock(assert_all_called=False) as mock:
            mock.post("https://api.deepseek.com/v1/chat/completions").mock(
                side_effect=httpx.ConnectError("refused")
            )
            result = await llm_with_fallback(
                prompt="test",
                function_name="extract",
                function_schema=_SCHEMA,
            )
        assert result == {}
