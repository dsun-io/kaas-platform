"""删除通用聊天残留表：conversations / conversation_messages

通用聊天（conversation_orchestrator）已随方向调整移除，对话表不再使用。
种子数据不涉及这两张表，不受影响。
降级可完整还原两表（DDL 与 202605050001_auth_wx_r1 一致）。

Revision ID: 202609230001
Revises: 20260922_research_workstation
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "202609230001"
down_revision = "20260922_research_workstation"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("conversation_messages")
    op.drop_table("conversations")


def downgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_conv_customer", "conversations", ["customer_id"])
    op.create_index("idx_conv_channel", "conversations", ["channel"])

    op.create_table(
        "conversation_messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("conversation_id", sa.BigInteger(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("raw_content", sa.Text(), nullable=True),
        sa.Column("normalized_content", sa.Text(), nullable=True),
        sa.Column("intent", sa.Text(), nullable=True),
        sa.Column("product_category", sa.Text(), nullable=True),
        sa.Column("extracted_params_json", postgresql.JSONB(), nullable=True),
        sa.Column("quote_status", sa.Text(), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_conv_msg_conv", "conversation_messages", ["conversation_id"])
