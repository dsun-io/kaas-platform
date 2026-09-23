"""删除微信三表 wechat_bot_accounts / wechat_conversations / wechat_message_events

[Cleanup 1d] David 确认微信模块整体退役（2026-09-22）。
接口、适配器、仓储、ORM 模型已同步删除；此迁移仅负责数据库表清理。
downgrade 可完整重建三表（DDL 与 202605050001_auth_wx_r1 建表一致，可回滚）。
"""

from alembic import op
import sqlalchemy as sa


revision = "202609230002"
down_revision = "202609230001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # FK 依赖顺序：先子表后父表
    op.drop_table("wechat_message_events")
    op.drop_table("wechat_conversations")
    op.drop_table("wechat_bot_accounts")


def downgrade() -> None:
    op.create_table(
        "wechat_bot_accounts",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("bot_name", sa.Text(), nullable=False),
        sa.Column("bot_type", sa.Text(), nullable=False, server_default="clawbot"),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("bot_token_encrypted", sa.Text(), nullable=True),
        sa.Column("last_get_updates_buf", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wx_bot_customer", "wechat_bot_accounts", ["customer_id"])
    op.create_index("idx_wx_bot_tenant", "wechat_bot_accounts", ["tenant_id"])
    op.create_index("idx_wx_bot_status", "wechat_bot_accounts", ["status"])

    op.create_table(
        "wechat_conversations",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("bot_account_id", sa.BigInteger(), nullable=False),
        sa.Column("wechat_session_id", sa.Text(), nullable=False),
        sa.Column("from_user_id", sa.Text(), nullable=False),
        sa.Column("last_context_token_encrypted", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.ForeignKeyConstraint(["bot_account_id"], ["wechat_bot_accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wx_conv_customer", "wechat_conversations", ["customer_id"])
    op.create_index("idx_wx_conv_bot_account", "wechat_conversations", ["bot_account_id"])
    op.create_index("idx_wx_conv_session", "wechat_conversations", ["wechat_session_id"])
    op.create_index("idx_wx_conv_from_user", "wechat_conversations", ["bot_account_id", "from_user_id"])

    op.create_table(
        "wechat_message_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("bot_account_id", sa.BigInteger(), nullable=False),
        sa.Column("wechat_session_id", sa.Text(), nullable=True),
        sa.Column("from_user_id", sa.Text(), nullable=True),
        sa.Column("message_id", sa.Text(), nullable=True),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("message_type", sa.Text(), nullable=False, server_default="text"),
        sa.Column("status", sa.Text(), nullable=False, server_default="received"),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["bot_account_id"], ["wechat_bot_accounts.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_wx_msg_event_bot", "wechat_message_events", ["bot_account_id"])
    op.create_index("idx_wx_msg_event_session", "wechat_message_events", ["wechat_session_id"])
