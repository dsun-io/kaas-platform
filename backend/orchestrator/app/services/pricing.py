"""Kaas v2 · 定价引擎 (§5 T6)

三条路径:
- matched: 精确匹配（spec_hash 命中 quotations 表）
- estimated: 相似规格估算（结构化 DB 查找 + 文本知识参考）
- spec_not_supported: 无法报价

铁律1: 报价范围判断由代码规则决定，AI 不做 scope decisions。
铁律2: 报价结果永远不进入向量数据库。
铁律3: 价格查询优先走 SQL 精确匹配。
铁律4: FastGPT 不参与报价决策。所有报价数据来自结构化 DB。
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.spec_hash import compute_spec_hash
from app.repositories.quotations_repo import get_latest_price, insert_quotation
from app.services.knowledge_service import get_knowledge_service


@dataclass
class PricingResult:
    status: str  # matched | estimated | spec_not_supported
    unit_price: Optional[float]
    currency: str
    unit: str
    confidence: str  # high | medium | low
    source: str  # quotations_db | L1_L2_formula | kb_estimated
    spec_hash: str
    notes: Optional[str] = None


async def get_price(
    db: AsyncSession,
    customer_id: str,
    product_category: str,
    product_spec: dict,
    quantity: int = 1,
) -> PricingResult:
    """报价主流程。

    1. 计算 spec_hash，查 quotations 表（精确匹配）
    2. 命中 → matched / high / quotations_db
    3. 未命中 → 结构化 DB 匹配 + 文本知识参考 → estimated
    4. 都失败 → spec_not_supported

    铁律4: FastGPT 不参与报价决策。
    """
    spec_hash = compute_spec_hash(product_spec)

    # ── Path 1: 精确匹配 ──
    latest = await get_latest_price(
        db, customer_id=customer_id,
        product_category=product_category,
        spec_hash=spec_hash,
    )
    if latest and latest.unit_price is not None:
        discount = float(latest.discount) if latest.discount else None
        price = float(latest.unit_price)
        if discount:
            price = price * (1 - discount)
        return PricingResult(
            status="matched",
            unit_price=price,
            currency=latest.currency,
            unit=latest.unit,
            confidence="high",
            source="quotations_db",
            spec_hash=spec_hash,
        )

    # ── Path 2: 文本知识参考（仅为上下文，不作定价依据） ──
    try:
        svc = get_knowledge_service(customer_id)
        hits = await svc.search_text_knowledge(
            tenant_id=customer_id,
            query_text=str(product_spec),
            customer_id=customer_id,
            product_category=product_category,
            knowledge_types=["product_desc", "faq"],
            limit=3,
        )
        ref_notes = f"参考: {'; '.join(h.content[:100] for h in hits[:2])}" if hits else None
    except Exception:
        ref_notes = None

    # ── Path 3: 完全不支持 ──
    return PricingResult(
        status="spec_not_supported",
        unit_price=None,
        currency="CNY",
        unit="",
        confidence="low",
        source="kb_estimated",
        spec_hash=spec_hash,
        notes=ref_notes or "未找到可参考的规格数据",
    )


async def record_quotation(
    db: AsyncSession,
    customer_id: str,
    product_category: str,
    product_spec: dict,
    result: PricingResult,
    created_by: Optional[str] = None,
):
    """将报价结果写入 quotations 表 (INSERT-only · 铁律5)。"""
    await insert_quotation(
        session=db,
        customer_id=customer_id,
        product_category=product_category,
        product_spec=product_spec,
        spec_hash=result.spec_hash,
        unit_price=result.unit_price,
        currency=result.currency,
        unit=result.unit,
        discount=None,
        min_quantity=None,
        source=result.source,
        notes=result.notes,
        created_by=created_by,
    )
