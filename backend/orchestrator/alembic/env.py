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
from app.db.tax_models import TaxArchive  # noqa: F401
from app.db.models import (  # noqa: F401
    Event,
    Quotation,
    CustomerCapability,
    TextKnowledge,
    User,
    Customer,
    UserCustomer,
    ChannelLink,
    UsageEvent,
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
    IntelEntity,
    IntelProductCategory,
    IntelShipment,
    IntelSource,
    IntelTradeStat,
    IntelDataChannel,
    IntelAdapterRun,
    IntelKeywordRule,
    IntelMatch,
)

# 2026-10-19 修复：空库快径依赖 Base.metadata，但此前只 import 了 models + tax_models
# ⇒ create_all 漏建 workstation_models / market_models / actual_cost / external_docs /
# workstation_links 里的表（实测空库只建出 61 张，生产是 109 张；漏 cust_contacts 会让
# worker 创建客户在全新库必 500）。这里显式 import 所有模型模块，确保 metadata 完整。
from app.db import (  # noqa: F401,E402
    workstation_models,
    market_models,
    actual_cost,
    external_docs,
    workstation_links,
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
    将 DATABASE_URL 转为同步 psycopg2 可用形式。Alembic 自身不支持 asyncpg。

    除了把 `+asyncpg` 去掉，还必须把 SSL 参数改成 libpq 写法：
      · 应用（asyncpg）用 `?ssl=require`
      · 迁移（psycopg2）用 `?sslmode=require`
      · asyncpg 不认 sslmode，psycopg2 不认 ssl
    但两者读的是**同一个** DATABASE_URL，且环境变量优先级高于 .env ，
    所以不能靠“手工传两套值”绕过去 —— 在这里自动转换。

    背景：本项目开发库是 Neon（必须 SSL），直接传原始 DSN 会报
    `connect() got an unexpected keyword argument 'sslmode'`（应用侧）
    或连不上。
    """
    # 局部导入：保持 env.py 顶部导入不动，也避免与 app 包导入顺序纠缠
    from sqlalchemy.engine import make_url

    raw = os.environ.get(
        "DATABASE_URL",
        config.get_main_option("sqlalchemy.url", ""),
    )
    # postgresql+asyncpg:// → postgresql://
    url = make_url(raw.replace("+asyncpg", ""))

    params = dict(url.query)
    if "ssl" in params and "sslmode" not in params:
        ssl_value = str(params.pop("ssl")).lower()
        # 归一化到 libpq 认可的档位
        params["sslmode"] = {
            "require": "require",
            "true": "require",
            "false": "disable",
        }.get(ssl_value, ssl_value)
    return url.set(query=params).render_as_string(hide_password=False)


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


def _bootstrap_if_empty(connection) -> bool:
    """空库快径（E1 · UNCERTAIN #20）—— 判定与建表逻辑在 app/db/migration_bootstrap.py
    （纯函数、可单测；env.py 是脚本、import 即执行迁移，没法直接测）。

    ⚠️ 事务收尾（2026-10-17 真库验证抓到的 bug）：inspect/DDL 都在连接事务里跑，
    若不显式 commit/rollback，alembic 的 `begin_transaction()` 会把它当**嵌套事务**、
    退出时不提交 ⇒ 迁移**静默回滚**（日志显示 Running upgrade、exit 0，但库里什么都没变）。
    """
    from alembic.script import ScriptDirectory

    from app.db.migration_bootstrap import bootstrap_if_empty

    script = ScriptDirectory.from_config(config)
    head = script.get_current_head()
    result = bootstrap_if_empty(connection, target_metadata, head)
    if result:
        connection.commit()   # create_all + stamp 落库
    else:
        connection.rollback()  # 只读探测（get_table_names），清掉它开的事务
    return result


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
        # 空库快径（E1）：跳过历史链，直接 create_all + stamp head
        if _bootstrap_if_empty(connection):
            return

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
