"""实际采购成本档案迁移

Revision ID: 202610100002
Revises: 202610100001
Create Date: 2026-10-10

只用于利润核算，不进报价计算链（报价用 pricing_key 定价表/内联成本）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610100002"
down_revision: Union[str, None] = "202610100001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "actual_procurement_costs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column("supplier_name", sa.Text(), nullable=True),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("unit_cost_actual", sa.Numeric(20, 6), nullable=True),
        sa.Column("total_cost_actual", sa.Numeric(20, 6), nullable=True),
        sa.Column("qty_snapshot", sa.Numeric(20, 6), nullable=True),
        sa.Column("qty_unit", sa.Text(), nullable=True),
        sa.Column("cost_basis", sa.Text(), nullable=False, server_default="pretax"),
        sa.Column("input_vat_rate_snapshot", sa.Numeric(10, 6), nullable=True),
        sa.Column("currency", sa.Text(), nullable=False, server_default="CNY"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_apc_tenant_product", "actual_procurement_costs", ["tenant_id", "product_key"])
    op.create_index("idx_apc_tenant_supplier", "actual_procurement_costs", ["tenant_id", "supplier_name"])


def downgrade() -> None:
    op.drop_index("idx_apc_tenant_supplier", table_name="actual_procurement_costs")
    op.drop_index("idx_apc_tenant_product", table_name="actual_procurement_costs")
    op.drop_table("actual_procurement_costs")
