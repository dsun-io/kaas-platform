"""Kaas v2 · 数据集路由 (§5 T4)

确定报价时需要查询的数据集 ID 列表。
规则引擎，非 AI，保证确定性。
"""
from typing import Optional


def build_dataset_ids(
    product_category: str,
    customer_id: Optional[str] = None,
    product_spec: Optional[dict] = None,
) -> list[str]:
    """根据品类+客户上下文构建数据集 ID 列表。

    优先级:
    1. 客户专属价表 (custom:{customer_id}:{category})
    2. 品类通用价表 (standard:{category})
    3. 行业基础价表 (base:industry)
    """
    datasets = []

    # 品类通用价表（总是查询）
    datasets.append(f"standard:{product_category}")

    # 客户专属价表
    if customer_id:
        datasets.insert(0, f"custom:{customer_id}:{product_category}")

    # 行业基础价表（兜底）
    datasets.append("base:industry")

    return datasets
