"""客户软删除 + 联系人增删改

Revision ID: 202610100004
Revises: 202610100003
Create Date: 2026-10-10

客户软删除（保留历史单据引用，不物理删除）；联系人支持改/删。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610100004"
down_revision: Union[str, None] = "202610100003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("is_deleted", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("customers", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("idx_customers_tenant_deleted", "customers", ["tenant_id", "is_deleted"])


def downgrade() -> None:
    op.drop_index("idx_customers_tenant_deleted", table_name="customers")
    op.drop_column("customers", "deleted_at")
    op.drop_column("customers", "is_deleted")
