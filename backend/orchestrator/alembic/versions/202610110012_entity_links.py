"""关系建模优化 P1：回填归属列 + 建立通用边表 `entity_links` 并迁入现有关系

Revision ID: 202610110012
Revises: 202610110011
Create Date: 2026-10-11

依据：`docs/ENTITY_LINKS_OPTIMIZATION.md`

本迁移做两件事
--------------
**一、把归属列补成"主归属"（读侧兜底将来才能安全删除）**
- `trade_docs.quote_id` ← `trade_doc_quote_refs`
- `trade_docs.order_id` ← `trade_doc_order_refs`
- `orders.quote_id`     ← `order_quote_refs`
（只补列为空的行，不覆盖已有值 —— 列是主口径）

**二、建通用边表 `entity_links` 并迁入现有关系**
一张表装下所有关系，替代"一个关系一张表"：
- 支持多对多（一张单证由多个报价合并生成）、关系类型（`rel_type`）、关系自身属性（`meta`）、关系变更史（软删保留）
- 已知代价：`src_id`/`dst_id` 多态 → **加不了外键**，删实体不会自动清边 → 用软删 + 巡检兜（见方案 §6）

迁入范围：`order_quote_refs` / `trade_doc_quote_refs` / `trade_doc_order_refs`
（`trade_doc_inquiry_refs` / `trade_doc_doc_refs` / 出运关联表列名未逐一核对，
 留待后续阶段迁入 —— 本迁移不动它们，也不删除任何旧表）
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610110012"
down_revision: Union[str, None] = "202610110011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 一、回填归属列（列为主口径，故只补空值）──
    #
    # ⚠️ 关键陷阱：`ck_*_has_customer` / `ck_doc_single_parent` 是用 `NOT VALID` 加的，
    # 它只豁免"建约束之前就在表里的行"；**一旦某行被 UPDATE，约束就会重新校验**。
    # 所以回填必须排除"本来就不满足约束"的行，否则整个迁移会因 CheckViolation 回滚：
    #   - customer_id IS NULL 的历史行（如本库 3 行演示单证）→ 不能碰，
    #     它们保留 NULL 列 + refs 表关系，读侧兜底照常把它们显示在报价下
    #   - 已经有 order_id 的行 → 不能再补 quote_id（二选一）
    op.execute(sa.text(
        "UPDATE trade_docs d SET quote_id = r.quote_order_id"
        " FROM trade_doc_quote_refs r"
        " WHERE r.trade_doc_id = d.id AND d.quote_id IS NULL"
        "   AND d.order_id IS NULL AND d.customer_id IS NOT NULL"
        "   AND r.quote_order_id IS NOT NULL"
    ))
    op.execute(sa.text(
        "UPDATE trade_docs d SET order_id = r.order_id"
        " FROM trade_doc_order_refs r"
        " WHERE r.trade_doc_id = d.id AND d.order_id IS NULL"
        "   AND d.quote_id IS NULL AND d.customer_id IS NOT NULL"
        "   AND r.order_id IS NOT NULL"
    ))
    op.execute(sa.text(
        "UPDATE orders o SET quote_id = r.quote_order_id"
        " FROM order_quote_refs r"
        " WHERE r.order_id = o.id AND o.quote_id IS NULL"
        "   AND o.customer_id IS NOT NULL"
        "   AND r.quote_order_id IS NOT NULL"
    ))

    # ── 二、通用边表 ──
    op.create_table(
        "entity_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("src_type", sa.Text(), nullable=False),   # quote / order / trade_doc / customer / user
        sa.Column("src_id", sa.BigInteger(), nullable=False),
        sa.Column("dst_type", sa.Text(), nullable=False),
        sa.Column("dst_id", sa.BigInteger(), nullable=False),
        sa.Column("rel_type", sa.Text(), nullable=False),   # generated_from / merged_into / revision_of / can_access
        sa.Column("meta", postgresql.JSONB(), nullable=True),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),  # 关系失效软删，保留历史
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "src_type", "src_id", "dst_type", "dst_id", "rel_type",
                            name="uq_entity_links"),
    )
    # 双向查询各一个部分索引（只索引有效关系）
    op.execute(sa.text(
        "CREATE INDEX idx_entity_links_src ON entity_links"
        " (tenant_id, src_type, src_id, rel_type) WHERE deleted_at IS NULL"))
    op.execute(sa.text(
        "CREATE INDEX idx_entity_links_dst ON entity_links"
        " (tenant_id, dst_type, dst_id, rel_type) WHERE deleted_at IS NULL"))

    # ── 三、迁入现有关系（旧表不动，本阶段双轨）──
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'order', order_id, 'quote', quote_order_id,"
        "        COALESCE(ref_type, 'generated_from')"
        " FROM order_quote_refs WHERE order_id IS NOT NULL AND quote_order_id IS NOT NULL"
        " ON CONFLICT DO NOTHING"
    ))
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'trade_doc', trade_doc_id, 'quote', quote_order_id,"
        "        COALESCE(ref_type, 'generated_from')"
        " FROM trade_doc_quote_refs WHERE trade_doc_id IS NOT NULL AND quote_order_id IS NOT NULL"
        " ON CONFLICT DO NOTHING"
    ))
    op.execute(sa.text(
        "INSERT INTO entity_links (tenant_id, src_type, src_id, dst_type, dst_id, rel_type)"
        " SELECT tenant_id, 'trade_doc', trade_doc_id, 'order', order_id,"
        "        COALESCE(ref_type, 'generated_from')"
        " FROM trade_doc_order_refs WHERE trade_doc_id IS NOT NULL AND order_id IS NOT NULL"
        " ON CONFLICT DO NOTHING"
    ))


def downgrade() -> None:
    """只撤销边表。**不回退归属列的回填** —— 列是主口径，回退会让数据重新变空。"""
    op.execute(sa.text("DROP INDEX IF EXISTS idx_entity_links_dst"))
    op.execute(sa.text("DROP INDEX IF EXISTS idx_entity_links_src"))
    op.drop_table("entity_links")
