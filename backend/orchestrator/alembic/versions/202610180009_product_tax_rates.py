"""产品税率档案（按产品维护进项税 / 出口退税率）

Revision ID: 202610180009
Revises: 202610180008
Create Date: 2026-10-18

用户口径（2026-10-18 修正）：
  · 销项增值税、杂税是**企业级**，仍在 `tax_archives`；
  · 进项增值税、出口退税率跟着**产品/HS**走，在税务管理页按产品逐条维护；
  · 同一团队同一产品只能有一条税率档案（已选过的产品不能重复选）；
  · 税费变化后可在一个页面统一管理，不用逐产品页改。

同时把历史 `tax_archives.tax_values` 里的 `input_vat_rate` / `rebate_rate`
清掉（新口径不再从企业税档取这两项；无生产数据）。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "202610180009"
down_revision: Union[str, None] = "202610180008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "product_tax_rates",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False, server_default="default"),
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column("input_vat_rate", sa.Numeric(8, 6), nullable=True),
        sa.Column("rebate_rate", sa.Numeric(8, 6), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "tenant_id", "team_id", "product_key",
            name="uq_product_tax_rates_team_product",
        ),
    )
    op.create_index(
        "idx_product_tax_rates_team",
        "product_tax_rates",
        ["tenant_id", "team_id", "status"],
    )
    op.execute(
        "UPDATE tax_archives SET tax_values = tax_values"
        " - 'input_vat_rate' - 'rebate_rate'"
    )


def downgrade() -> None:
    op.drop_index("idx_product_tax_rates_team", table_name="product_tax_rates")
    op.drop_table("product_tax_rates")
