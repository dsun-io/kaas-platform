"""
Kaas v2 · LLM Client 抽象层 (§13.1)
────────────────────────────────────
ABC + DeepSeekClient + ZhipuClient + TemplateOnlyClient + StubLLMClient。
工厂函数 + fallback 链，组件可热替换（铁律5）。
"""
import os
import re
import json
import time
import structlog
from abc import ABC, abstractmethod

import httpx
from app.services.http_utils import retry_request
from app.core.metrics import LLM_LATENCY, LLM_FALLBACK_TOTAL

logger = structlog.get_logger(__name__)


class LLMClient(ABC):
    @abstractmethod
    async def function_call(
        self,
        prompt: str,
        function_name: str,
        function_schema: dict,
        context: dict | None = None,
    ) -> dict:
        """LLM Function Calling，返回结构化 JSON。"""

    @abstractmethod
    async def generate_script(self, template_context: dict) -> str:
        """末端话术包装，返回自然语言文本。"""

    async def close(self):
        """可选资源清理。"""
        pass


# ═══════════════════════════════════════════════════════════════════
# Stub (开发/测试)
# ═══════════════════════════════════════════════════════════════════

class StubLLMClient(LLMClient):
    """本轮测试用 stub：简单正则提取 + 固定话术。"""

    async def function_call(
        self,
        prompt: str,
        function_name: str,
        function_schema: dict,
        context: dict | None = None,
    ) -> dict:
        result: dict = {}
        for field_name, field_info in function_schema.get(
            "parameters", {}
        ).get("properties", {}).items():
            if field_info.get("type") == "number" or field_info.get("type") == "integer":
                match = re.search(
                    rf"{field_name}[：:]*\s*(\d+(?:\.\d+)?)", prompt, re.IGNORECASE
                )
                if match:
                    result[field_name] = (
                        int(match.group(1))
                        if field_info.get("type") == "integer"
                        else float(match.group(1))
                    )
        return result

    async def generate_script(self, template_context: dict) -> str:
        unit_price = template_context.get("unit_price", "N/A")
        unit = template_context.get("unit", "")
        return f"【参考报价】{unit_price} {unit}"


# ═══════════════════════════════════════════════════════════════════
# DeepSeekClient (§13.1)
# ═══════════════════════════════════════════════════════════════════

