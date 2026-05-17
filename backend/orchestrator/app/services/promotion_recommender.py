"""
晋升推荐引擎 — 基于 trigram 相似度 + 多租户使用频次 + 时间窗口

推荐条件（方案 7.1 节）:
1. trigram 相似度 ≥ 0.85（与公库已有属性比较）
2. ≥ 3 个不同租户提交过该属性
3. 30 天内有新提交
"""
from datetime import datetime, timedelta, timezone
from sqlalchemy import select, func, and_, distinct
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import AttributeProposal, SpecAttribute


TRIGRAM_THRESHOLD = 0.85
MIN_TENANT_COUNT = 3
RECENT_DAYS = 30


async def compute_recommendation_scores(db: AsyncSession) -> list[dict]:
    """
    计算所有 pending 状态提案的推荐分数。
    返回 [{proposal_id, score, recommended}] 列表。
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=RECENT_DAYS)

    # 获取所有 pending 提案
    stmt = select(AttributeProposal).where(AttributeProposal.status == "pending")
    result = await db.execute(stmt)
    proposals = result.scalars().all()

    if not proposals:
        return []

    # 获取公库属性名称（用于 trigram 比较）
    stmt_pub = select(SpecAttribute.name).where(SpecAttribute.scope == "public")
    pub_result = await db.execute(stmt_pub)
    public_names = [r[0] for r in pub_result.all()]

    results = []
    for p in proposals:
        score = 0.0

        # 1. 租户数量分数 (0-40 分)
        tenant_count_stmt = (
            select(func.count(distinct(AttributeProposal.tenant_id)))
            .where(
                and_(
                    func.lower(AttributeProposal.proposed_name) == p.proposed_name.lower(),
                    AttributeProposal.status.in_(["pending", "promoted"]),
                )
            )
        )
        tenant_count_result = await db.execute(tenant_count_stmt)
        tenant_count = tenant_count_result.scalar() or 0
        tenant_score = min(tenant_count / MIN_TENANT_COUNT, 1.0) * 40

        # 2. 最近提交时间分数 (0-30 分)
        recent_stmt = (
            select(func.max(AttributeProposal.created_at))
            .where(
                and_(
                    func.lower(AttributeProposal.proposed_name) == p.proposed_name.lower(),
                    AttributeProposal.created_at >= cutoff,
                )
            )
        )
        recent_result = await db.execute(recent_stmt)
        latest = recent_result.scalar()
        recency_score = 30.0 if latest else 0.0

        # 3. Trigram 相似度分数 (0-30 分)
        # 与公库属性比较，取最高相似度
        max_sim = 0.0
        if public_names:
            sim_stmt = select(
                func.max(func.similarity(SpecAttribute.name, p.proposed_name))
            ).where(SpecAttribute.scope == "public")
            sim_result = await db.execute(sim_stmt)
            max_sim = sim_result.scalar() or 0.0
        trigram_score = min(max_sim / TRIGRAM_THRESHOLD, 1.0) * 30

        score = tenant_score + recency_score + trigram_score
        recommended = (
            tenant_count >= MIN_TENANT_COUNT
            and max_sim >= TRIGRAM_THRESHOLD
            and latest is not None
        )

        results.append({
            "proposal_id": p.id,
            "score": round(score, 2),
            "recommended": recommended,
            "tenant_count": tenant_count,
            "max_similarity": round(max_sim, 4),
        })

    return results


async def update_recommendations(db: AsyncSession) -> int:
    """
    更新所有 pending 提案的推荐状态。
    返回更新数量。
    """
    scores = await compute_recommendation_scores(db)
    updated = 0

    for item in scores:
        proposal = await db.get(AttributeProposal, item["proposal_id"])
        if not proposal:
            continue

        proposal.recommendation_score = item["score"]
        proposal.recommended_for_promotion = item["recommended"]
        if item["recommended"] and not proposal.recommended_at:
            proposal.recommended_at = datetime.now(timezone.utc)
        updated += 1

    await db.flush()
    return updated
