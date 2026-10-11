"""修正文件域的版本化边界 + 补主图标记

Revision ID: 202610110017
Revises: 202610110016
Create Date: 2026-10-11

016 建表时把「同一归属+用途只允许一个当前版本」的**部分唯一索引**加在了
`(tenant_id, owner_type, owner_id, kind, media_kind)` 上，口径过宽：

- **盖章回传 / 系统出的 PDF** 确实只应有一个"当前件"（这是用户裁决的版本化语义）；
- **产品图**不是：一个产品可以有多张尺寸图 / 生产图（不同角度、不同批次），
  它们**应当并存**，不该互相顶掉。

所以本迁移把唯一索引收窄到 `kind IN ('stamp_scan','render_pdf')`，
并补上 `is_primary`（产品主图，同一归属+用途下最多一张）——两者都是部分唯一索引。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110017"
down_revision: Union[str, None] = "202610110016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ① 「当前版本唯一」只约束会版本化的用途，不再约束产品图
    op.drop_index("uq_file_current", table_name="file_objects")
    op.create_index(
        "uq_file_current",
        "file_objects",
        ["tenant_id", "owner_type", "owner_id", "kind", "media_kind"],
        unique=True,
        postgresql_where=sa.text("is_current AND kind IN ('stamp_scan', 'render_pdf')"),
    )

    # ② 产品主图：同一归属 + 用途下最多一张
    op.add_column(
        "file_objects",
        sa.Column("is_primary", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )
    op.create_index(
        "uq_file_primary",
        "file_objects",
        ["tenant_id", "owner_type", "owner_id", "kind"],
        unique=True,
        postgresql_where=sa.text("is_primary AND is_current"),
    )


def downgrade() -> None:
    op.drop_index("uq_file_primary", table_name="file_objects")
    op.drop_column("file_objects", "is_primary")
    op.drop_index("uq_file_current", table_name="file_objects")
    op.create_index(
        "uq_file_current",
        "file_objects",
        ["tenant_id", "owner_type", "owner_id", "kind", "media_kind"],
        unique=True,
        postgresql_where=sa.text("is_current"),
    )
