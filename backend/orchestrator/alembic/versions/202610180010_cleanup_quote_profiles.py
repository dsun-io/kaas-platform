"""发布后清理：删除旧客户税率档案表 + 清掉企业税档里的旧进项/退税字段。

Revision ID: 202610180010
Revises: 202610180009
Create Date: 2026-10-18

执行时机：**新 Worker 部署并冒烟通过之后**，不要和新代码同批上线。
旧 Worker 仍引用 `customer_quote_profiles`；先删会在切换窗口内让旧版本 500。
两种清理都写成幂等语句，本地已手工执行过也不会失败。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610180010"
down_revision: Union[str, None] = "202610180009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("DROP TABLE IF EXISTS customer_quote_profiles")
    op.execute(
        "UPDATE tax_archives SET tax_values = tax_values"
        " - 'input_vat_rate' - 'rebate_rate'"
    )


def downgrade() -> None:
    # 破坏性清理，不恢复旧表；需要回滚请用部署前数据库快照。
    pass
