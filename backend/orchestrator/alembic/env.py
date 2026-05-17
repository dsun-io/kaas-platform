"""
Kaas v2 · Alembic 环境配置
──────────────────────────
从 DATABASE_URL 环境变量读取连接字符串，
自动将 asyncpg scheme 转为同步 psycopg2。
"""

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool
from alembic import context

# 将 backend/ 目录加入 sys.path，以便导入 app 模块
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db.base import Base
from app.db.models import (  # noqa: F401
    Event,
    Quotation,
    CustomerCapability,
    TextKnowledge,
    User,
    Customer,
    UserCustomer,
    WechatBotAccount,
    WechatConversation,
    ChannelLink,
    Conversation,
    ConversationMessage,
    UsageEvent,
    WechatMessageEvent,
    ProductCategory,
    UnitGroup,
    Unit,
    PriceUnit,
    SpecAttribute,
    SpecAttributeValue,
    CategoryAttributeBinding,
    IndustryTemplate,
    ProductSku,
    ProductSkuPrice,
    ProductSkuRevision,
    AttributeProposal,
)

# Alembic Config 对象
config = context.config

# 设置日志
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# SQLAlchemy MetaData（用于 autogenerate）
target_metadata = Base.metadata


def get_sync_url() -> str:
    """
    将 DATABASE_URL 中的 asyncpg scheme 转为同步 psycopg2。
    Alembic 自身不支持 asyncpg。
    """
    url = os.environ.get(
        "DATABASE_URL",
        config.get_main_option("sqlalchemy.url", ""),
    )
    # postgresql+asyncpg:// → postgresql://
    return url.replace("+asyncpg", "")


def run_migrations_offline() -> None:
    """Run migrations in 'offline' mode (生成 SQL 脚本)."""
    url = get_sync_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations in 'online' mode (直接执行)."""
    configuration = config.get_section(config.config_ini_section)
    configuration["sqlalchemy.url"] = get_sync_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
