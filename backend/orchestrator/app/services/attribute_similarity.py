"""
属性相似度检测 — pg_trgm 基于 trigram 的模糊匹配。
"""
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

SIMILARITY_THRESHOLD = 0.6


async def find_similar_attributes(
    db: AsyncSession,
    proposed_name: str,
    tenant_id: str,
    category_id: int,
    group_code: str,
    threshold: float = SIMILARITY_THRESHOLD,
    limit: int = 10,
) -> list:
    """查找与 proposed_name 相似的已有属性（公库 + 本租户私库）。"""
    rows = await db.execute(text("""
        SELECT a.id, a.code, a.name, a.scope, a.unit, a.unit_group, a.data_type,
               similarity(a.name, :name) AS score
        FROM spec_attributes a
        WHERE a.status = 'active'
          AND a.group_code = :group
          AND (a.scope = 'public' OR (a.scope = 'private' AND a.tenant_id = :tenant))
          AND (similarity(a.name, :name) > :threshold OR a.aliases ? :name)
        ORDER BY score DESC
        LIMIT :limit
    """), {
        "name": proposed_name,
        "group": group_code,
        "tenant": tenant_id,
        "threshold": threshold,
        "limit": limit,
    })
    return rows.fetchall()
