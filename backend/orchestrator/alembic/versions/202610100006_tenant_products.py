"""租户级产品定义配置化

Revision ID: 202610100006
Revises: 202610100005
Create Date: 2026-10-10

产品定义配置化（租户级）：租户开通报价工位后可选择添加/启用产品。
权限矩阵留口子（is_system 系统级产品所有租户可见，is_active 租户级控制启用）。
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610100006"
down_revision: Union[str, None] = "202610100005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_products",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column("product_name", sa.Text(), nullable=False),
        sa.Column("product_name_en", sa.Text(), nullable=True),
        sa.Column("category_code", sa.Text(), nullable=True),
        sa.Column("cost_field", sa.Text(), nullable=True, server_default="raw_price"),
        sa.Column("cost_basis", sa.Text(), nullable=True, server_default="pretax"),
        sa.Column("cost_unit", sa.Text(), nullable=True),
        # 产品级利润配置（优先级：产品级 > 报价单级 > 税务档案）
        sa.Column("profit_mode", sa.Text(), nullable=True, server_default="margin_on_price"),
        sa.Column("profit_value", sa.Numeric(10, 6), nullable=True, server_default="0.06"),
        sa.Column("misc_fee_rate", sa.Numeric(10, 6), nullable=True, server_default="0.03"),
        # 完整 ProductSpec（JSONB，含 axes/variants/derived/columns/invariants）
        sa.Column("spec", postgresql.JSONB(), nullable=False),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_tenant_products_key",
        "tenant_products",
        ["tenant_id", "product_key"],
        unique=True,
    )
    op.create_index("idx_tenant_products_tenant", "tenant_products", ["tenant_id", "is_active"])


def downgrade() -> None:
    op.drop_index("idx_tenant_products_tenant", table_name="tenant_products")
    op.drop_index("uq_tenant_products_key", table_name="tenant_products")
    op.drop_table("tenant_products")
