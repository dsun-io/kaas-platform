"""外部单证上传落库

Revision ID: 202610100005
Revises: 202610100004
Create Date: 2026-10-10

外部获取的单证（PDF/图片等）手动上传挂到订单，落库持久化；与系统生成单证同台账。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610100005"
down_revision: Union[str, None] = "202610100004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "external_doc_uploads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("order_id", sa.BigInteger(), nullable=True),
        sa.Column("quote_order_id", sa.BigInteger(), nullable=True),
        sa.Column("inquiry_id", sa.BigInteger(), nullable=True),
        sa.Column("customer_id", sa.Text(), nullable=True),
        sa.Column("doc_type", sa.Text(), nullable=True),
        sa.Column("file_name", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=True),
        sa.Column("file_size", sa.Numeric(), nullable=True),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="draft"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("uploaded_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_external_docs_tenant", "external_doc_uploads", ["tenant_id", "doc_type", "status"])
    op.create_index("idx_external_docs_order", "external_doc_uploads", ["tenant_id", "order_id"])


def downgrade() -> None:
    op.drop_index("idx_external_docs_order", table_name="external_doc_uploads")
    op.drop_index("idx_external_docs_tenant", table_name="external_doc_uploads")
    op.drop_table("external_doc_uploads")