class DeepSeekClient(LLMClient):
    """DeepSeek Function Calling API 客户端。"""

    def __init__(self):
        self.api_key = os.environ["DEEPSEEK_API_KEY"]
        self.base_url = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
        self.timeout = float(os.getenv("LLM_TIMEOUT_SECONDS", "15"))
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=self.timeout,
        )

    async def function_call(
        self,
        prompt: str,
        function_name: str,
        function_schema: dict,
        context: dict | None = None,
    ) -> dict:
        start = time.perf_counter()
        try:
            system_prompt = "你是一个参数提取助手。从用户消息中提取结构化参数。"
            if context and context.get("product_category"):
                system_prompt += f"\n产品品类：{context['product_category']}"

            tools = [{
                "type": "function",
                "function": {
                    "name": function_name,
                    "description": "从用户消息中提取报价参数",
                    "parameters": function_schema,
                }
            }]

            resp = await retry_request(
                self._client, "POST", "/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                    "tools": tools,
                    "tool_choice": {"type": "function", "function": {"name": function_name}},
                    "temperature": 0,
                    "max_tokens": 500,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            tool_call = data["choices"][0]["message"]["tool_calls"][0]
            return json.loads(tool_call["function"]["arguments"])
        finally:
            elapsed = time.perf_counter() - start
            LLM_LATENCY.labels(provider="deepseek", operation="function_call").observe(elapsed)

    async def generate_script(self, template_context: dict) -> str:
        start = time.perf_counter()
        try:
            product_category = template_context.get("product_category", "")
            spec_summary = template_context.get("spec_summary", "")
            price_range = template_context.get("price_range", "")
            prompt = (
                f"你是一个五金丝网行业的报价助手。请根据以下信息生成一段简洁专业的报价话术，"
                f"供业务员直接复制发给客户。\n\n"
                f"产品：{product_category}\n"
                f"规格：{spec_summary}\n"
                f"参考价区间：{price_range}\n"
                f"⚠️ 必须包含'参考价 - 需人工确认'的提醒。"
            )
            resp = await retry_request(
                self._client, "POST", "/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 300,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        finally:
            elapsed = time.perf_counter() - start
            LLM_LATENCY.labels(provider="deepseek", operation="generate_script").observe(elapsed)

    async def close(self):
        await self._client.aclose()


# ═══════════════════════════════════════════════════════════════════
# ZhipuClient (§13.1 · fallback)
# ═══════════════════════════════════════════════════════════════════

class ZhipuClient(LLMClient):
    """智谱 GLM-4 备选（DeepSeek 挂时降级）。"""

    def __init__(self):
        self.api_key = os.environ.get("ZHIPU_API_KEY", "")
        self.base_url = os.getenv("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")
        self.model = os.getenv("ZHIPU_MODEL", "glm-4")
        self.timeout = float(os.getenv("LLM_TIMEOUT_SECONDS", "15"))
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=self.timeout,
        )

    async def function_call(
        self,
        prompt: str,
        function_name: str,
        function_schema: dict,
        context: dict | None = None,
    ) -> dict:
        start = time.perf_counter()
        try:
            system_prompt = "你是一个参数提取助手。从用户消息中提取结构化参数。"
            if context and context.get("product_category"):
                system_prompt += f"\n产品品类：{context['product_category']}"

            tools = [{
                "type": "function",
                "function": {
                    "name": function_name,
                    "description": "从用户消息中提取报价参数",
                    "parameters": function_schema,
                }
            }]

            resp = await retry_request(
                self._client, "POST", "/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": prompt},
                    ],
                    "tools": tools,
                    "tool_choice": {"type": "function", "function": {"name": function_name}},
                    "temperature": 0,
                    "max_tokens": 500,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            tool_call = data["choices"][0]["message"]["tool_calls"][0]
            return json.loads(tool_call["function"]["arguments"])
        finally:
            elapsed = time.perf_counter() - start
            LLM_LATENCY.labels(provider="zhipu", operation="function_call").observe(elapsed)

    async def generate_script(self, template_context: dict) -> str:
        start = time.perf_counter()
        try:
            prompt = (
                f"你是一个五金丝网行业的报价助手。\n"
                f"产品：{template_context.get('product_category', '')}\n"
                f"规格：{template_context.get('spec_summary', '')}\n"
                f"参考价区间：{template_context.get('price_range', '')}\n"
                f"⚠️ 必须包含'参考价 - 需人工确认'的提醒。"
            )
            resp = await retry_request(
                self._client, "POST", "/v1/chat/completions",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.3,
                    "max_tokens": 300,
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        finally:
            elapsed = time.perf_counter() - start
            LLM_LATENCY.labels(provider="zhipu", operation="generate_script").observe(elapsed)

    async def close(self):
        await self._client.aclose()


# ═══════════════════════════════════════════════════════════════════
# TemplateOnlyClient (§13.1 · 零 LLM 终极降级)
# ═══════════════════════════════════════════════════════════════════

class TemplateOnlyClient(LLMClient):
    """LLM 全挂时的纯模板降级（零外部调用）。"""

    async def function_call(
        self, prompt: str, function_name: str,
        function_schema: dict, context: dict | None = None,
    ) -> dict:
        return {}  # 触发 extractor.py 的正则兜底

    async def generate_script(self, template_context: dict) -> str:
        from app.services.quote_templates import render_script_template_only
        return render_script_template_only(template_context)


# ═══════════════════════════════════════════════════════════════════
# 工厂 + fallback 链 (§13.2)
# ═══════════════════════════════════════════════════════════════════

_LLM_CLIENTS: dict[str, type[LLMClient]] = {
    "deepseek": DeepSeekClient,
    "zhipu": ZhipuClient,
    "template": TemplateOnlyClient,
    "stub": StubLLMClient,
}


def get_llm_client() -> LLMClient:
    """工厂函数，读 LLM_PROVIDER env 决定实例。"""
    provider = os.environ.get("LLM_PROVIDER", "stub")
    cls = _LLM_CLIENTS.get(provider)
    if not cls:
        raise ValueError(f"Unknown LLM_PROVIDER: {provider}")
    return cls()


async def llm_with_fallback(
    prompt: str,
    function_name: str,
    function_schema: dict,
    context: dict | None = None,
) -> dict:
    """带 fallback 的 LLM 调用链。

    LLM_PROVIDER → LLM_FALLBACK → template（零 LLM）
    """
    primary_provider = os.getenv("LLM_PROVIDER", "stub")
    primary = get_llm_client()
    try:
        return await primary.function_call(prompt, function_name, function_schema, context)
    except Exception as e:
        logger.warning("primary_llm_failed", provider=primary_provider, error=str(e))

    fallback_provider = os.getenv("LLM_FALLBACK")
    if fallback_provider and fallback_provider != primary_provider:
        fallback_cls = _LLM_CLIENTS.get(fallback_provider)
        if fallback_cls:
            try:
                fallback = fallback_cls()
                result = await fallback.function_call(prompt, function_name, function_schema, context)
                LLM_FALLBACK_TOTAL.labels(
                    primary=primary_provider, fallback=fallback_provider, outcome="fallback_success"
                ).inc()
                return result
            except Exception as e:
                logger.warning("fallback_llm_failed", provider=fallback_provider, error=str(e))

    # 终极降级：返回空 dict，触发 extractor.py 正则兜底
    LLM_FALLBACK_TOTAL.labels(
        primary=primary_provider, fallback=fallback_provider or "none", outcome="all_failed"
    ).inc()
    logger.error("all_llm_failed_fallback_to_regex")
    return {}
