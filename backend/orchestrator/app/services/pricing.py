"""Kaas v2 · 定价引擎 (§5 T6)

三条路径:
- matched: 精确匹配（spec_hash 命中 quotations 表）
- estimated: 相似规格估算（KB 检索 + LLM 推算）
- spec_not_supported: 无法报价

铁律1: 报价范围判断由代码规则决定，AI 不做 scope decisions。
铁律2: 报价结果永远不进入向量数据库。
铁律3: 价格查询优先走 SQL 精确匹配。
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.spec_hash import compute_spec_hash
from app.domain.dataset_routing import build_dataset_ids
from app.repositories.quotations_repo import get_latest_price, insert_quotation
from app.services.kb_client import get_kb_client
from app.services.llm_client import get_llm_client


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
    3. 未命中 → KB 检索相似规格 → LLM 估算
    4. 都失败 → spec_not_supported
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

    # ── Path 2: KB 估算 ──
    datasets = build_dataset_ids(product_category, customer_id, product_spec)
    kb = get_kb_client(customer_id)
    kb_results = await kb.search(datasets, str(product_spec), top_k=3)

    if kb_results:
        best = kb_results[0]
        # 代码规则判断相似度（铁律1: 非 AI scope decision）
        confidence = _assess_confidence(product_spec, best.get("spec", {}))
        if confidence == "low":
            return PricingResult(
                status="spec_not_supported",
                unit_price=None,
                currency="CNY",
                unit=best.get("unit", ""),
                confidence="low",
                source="kb_estimated",
                spec_hash=spec_hash,
                notes="KB 检索结果相似度过低，无法报价",
            )

        price = best.get("unit_price")
        if quantity > 100:
            # 大批量折扣规则（代码规则，非 AI）
            price = price * 0.95

        return PricingResult(
            status="estimated",
            unit_price=price,
            currency="CNY",
            unit=best.get("unit", ""),
            confidence=confidence,
            source="kb_estimated",
            spec_hash=spec_hash,
            notes="基于相似规格估算",
        )

    # ── Path 3: 完全不支持 ──
    return PricingResult(
        status="spec_not_supported",
        unit_price=None,
        currency="CNY",
        unit="",
        confidence="low",
        source="kb_estimated",
        spec_hash=spec_hash,
        notes="未找到可参考的规格数据",
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


def _assess_confidence(request_spec: dict, kb_spec: dict) -> str:
    """代码规则评估规格相似度（铁律1: 非 AI）。

    规则:
    - 网孔尺寸完全一致 → high
    - 丝径偏差 < 0.5mm → medium
    - 其他 → low
    """
    if request_spec == kb_spec:
        return "high"

    req_mesh = request_spec.get("mesh") or request_spec.get("mesh_size", "")
    kb_mesh = kb_spec.get("mesh") or kb_spec.get("mesh_size", "")
    if req_mesh and kb_mesh and req_mesh == kb_mesh:
        return "medium"

    req_wire = request_spec.get("wire") or request_spec.get("wire_diameter", 0)
    kb_wire = kb_spec.get("wire") or kb_spec.get("wire_diameter", 0)
    if req_wire and kb_wire:
        try:
            if abs(float(req_wire) - float(kb_wire)) < 0.5:
                return "medium"
        except (ValueError, TypeError):
            pass

    return "low"
