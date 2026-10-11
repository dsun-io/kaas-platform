"""团队级档位覆盖表 `team_option_overrides`（改显示名 / 软停用）

Revision ID: 202610110015
Revises: 202610110014
Create Date: 2026-10-11

依据：用户 2026-10-11 裁决「档位增删改查 = **团队级**；成本价继续按买家客户」。

背景
----
现有「客户自加档位」是从**定价数据**反推的（`load_option_extensions`），
按 `(tenant_id, customer_id)` 存 —— 只能**增**，不能改名、不能停用。
本次补上后两者。

为什么单开一张表，而不是复用 `tenant_products`
------------------------------------------------
`tenant_products` 存的是**完整 ProductSpec 快照**。把几个档位的改名写进去，
会让该租户的产品定义**冻成快照** —— 以后代码改了产品定义它不跟着变。
所以只存"覆盖"，与产品定义解耦。

两条硬约束（写进模型注释，这里再记一次）
----------------------------------------
· **只改显示名，不改 code**：code 是查价键的一半（`pricing_key_of` 拼的就是它），
  改了历史定价数据与报价单就对不上。
· **停用是软停用**：从下拉消失，但引擎仍能解析 —— 否则已引用该档位的
  历史报价单重算会取不到档位。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "202610110015"
down_revision: Union[str, None] = "202610110014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "team_option_overrides",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("team_id", sa.BigInteger(), nullable=False),
        sa.Column("product_key", sa.Text(), nullable=False),
        sa.Column(
            "overrides",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["team_id"], ["teams.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    # 一个团队在一个产品上只有一份覆盖
    op.create_index(
        "uq_team_option_overrides",
        "team_option_overrides",
        ["team_id", "product_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_team_option_overrides", table_name="team_option_overrides")
    op.drop_table("team_option_overrides")
