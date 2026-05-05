"""add_text_knowledge

去 FastGPT 架构: 自包含文本知识表 text_knowledge

§ 设计目标:
  - 所有文本知识 (FAQ / 话术 / 产品描述 / 售后) 存储在自有 DB
  - 不依赖 FastGPT / 外部向量库
  - Phase 1 全文搜索, Phase 2 可升级 pgvector

Revision ID: 202605040001
Revises: 46708631974a
Create Date: 2026-05-04 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '202605040001'
down_revision: Union[str, None] = '46708631974a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("""
    CREATE TABLE text_knowledge (
        id BIGSERIAL PRIMARY KEY,

        tenant_id TEXT NOT NULL,
        customer_id TEXT,

        scope TEXT NOT NULL DEFAULT 'tenant',
        product_category TEXT,

        knowledge_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,

        tags TEXT[],
        keywords TEXT[],

        source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'active',

        confidence NUMERIC(5,4),
        evidence_count INTEGER NOT NULL DEFAULT 0,

        review_status TEXT NOT NULL DEFAULT 'auto',

        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- CHECK 约束 (§ Phase 1 验收)
        CONSTRAINT ck_text_knowledge_scope
            CHECK (scope IN ('global', 'tenant', 'customer')),
        CONSTRAINT ck_text_knowledge_source
            CHECK (source IN ('manual', 'learned', 'imported', 'system')),
        CONSTRAINT ck_text_knowledge_status
            CHECK (status IN ('active', 'deprecated', 'disabled')),
        CONSTRAINT ck_text_knowledge_review_status
            CHECK (review_status IN ('auto', 'pending_review', 'approved', 'rejected'))
    )
    """)

    # ── B-tree 索引 ──
    op.execute(
        "CREATE INDEX idx_tk_tenant_type "
        "ON text_knowledge (tenant_id, knowledge_type, status)"
    )
    op.execute(
        "CREATE INDEX idx_tk_customer "
        "ON text_knowledge (tenant_id, customer_id, status)"
    )
    op.execute(
        "CREATE INDEX idx_tk_scope "
        "ON text_knowledge (scope, status)"
    )
    op.execute(
        "CREATE INDEX idx_tk_product_category "
        "ON text_knowledge (tenant_id, product_category, status)"
    )

    # ── GIN 索引 (关键词/标签数组 + 全文搜索) ──
    op.execute(
        "CREATE INDEX idx_tk_keywords "
        "ON text_knowledge USING GIN (keywords)"
    )
    op.execute(
        "CREATE INDEX idx_tk_tags "
        "ON text_knowledge USING GIN (tags)"
    )
    op.execute("""
    CREATE INDEX idx_tk_fts
    ON text_knowledge
    USING GIN (
        to_tsvector(
            'simple',
            coalesce(title, '') || ' ' || coalesce(content, '')
        )
    )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS text_knowledge CASCADE")
