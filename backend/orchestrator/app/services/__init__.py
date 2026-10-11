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
from app.services.knowledge_provider import (
    KnowledgeRetrievalProvider,
    TextKnowledgeHit,
    PostgreSQLTextKnowledgeProvider,
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
from app.services.accessory_pricing import price_accessories
from app.services.freight_calculator import calculate_freight
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
    # Knowledge Provider
    "KnowledgeRetrievalProvider",
    "TextKnowledgeHit",
    "PostgreSQLTextKnowledgeProvider",
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
    "price_accessories",
    "calculate_freight",
    "render_quote_script",
]
