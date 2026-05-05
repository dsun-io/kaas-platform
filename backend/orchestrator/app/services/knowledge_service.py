"""
Kaas v2 · KnowledgeRetrievalService
───────────────────────────────────
Orchestrator 唯一的知识检索入口。
屏蔽 Provider 差异，提供统一的检索语义。

引用: § 去 FastGPT 架构
  - Orchestrator 不直接调用 FastGPT
  - Orchestrator 不直接调用 kb_client
  - 所有知识检索通过此 Service 中转
"""
from typing import Optional
from app.services.knowledge_provider import (
    KnowledgeRetrievalProvider,
    TextKnowledgeHit,
    get_knowledge_provider,
)


class KnowledgeRetrievalService:
    """
    知识检索服务 — Orchestrator 唯一的知识检索入口。

    职责:
      - 封装 Provider 选择逻辑
      - 支持 tenant/customer 隔离
      - 提供统一检索接口
      - 屏蔽 Provider 差异（postgres / fastgpt 等）
    """

    def __init__(self, provider: KnowledgeRetrievalProvider):
        self._provider = provider

    async def search_text_knowledge(
        self,
        tenant_id: str,
        query_text: str,
        customer_id: Optional[str] = None,
        product_category: Optional[str] = None,
        knowledge_types: Optional[list[str]] = None,
        limit: int = 5,
    ) -> list[TextKnowledgeHit]:
        """
        检索文本知识。

        Args:
            tenant_id: 租户 ID
            query_text: 查询文本
            customer_id: 客户 ID (用于 customer scope 知识隔离)
            product_category: 产品品类过滤
            knowledge_types: 知识类型过滤 ["faq", "script_template", ...]
            limit: 最大返回数量

        Returns:
            命中的文本知识列表，空列表表示无匹配
        """
        return await self._provider.search(
            tenant_id=tenant_id,
            query_text=query_text,
            customer_id=customer_id,
            product_category=product_category,
            knowledge_types=knowledge_types,
            limit=limit,
        )

    async def close(self):
        await self._provider.close()


# ─── 全局 Service 实例 / 工厂（按 tenant_id 隔离） ───

_service_instances: dict[str, KnowledgeRetrievalService] = {}


def get_knowledge_service(
    tenant_id: str = "",
    provider_name: Optional[str] = None,
) -> KnowledgeRetrievalService:
    """
    获取指定租户的 KnowledgeRetrievalService 实例。

    按 tenant_id 缓存：同一租户复用，不同租户隔离。
    """
    if tenant_id not in _service_instances:
        provider = get_knowledge_provider(
            tenant_id=tenant_id,
            provider_name=provider_name,
        )
        _service_instances[tenant_id] = KnowledgeRetrievalService(provider)
    return _service_instances[tenant_id]


async def close_knowledge_service():
    """关闭所有缓存的知识检索服务实例。"""
    for svc in _service_instances.values():
        try:
            await svc.close()
        except Exception:
            pass
    _service_instances.clear()
