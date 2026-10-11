"""产品图排序：`file_objects` 增加 sort_order

Revision ID: 202610110018
Revises: 202610110017
Create Date: 2026-10-11

目标口径要求产品图支持**排序**，但 016/017 只有「设主图」——
`file_objects` 表没有顺序列，产品图列表只能按 `is_primary DESC, media_kind, id` 排，
用户改了顺序也无处可存。

为什么顺序属于 `file_objects` 而不是另建一张排序表
--------------------------------------------------
`trade_doc_files.sort_order` 是**单证自己**的顺序（同一张图在不同单证上可以排不同位次）；
而「产品图库」的顺序是**产品图本身**的属性：一份产品图被多张单证引用
（`trade_doc_files.file_id`），它的位次应当一次维护、处处一致。所以列加在文件元数据上。

本迁移**只新增一列**（`NOT NULL DEFAULT 0`，存量行自动补 0），可安全前滚；
`downgrade` 只删列，不触碰任何数据行。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110018"
down_revision: Union[str, None] = "202610110017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 展示顺序：正整数，0 是默认值（存量行与未排序的新上传都落在 0，
    # 靠 `id` 兜底成稳定顺序，用户一拖动/上移就整体重排成 0..n-1）。
    op.add_column(
        "file_objects",
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("file_objects", "sort_order")
