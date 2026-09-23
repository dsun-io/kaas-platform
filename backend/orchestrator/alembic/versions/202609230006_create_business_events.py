"""阶段 6 · business_events 表（跨工位业务事件流水）。

工位能力网方向下，工位之间的联动不再走线性流水线，而是发业务事件：
quotation.converted、order.shipped、shipment.documented 等 11 类事件
（完整清单见 shared/contracts/events.ts 与 events.registry.md）。

- business_events：业务事件流水（tenant_id + 时间索引，事件类型可查）
- 跨工位操作只记录事件，不强制下游顺序执行

Revision ID: 202609230006
Revises: 202609230005
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202609230006"
down_revision: str | Sequence[str] | None = "202609230005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "business_events",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("event_type", sa.Text(), nullable=False),
        sa.Column("from_workstation", sa.Text(), nullable=True),
        sa.Column("to_workstation", sa.Text(), nullable=True),
        sa.Column("payload", JSONB(), nullable=True),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_business_events_tenant_time",
        "business_events",
        ["tenant_id", "created_at"],
        unique=False,
    )
    op.create_index(
        "idx_business_events_tenant_type",
        "business_events",
        ["tenant_id", "event_type"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_business_events_tenant_type", table_name="business_events")
    op.drop_index("idx_business_events_tenant_time", table_name="business_events")
    op.drop_table("business_events")
