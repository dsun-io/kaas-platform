"""
⚠️ DEPRECATED — 数据集路由 (§5 T4)

此模块仅用于 FastGPTKnowledgeProvider (可选 Provider) 的 dataset 构建。
默认的 KnowledgeRetrievalProvider (PostgreSQL) 不依赖此模块。
核心路径 (quote / pricing / orchestrator) 已禁止直接 import。

新代码应使用 knowledge_service / knowledge_provider 替代。
"""
import warnings
from typing import Optional


def build_dataset_ids(
    product_category: str,
    customer_id: Optional[str] = None,
    product_spec: Optional[dict] = None,
) -> list[str]:
    """
    ⚠️ DEPRECATED — 仅用于可选的 FastGPTKnowledgeProvider。
       新代码应使用 KnowledgeRetrievalService。

    根据品类+客户上下文构建数据集 ID 列表。
    优先级:
    1. 客户专属价表 (custom:{customer_id}:{category})
    2. 品类通用价表 (standard:{category})
    3. 行业基础价表 (base:industry)
    """
    warnings.warn(
        "build_dataset_ids() is DEPRECATED. Use KnowledgeRetrievalService from knowledge_service module instead.",
        DeprecationWarning,
        stacklevel=2,
    )
    datasets = []

    # 品类通用价表（总是查询）
    datasets.append(f"standard:{product_category}")

    # 客户专属价表
    if customer_id:
        datasets.insert(0, f"custom:{customer_id}:{product_category}")

    # 行业基础价表（兜底）
    datasets.append("base:industry")

    return datasets
