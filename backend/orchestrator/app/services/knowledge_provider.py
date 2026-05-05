"""
Kaas v2 · Knowledge Retrieval Provider 抽象层
───────────────────────────────────────────
可插拔的文本知识检索 Provider。
默认使用 PostgreSQL text_knowledge 表。
FastGPT 降级为可选的 runtime adapter，不是核心依赖。

引用: § 去 FastGPT 架构
  - KnowledgeRetrievalProvider — ABC
  - PostgreSQLTextKnowledgeProvider — 默认实现 (Phase 1)
  - FastGPTKnowledgeProvider — 可选 fallback (向后兼容)
  - get_knowledge_provider — 工厂函数
"""
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class TextKnowledgeHit:
    """文本知识检索命中结果。"""
    id: str
    tenant_id: str
    customer_id: Optional[str] = None
    scope: str = "tenant"
    product_category: Optional[str] = None
    knowledge_type: str = ""
    title: str = ""
    content: str = ""
    tags: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    source: str = "manual"
    confidence: Optional[float] = None
    score: Optional[float] = None


class KnowledgeRetrievalProvider(ABC):
    """知识检索 Provider 抽象基类。"""

    @abstractmethod
    async def search(
        self,
        tenant_id: str,
        query_text: str,
        customer_id: Optional[str] = None,
        product_category: Optional[str] = None,
        knowledge_types: Optional[list[str]] = None,
        limit: int = 5,
    ) -> list[TextKnowledgeHit]:
        """搜索文本知识。"""

    async def close(self):
        """可选资源清理。"""
        pass


class PostgreSQLTextKnowledgeProvider(KnowledgeRetrievalProvider):
    """
    默认 Provider — 从 PostgreSQL text_knowledge 表检索。

    Phase 1 使用全文搜索 + keyword/tag/ILIKE 组合检索。
    Phase 2 可升级为 pgvector 向量检索。
    不依赖 FastGPT。
    """

    def __init__(self, db_session_factory=None):
        self._db_session_factory = db_session_factory

    async def search(
        self,
        tenant_id: str,
        query_text: str,
        customer_id: Optional[str] = None,
        product_category: Optional[str] = None,
        knowledge_types: Optional[list[str]] = None,
        limit: int = 5,
    ) -> list[TextKnowledgeHit]:
        """委托 text_knowledge_repo.search_text_knowledge 执行检索。"""
        from app.repositories.text_knowledge_repo import search_text_knowledge as repo_search
        from app.db.session import async_session_factory

        async with async_session_factory() as session:
            try:
                results = await repo_search(
                    session=session,
                    tenant_id=tenant_id,
                    query_text=query_text,
                    customer_id=customer_id,
                    product_category=product_category,
                    knowledge_types=knowledge_types,
                    limit=limit,
                )
                await session.commit()
            except Exception:
                await session.rollback()
                raise

        return [
            TextKnowledgeHit(
                id=str(r.id),
                tenant_id=r.tenant_id,
                customer_id=r.customer_id,
                scope=r.scope,
                product_category=r.product_category,
                knowledge_type=r.knowledge_type,
                title=r.title,
                content=r.content,
                tags=r.tags or [],
                keywords=r.keywords or [],
                source=r.source,
                confidence=float(r.confidence) if r.confidence else None,
                score=None,
            )
            for r in results
        ]


class FastGPTKnowledgeProvider(KnowledgeRetrievalProvider):
    """
    可选 Provider — 包装 FastGPTKBClient 为 KnowledgeRetrievalProvider。

    注意:
      - 此 Provider 只做文本召回，不做任何定价/决策
      - FastGPT 不可用时，系统仍可运行（调用方应处理空结果）
      - 仅作为向后兼容的 fallback，不是默认
    """

    def __init__(self, tenant_id: str):
        self._tenant_id = tenant_id
        self._client = None

    async def _get_client(self):
        if self._client is None:
            from app.services.kb_client import FastGPTKBClient
            self._client = FastGPTKBClient(self._tenant_id)
        return self._client

    async def search(
        self,
        tenant_id: str,
        query_text: str,
        customer_id: Optional[str] = None,
        product_category: Optional[str] = None,
        knowledge_types: Optional[list[str]] = None,
        limit: int = 5,
    ) -> list[TextKnowledgeHit]:
        """通过 FastGPT 做向量检索。"""
        from app.domain.dataset_routing import build_dataset_ids

        try:
            client = await self._get_client()
            dataset_ids = build_dataset_ids(
                product_category or "",
                customer_id,
            )
            results = await client.search(
                dataset_ids=dataset_ids,
                query=query_text,
                top_k=limit,
            )
        except Exception:
            # FastGPT 异常不阻断主流程
            return []

        return [
            TextKnowledgeHit(
                id=str(idx),
                tenant_id=tenant_id,
                customer_id=customer_id,
                scope="tenant",
                product_category=product_category,
                knowledge_type="fastgpt",
                title=item.get("question", ""),
                content=item.get("content", ""),
                tags=[],
                keywords=[],
                source="fastgpt",
                confidence=None,
                score=item.get("score"),
            )
            for idx, item in enumerate(results)
        ]

    async def close(self):
        if self._client:
            await self._client.close()


# ─── Provider registry ───

_PROVIDER_REGISTRY: dict[str, type[KnowledgeRetrievalProvider]] = {
    "postgres": PostgreSQLTextKnowledgeProvider,
    "fastgpt": FastGPTKnowledgeProvider,
}


def get_knowledge_provider(
    tenant_id: str = "",
    provider_name: Optional[str] = None,
) -> KnowledgeRetrievalProvider:
    """
    工厂函数 — 返回指定的 KnowledgeRetrievalProvider。

    provider_name 未指定时，从 KNOWLEDGE_PROVIDER / KB_PROVIDER env 读取。
    默认: postgres (Phase 1)
    向后兼容: fastgpt 仍可使用，但不再是默认
    """
    if provider_name is None:
        provider_name = os.getenv("KNOWLEDGE_PROVIDER", "")
        if not provider_name:
            # 向后兼容: 用 KB_PROVIDER，但截获 stub→postgres
            kb_provider = os.getenv("KB_PROVIDER", "stub")
            provider_name = "fastgpt" if kb_provider == "fastgpt" else "postgres"

    provider_cls = _PROVIDER_REGISTRY.get(provider_name)
    if provider_cls is None:
        raise ValueError(f"Unknown knowledge provider: {provider_name}")

    if provider_name == "fastgpt":
        return provider_cls(tenant_id)
    return provider_cls()
