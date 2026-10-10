"""租户开通报价工位权限矩阵（选择启用产品多对多）

Revision ID: 202610100007
Revises: 202610100006
Create Date: 2026-10-10

租户开通报价工位后，可选择「启用」某些产品（多对多关系）。
权限矩阵：
- is_system=true：系统级产品，所有租户可见，仅平台管理员可编辑
- is_system=false：租户级产品，仅本租户可见，租户管理员可编辑
详见 docs/PRODUCT_CONFIG_TENANT_UNFINISHED.md
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610100007"
down_revision: Union[str, None] = "202610100006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_workstation_products",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("workstation", sa.Text(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_tenant_ws_product",
        "tenant_workstation_products",
        ["tenant_id", "workstation", "product_key"],
        unique=True,
    )
    op.create_index(
        "idx_tenant_ws_product_tenant",
        "tenant_workstation_products",
        ["tenant_id", "workstation", "is_enabled"],
    )


def downgrade() -> None:
    op.drop_index("idx_tenant_ws_product_tenant", table_name="tenant_workstation_products")
    op.drop_index("uq_tenant_ws_product", table_name="tenant_workstation_products")
    op.drop_table("tenant_workstation_products")
