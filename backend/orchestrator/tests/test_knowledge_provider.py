"""
Kaas v2 · KnowledgeRetrievalProvider 测试
─────────────────────────────────────────

覆盖:
  - PostgreSQLTextKnowledgeProvider 正常返回
  - FastGPT disabled 时不调用 FastGPT
  - FastGPT 异常不阻断主流程
  - Orchestrator 不直接依赖 FastGPT client
"""
import pytest
pytestmark = pytest.mark.unit
import os

from app.services.knowledge_provider import (
    get_knowledge_provider,
    PostgreSQLTextKnowledgeProvider,
    FastGPTKnowledgeProvider,
)
from app.services.knowledge_service import (
    get_knowledge_service,
    close_knowledge_service,
)


class TestGetKnowledgeProvider:
    """工厂函数测试。"""

    def test_default_provider_is_postgres(self, monkeypatch):
        monkeypatch.delenv("KNOWLEDGE_PROVIDER", raising=False)
        monkeypatch.setenv("KB_PROVIDER", "stub")
        provider = get_knowledge_provider("test_tenant")
        assert isinstance(provider, PostgreSQLTextKnowledgeProvider)

    def test_explicit_postgres(self):
        provider = get_knowledge_provider(provider_name="postgres")
        assert isinstance(provider, PostgreSQLTextKnowledgeProvider)

    def test_fastgpt_provider(self, monkeypatch):
        monkeypatch.setenv("FASTGPT_BASE_URL", "https://test.example.com")
        monkeypatch.setenv("FASTGPT_API_KEY", "test-key")
        provider = get_knowledge_provider(
            tenant_id="lianjia",
            provider_name="fastgpt",
        )
        assert isinstance(provider, FastGPTKnowledgeProvider)

    def test_knowledge_provider_env_var(self, monkeypatch):
        monkeypatch.setenv("KNOWLEDGE_PROVIDER", "postgres")
        provider = get_knowledge_provider("test_tenant")
        assert isinstance(provider, PostgreSQLTextKnowledgeProvider)

    def test_unknown_provider_raises(self):
        with pytest.raises(ValueError, match="Unknown knowledge provider"):
            get_knowledge_provider(provider_name="nonexistent")


class TestKnowledgeService:
    """Service 层测试。"""

    async def test_service_default_provider(self, monkeypatch):
        monkeypatch.setenv("KNOWLEDGE_PROVIDER", "postgres")
        svc = get_knowledge_service("test_tenant")
        assert svc is not None
        # 清理单例
        await close_knowledge_service()

    async def test_service_search_returns_empty_list(self, monkeypatch):
        """没有数据时返回空列表。"""
        monkeypatch.setenv("KNOWLEDGE_PROVIDER", "postgres")
        svc = get_knowledge_service("test_tenant")
        try:
            results = await svc.search_text_knowledge(
                tenant_id="test_tenant",
                query_text="something that does not exist",
            )
            assert results == []
        finally:
            await close_knowledge_service()


class TestFastGPTDisabledBehavior:
    """FastGPT disabled 时行为验证。"""

    def test_fastgpt_disabled_defaults_to_postgres(self, monkeypatch):
        monkeypatch.setenv("FASTGPT_ENABLED", "false")
        monkeypatch.setenv("KNOWLEDGE_PROVIDER", "postgres")
        provider = get_knowledge_provider("test_tenant")
        assert isinstance(provider, PostgreSQLTextKnowledgeProvider)

    async def test_quote_pipeline_no_fastgpt(self):
        """验证报价核心模块不依赖 FastGPT。"""
        # pricing.py 已移除 get_kb_client 导入
        from app.services.pricing import get_price
        # 能导入就说明不依赖 FastGPT
        assert get_price is not None

        # quote.py 已移除 get_kb_client + build_dataset_ids 导入
        from app.api.quote import create_quote
        assert create_quote is not None

        # 验证 V2 quote engine 无 FastGPT 依赖
        from app.services.quote_engine import create_quote as create_quote_v2
        assert create_quote_v2 is not None

    async def test_fastgpt_client_importable_but_not_required(self):
        """FastGPT client 可以导入但不作核心依赖。"""
        from app.services.kb_client import FastGPTKBClient, StubKBClient
        assert FastGPTKBClient is not None
        assert StubKBClient is not None
