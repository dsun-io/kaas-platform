"""询盘三态：未报价 / 已报价 / 已关闭

Revision ID: 202610180005
Revises: 202610180004
Create Date: 2026-10-18

用户口径（2026-10-18）：
  · 询盘只有三个状态：unquoted（未报价）/ quoted（已报价）/ closed（已关闭）；
  · 「已报价」由报价事件自动推进；「已关闭」仅手动切换。
存量状态映射：open→unquoted，quoted→quoted，won/lost→closed。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610180005"
down_revision: Union[str, None] = "202610180004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE cust_inquiries SET status = CASE"
        " WHEN status IN ('won', 'lost', 'closed') THEN 'closed'"
        " WHEN status = 'quoted' THEN 'quoted'"
        " ELSE 'unquoted' END"
    )


def downgrade() -> None:
    op.execute(
        "UPDATE cust_inquiries SET status = CASE"
        " WHEN status = 'closed' THEN 'lost'"
        " WHEN status = 'quoted' THEN 'quoted'"
        " ELSE 'open' END"
    )
