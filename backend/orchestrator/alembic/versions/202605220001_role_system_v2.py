"""role system v2 — 增加 user_roles 表

Revision ID: 202605220001
Revises: 202605170001
Create Date: 2026-05-22

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = '202605220001'
down_revision: Union[str, None] = '202605170001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 创建 user_roles 表
    op.create_table(
        'user_roles',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('user_id', sa.BigInteger, sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('role', sa.Text, nullable=False),
        sa.Column('permissions', postgresql.JSONB, nullable=True),
        sa.Column('granted_by', sa.BigInteger, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        'idx_user_roles_user_tenant',
        'user_roles',
        ['user_id', 'tenant_id'],
    )

    # 为现有 customer_owner 用户预填充 user_roles 行
    op.execute(
        """
        INSERT INTO user_roles (user_id, tenant_id, role, created_at)
        SELECT
            u.id,
            COALESCE(
                (SELECT tenant_id FROM customers c
                 JOIN user_customers uc ON uc.customer_id = c.id
                 WHERE uc.user_id = u.id LIMIT 1),
                'default'
            ),
            'customer_owner',
            NOW()
        FROM users u
        WHERE u.role IN ('owner', 'customer_owner')
        """
    )


def downgrade() -> None:
    op.drop_index('idx_user_roles_user_tenant', table_name='user_roles')
    op.drop_table('user_roles')
