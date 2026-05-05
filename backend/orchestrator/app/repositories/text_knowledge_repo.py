"""
Kaas v2 · TextKnowledge 数据访问层
─────────────────────────────────
自包含文本知识存储，不依赖 FastGPT。

引用: § 去 FastGPT 架构 — text_knowledge 表
"""
from typing import Optional
from sqlalchemy import (
    select, func, or_, and_, case,
    TypeDecorator, String,
)
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.models import TextKnowledge


async def create_text_knowledge(
    session: AsyncSession,
    tenant_id: str,
    knowledge_type: str,
    title: str,
    content: str,
    scope: str = "tenant",
    customer_id: Optional[str] = None,
    product_category: Optional[str] = None,
    tags: Optional[list[str]] = None,
    keywords: Optional[list[str]] = None,
    source: str = "manual",
    status: str = "active",
    confidence: Optional[float] = None,
    evidence_count: int = 0,
    review_status: str = "auto",
) -> TextKnowledge:
    """创建一条文本知识记录。"""
    entry = TextKnowledge(
        tenant_id=tenant_id,
        customer_id=customer_id,
        scope=scope,
        product_category=product_category,
        knowledge_type=knowledge_type,
        title=title,
        content=content,
        tags=tags,
        keywords=keywords,
        source=source,
        status=status,
        confidence=confidence,
        evidence_count=evidence_count,
        review_status=review_status,
    )
    session.add(entry)
    await session.flush()
    return entry


async def search_text_knowledge(
    session: AsyncSession,
    tenant_id: str,
    query_text: str,
    customer_id: Optional[str] = None,
    product_category: Optional[str] = None,
    knowledge_types: Optional[list[str]] = None,
    limit: int = 5,
) -> list[TextKnowledge]:
    """
    组合检索文本知识。

    检索策略 (Phase 1 — 不依赖 pgvector):
      1. keywords 精确匹配 (最高优先级)
      2. tags 精确匹配
      3. title ILIKE 模糊匹配
      4. content ILIKE 模糊匹配
      5. to_tsvector 全文搜索兜底

    隔离规则:
      - scope=global: 所有租户可查
      - scope=tenant: 仅当前 tenant 可查
      - scope=customer: 仅当前 tenant+customer 可查
    """
    conditions = [
        TextKnowledge.status == "active",
    ]

    # scope 隔离
    scope_conditions = [
        TextKnowledge.scope == "global",
        and_(
            TextKnowledge.scope == "tenant",
            TextKnowledge.tenant_id == tenant_id,
        ),
    ]
    if customer_id:
        scope_conditions.append(
            and_(
                TextKnowledge.scope == "customer",
                TextKnowledge.tenant_id == tenant_id,
                TextKnowledge.customer_id == customer_id,
            )
        )
    conditions.append(or_(*scope_conditions))

    # product_category 过滤
    if product_category:
        conditions.append(
            or_(
                TextKnowledge.product_category == product_category,
                TextKnowledge.product_category.is_(None),
            )
        )

    # knowledge_type 过滤
    if knowledge_types:
        conditions.append(TextKnowledge.knowledge_type.in_(knowledge_types))

    # 构建 query
    q = select(TextKnowledge).where(*conditions)

    # 关键词匹配: 拆查询文本为词，检查每个词是否在 keywords 数组中出现
    query_words = [w for w in query_text.lower().split() if len(w) > 1]
    query_like = f"%{query_text}%"

    # 排序: keywords/title/content 命中权重递减
    order_exprs = [TextKnowledge.updated_at.desc()]
    if query_words:
        # keywords 数组包含任意查询词 → 最高权重
        order_exprs.insert(0,
            case(
                *[
                    (
                        TextKnowledge.keywords.any(kw),
                        5,
                    ) for kw in query_words
                ],
                else_=0,
            ).desc()
        )
        # tags 数组包含任意查询词
        order_exprs.insert(0,
            case(
                *[
                    (
                        TextKnowledge.tags.any(kw),
                        3,
                    ) for kw in query_words
                ],
                else_=0,
            ).desc()
        )

    # title ILIKE
    order_exprs.insert(0,
        case(
            (TextKnowledge.title.ilike(query_like), 2),
            else_=0,
        ).desc(),
    )
    # content ILIKE
    order_exprs.insert(0,
        case(
            (TextKnowledge.content.ilike(query_like), 1),
            else_=0,
        ).desc(),
    )

    q = q.order_by(*order_exprs).limit(limit)

    result = await session.execute(q)
    return list(result.scalars().all())


async def get_text_knowledge_by_id(
    session: AsyncSession,
    knowledge_id: int,
) -> Optional[TextKnowledge]:
    """按 ID 获取文本知识。"""
    result = await session.execute(
        select(TextKnowledge).where(TextKnowledge.id == knowledge_id)
    )
    return result.scalar_one_or_none()


async def list_text_knowledge(
    session: AsyncSession,
    tenant_id: str,
    knowledge_type: Optional[str] = None,
    product_category: Optional[str] = None,
    status: Optional[str] = None,
    scope: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[TextKnowledge], int]:
    """查询文本知识列表，支持过滤和分页。"""
    conditions = [TextKnowledge.tenant_id == tenant_id]

    if knowledge_type:
        conditions.append(TextKnowledge.knowledge_type == knowledge_type)
    if product_category:
        conditions.append(TextKnowledge.product_category == product_category)
    if status:
        conditions.append(TextKnowledge.status == status)
    if scope:
        conditions.append(TextKnowledge.scope == scope)

    # Count
    count_q = select(func.count()).select_from(TextKnowledge)
    if conditions:
        count_q = count_q.where(*conditions)
    total_result = await session.execute(count_q)
    total = total_result.scalar() or 0

    # Query
    q = (
        select(TextKnowledge)
        .order_by(TextKnowledge.updated_at.desc())
        .limit(limit)
        .offset(offset)
    )
    if conditions:
        q = q.where(*conditions)
    result = await session.execute(q)
    items = list(result.scalars().all())

    return items, total


async def update_text_knowledge_usage(
    session: AsyncSession,
    knowledge_id: int,
) -> None:
    """更新使用计数和最后使用时间。"""
    await session.execute(
        TextKnowledge.__table__.update()
        .where(TextKnowledge.id == knowledge_id)
        .values(
            usage_count=TextKnowledge.usage_count + 1,
            last_used_at=func.now(),
        )
    )


async def soft_delete_text_knowledge(
    session: AsyncSession,
    knowledge_id: int,
) -> bool:
    """软删除 — 将 status 设为 disabled。"""
    result = await session.execute(
        TextKnowledge.__table__.update()
        .where(TextKnowledge.id == knowledge_id)
        .values(status="disabled")
    )
    await session.flush()
    return result.rowcount > 0
