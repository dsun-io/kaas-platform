"""删除旧客户税率档案表（customer_quote_profiles）

Revision ID: 202610180008
Revises: 202610180007
Create Date: 2026-10-18

用户 2026-10-18 确认：旧客户税率档案没有投入真实业务使用，API/模型已删除；
表数据保留无意义，直接删除。税率档案统一走 `tax_archives`。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610180008"
down_revision: Union[str, None] = "202610180007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS customer_quote_profiles")


def downgrade() -> None:
    # 该表是 2026-10 前的历史实现，删除为一次性清理；不做结构恢复。
    pass
