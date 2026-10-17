"""P13 最后一跳：tenant_products 加 `override`（差异）+ `base_spec_hash` 列

Revision ID: 202610170002
Revises: 202610170001
Create Date: 2026-10-17

背景（SESSION_HANDOFF §四-B / PRODUCT_MODULE_MERGE_PLAN）：
团队级「基线 + 差异」改不动的原因就是缺这两列 —— `spec` 列存完整基线
快照，团队自定义此前只能整表复制（上游改了不会跟着变）。现在：

- `override`（JSONB，可空）：spec_delta 形态的差异（PATCH 语义），
  NULL/空 = 该团队未设差异，直接用基线（「未设差异的团队跟着变」）；
- `base_spec_hash`（TEXT，可空）：写入时基线的指纹留档（审计/快速比对）。

读路径走 `effective_spec.resolve_effective_product(base, delta)`：
差异带 `base_spec_hash` 且与当前基线不一致 ⇒ 抛 `SpecUpstreamChanged`
（上游已变更，**不静默套用**，人工复核后再合并）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610170002"
down_revision: Union[str, None] = "202610170001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tenant_products",
        sa.Column("override", postgresql.JSONB(), nullable=True),
    )
    op.add_column(
        "tenant_products",
        sa.Column("base_spec_hash", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tenant_products", "base_spec_hash")
    op.drop_column("tenant_products", "override")
