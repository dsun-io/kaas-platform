"""
AUTH-WX-R1: 双账号类型 + 微信 ClawBot 接入底座

创建表:
- users (双账号: internal / customer)
- customers (客户表)
- user_customers (用户-客户绑定)
- wechat_bot_accounts (微信机器人账号)
- wechat_conversations (微信会话)
- channel_links (渠道链接)
- conversations (对话记录)
- conversation_messages (对话消息)
- usage_events (用量事件)
- wechat_message_events (微信消息事件日志)

Revision ID: 202605050001
Create Date: 2026-05-05
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202605050001"
down_revision: Union[str, None] = "202605040001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users ──
    op.create_table(
        "users",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("account_type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index("idx_users_email", "users", ["email"])
    op.create_index("idx_users_account_type", "users", ["account_type"])

    # ── customers ──
    op.create_table(
        "customers",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("code", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("code"),
    )
    op.create_index("idx_customers_tenant", "customers", ["tenant_id"])
    op.create_index("idx_customers_code", "customers", ["code"])

    # ── user_customers ──
    op.create_table(
        "user_customers",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.BigInteger(), nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_user_customers_user", "user_customers", ["user_id"])
    op.create_index("idx_user_customers_customer", "user_customers", ["customer_id"])

    # ── wechat_bot_accounts ──
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

    # ── wechat_conversations ──
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

    # ── channel_links ──
    op.create_table(
        "channel_links",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=True),
        sa.Column("scenario", sa.Text(), nullable=True),
        sa.Column("link_token", sa.Text(), nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_channel_link_customer", "channel_links", ["customer_id"])
    op.create_index("idx_channel_link_token", "channel_links", ["link_token"])

    # ── conversations ──
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

    # ── conversation_messages ──
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

    # ── usage_events ──
    op.create_table(
        "usage_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("customer_id", sa.BigInteger(), nullable=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("channel", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("success", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_usage_events_customer", "usage_events", ["customer_id"])
    op.create_index("idx_usage_events_type", "usage_events", ["event_type"])

    # ── wechat_message_events ──
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


def downgrade() -> None:
    op.drop_table("wechat_message_events")
    op.drop_table("usage_events")
    op.drop_table("conversation_messages")
    op.drop_table("conversations")
    op.drop_table("channel_links")
    op.drop_table("wechat_conversations")
    op.drop_table("wechat_bot_accounts")
    op.drop_table("user_customers")
    op.drop_table("customers")
    op.drop_table("users")
