"""阶段 3 · feature_flags + feature_flag_audit 表（线上管理接口存储）。

orchestrator 的 feature flag 写在 tenants.yaml（部署文件），Worker 运行时没有可写
文件系统，本迁移建立数据库等价物：
- feature_flags：租户开关配置（tenant_id + flag_name 唯一）
- feature_flag_audit：审计动作流水（等价 orchestrator 的 deployment_audit.jsonl）

Revision ID: 202609230005
Revises: 202609230004
Create Date: 2026-09-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "202609230005"
down_revision: str | Sequence[str] | None = "202609230004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "feature_flags",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("flag_name", sa.Text(), nullable=False),
        sa.Column("flag_value", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_by", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_feature_flags_tenant_flag",
        "feature_flags",
        ["tenant_id", "flag_name"],
        unique=True,
    )

    op.create_table(
        "feature_flag_audit",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("resource_type", sa.Text(), nullable=False),
        sa.Column("resource_id", sa.Text(), nullable=True),
        sa.Column("flag_name", sa.Text(), nullable=True),
        sa.Column("old_value", sa.Text(), nullable=True),
        sa.Column("new_value", sa.Text(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_feature_flag_audit_tenant",
        "feature_flag_audit",
        ["tenant_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_feature_flag_audit_tenant", table_name="feature_flag_audit")
    op.drop_table("feature_flag_audit")
    op.drop_index("idx_feature_flags_tenant_flag", table_name="feature_flags")
    op.drop_table("feature_flags")
