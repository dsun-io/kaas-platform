"""Kaas v2 · services package."""

from app.services.llm_client import (
    LLMClient,
    StubLLMClient,
    DeepSeekClient,
    ZhipuClient,
    TemplateOnlyClient,
    get_llm_client,
    llm_with_fallback,
)
# 保留向后兼容的 KB client 导出，但不再作为核心依赖
from app.services.kb_client import KBClient, StubKBClient, FastGPTKBClient, get_kb_client
from app.services.knowledge_provider import (
    KnowledgeRetrievalProvider,
    TextKnowledgeHit,
    PostgreSQLTextKnowledgeProvider,
    FastGPTKnowledgeProvider,
    get_knowledge_provider,
)
from app.services.knowledge_service import (
    KnowledgeRetrievalService,
    get_knowledge_service,
    close_knowledge_service,
)
from app.services.extractor import extract_product_spec
from app.services.pricing import get_price, record_quotation, PricingResult
from app.services.quote_templates import generate_quote_response, render_script_template_only
from app.services.http_utils import retry_request
from app.services.spec_matcher import match_spec
from app.services.niulanwang_pricing import calculate_base_cost, calculate_tiers
from app.services.accessory_pricing import price_accessories
from app.services.freight_calculator import calculate_freight
from app.services.quote_engine import create_quote
from app.services.quote_script_renderer import render_quote_script

__all__ = [
    # LLM
    "LLMClient",
    "StubLLMClient",
    "DeepSeekClient",
    "ZhipuClient",
    "TemplateOnlyClient",
    "get_llm_client",
    "llm_with_fallback",
    # KB (向后兼容 · 不再作为核心)
    "KBClient",
    "StubKBClient",
    "FastGPTKBClient",
    "get_kb_client",
    # Knowledge Provider (新 · 推荐使用)
    "KnowledgeRetrievalProvider",
    "TextKnowledgeHit",
    "PostgreSQLTextKnowledgeProvider",
    "FastGPTKnowledgeProvider",
    "get_knowledge_provider",
    "KnowledgeRetrievalService",
    "get_knowledge_service",
    "close_knowledge_service",
    # 其他服务
    "extract_product_spec",
    "get_price",
    "record_quotation",
    "PricingResult",
    "generate_quote_response",
    "render_script_template_only",
    "retry_request",
    "match_spec",
    "calculate_base_cost",
    "calculate_tiers",
    "price_accessories",
    "calculate_freight",
    "create_quote",
    "render_quote_script",
]
