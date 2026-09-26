"""客户报价税率档案（customer_quote_profiles）

Revision ID: 202609270001
Revises: 202609260002

背景
----
报价页要能「把这次填的税率存成一份命名档案，下次一键套用」（默认选最新的一份）。
税率是**每个客户 + 每个产品**一份：不同产品的供货厂不同，进项票税点可能不同
（牛栏网 10%、立柱 13%），所以粒度到产品。

为什么另建表而不复用 customer_pricing_profiles
--------------------------------------------
旧表是 INT-R3 时代的模型（三档加价倍率 + 单一税点），且**仍有一条活的读取路径**：
services/quote_engine → services/niulanwang_pricing → repositories.pricing_profiles_repo
→ get_current_profile（按 effective_from DESC 取最新一条）。
若把新模型的行插进旧表，那条老路径会把这些行当成「加价倍率」解读 ——
读到 null / 垃圾值继续算，不报错。两张表分开，各自服务各自的模型，互不干扰。

本迁移只新增，不改动、不删除任何现有表与数据。

用法：cd backend/orchestrator && .venv\\Scripts\\python.exe -m alembic upgrade head
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202609270001"
down_revision: Union[str, None] = "202609260002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_quote_profiles (
            id             BIGSERIAL PRIMARY KEY,
            tenant_id      TEXT        NOT NULL,
            customer_id    TEXT        NOT NULL,
            -- 引擎的产品 key（如 field_fence），全链路一个标识
            product_key    TEXT        NOT NULL,
            profile_name   TEXT        NOT NULL,
            -- 当时绑定的法定税务档案；选中本档案时要一并切过去，否则组合不可复现
            rate_set_code  TEXT        NOT NULL,
            -- 税率覆盖项（进项票税点 / 销项税率 / 出口退税率 / 印花税率 + 基数）
            tax_overrides  JSONB       NOT NULL DEFAULT '{}'::jsonb,
            status         TEXT        NOT NULL DEFAULT 'active',
            source         TEXT        NOT NULL DEFAULT 'manual',
            created_by     TEXT,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    # 列表查询固定按 (租户, 客户, 产品, 状态) 过滤，并按创建时间倒序取「最新一份」
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_quote_profile_lookup
            ON customer_quote_profiles (tenant_id, customer_id, product_key, status, created_at DESC)
        """
    )
    # 管理员「看所有客户」的路径按 (租户, 产品, 状态) 扫，单独一条索引避免全表扫
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_quote_profile_tenant_product
            ON customer_quote_profiles (tenant_id, product_key, status)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_quote_profile_tenant_product")
    op.execute("DROP INDEX IF EXISTS idx_quote_profile_lookup")
    op.execute("DROP TABLE IF EXISTS customer_quote_profiles")
