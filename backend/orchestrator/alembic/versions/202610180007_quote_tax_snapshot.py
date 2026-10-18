"""报价单税务档案快照（TAX-05）

Revision ID: 202610180007
Revises: 202610180006
Create Date: 2026-10-18

报价时选用的税务档案 + 当时实际税率。档案只负责前端填表；后端仍按请求显式
税率算价，快照用于历史复现与“税额来源”展示。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202610180007"
down_revision: Union[str, None] = "202610180006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("quote_orders", sa.Column("tax_archive_id", sa.BigInteger(), nullable=True))
    op.add_column("quote_orders", sa.Column("tax_archive_code", sa.Text(), nullable=True))
    op.add_column("quote_orders", sa.Column("tax_archive_name", sa.Text(), nullable=True))
    op.add_column("quote_orders", sa.Column("tax_snapshot", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("quote_orders", "tax_snapshot")
    op.drop_column("quote_orders", "tax_archive_name")
    op.drop_column("quote_orders", "tax_archive_code")
    op.drop_column("quote_orders", "tax_archive_id")
