"""A5-W1：团队级条款模板库 `tenant_clause_templates`

Revision ID: 202610200006
Revises: 202610200005
Create Date: 2026-10-21

背景（用户 2026-10-21 拍板：**团队级条款库 + 预置 6 类**；方案见
`docs/TRADE_DOC_EDIT_PLAN.md` 的 W1）：

单证里付款/装运/检验/索赔/不可抗力/仲裁这类条款长期是自由文本，同一条款十种写法，
A7 一致性只能标"冲突"、无法引导统一。本表把"常用条款"变成团队级候选值：
设置页可维护（名称 + 中英双语 + 适用单证类型 + 排序 + 启停），填单时下拉选用。

数据边界
--------
- **团队级**（`team_id NOT NULL`）：条款是公司内部口径，不跨团队共享；这是与
  `tenant_company_profile`（租户级）的区别。生产 Worker 单租户部署，团队才是隔离边界。
- 唯一 `(tenant_id, team_id, name)`：同团队内名称唯一（下拉可辨认；软删行仍占名字，
  避免"删了又建同名"出现两条历史）。
- 索引 `(tenant_id, team_id, is_active)`：列表默认只查启用项。
- 软删（`is_active=false`），不物理删除：历史单据引用过的措辞仍可追溯。
- **默认 6 条不在迁移里种**：由 Worker 首次读取时**懒种子**（幂等）——
  迁移只建结构，不猜业务措辞；且不同团队拿到各自的副本，可独立编辑。

回滚 = drop 表（含索引随表回收）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610200006"
down_revision: Union[str, None] = "202610200005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tenant_clause_templates",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id", sa.Text(), nullable=False, server_default="default",
        ),
        # 团队是隔离边界；条款库不跨团队共享
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        # 适用单证类型（DOC_TYPE 18 类子集；校验在共享内核，库层只保证是 text 数组）
        sa.Column(
            "doc_types", postgresql.ARRAY(sa.Text()), nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("text_zh", sa.Text(), nullable=True),
        sa.Column("text_en", sa.Text(), nullable=True),
        sa.Column(
            "sort_order", sa.Integer(), nullable=False, server_default="0",
        ),
        sa.Column(
            "is_active", sa.Boolean(), nullable=False, server_default="true",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "uq_tenant_clause_templates_name",
        "tenant_clause_templates",
        ["tenant_id", "team_id", "name"],
        unique=True,
    )
    op.create_index(
        "idx_tenant_clause_templates_active",
        "tenant_clause_templates",
        ["tenant_id", "team_id", "is_active"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_tenant_clause_templates_active", table_name="tenant_clause_templates",
    )
    op.drop_index(
        "uq_tenant_clause_templates_name", table_name="tenant_clause_templates",
    )
    op.drop_table("tenant_clause_templates")
