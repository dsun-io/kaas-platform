"""add_role_plan_to_users

Revision ID: 82e2cd95a9dd
Revises: 202605050001
Create Date: 2026-05-05 14:34:50.099532

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '82e2cd95a9dd'
down_revision: Union[str, None] = '202605050001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── users.role ──────────────────────────────────────────────────
    # Step 1: add nullable column
    op.add_column('users', sa.Column('role', sa.Text(), nullable=True))
    # Step 2: backfill existing data
    op.execute("UPDATE users SET role = 'system_admin' WHERE account_type = 'internal'")
    op.execute("UPDATE users SET role = 'owner' WHERE account_type = 'customer'")
    op.execute("UPDATE users SET role = 'user' WHERE role IS NULL")
    # Step 3: make NOT NULL
    op.alter_column('users', 'role', nullable=False)

    # ── users.plan ──────────────────────────────────────────────────
    op.add_column('users', sa.Column('plan', sa.Text(), nullable=True))
    op.execute("UPDATE users SET plan = 'internal' WHERE account_type = 'internal'")
    op.execute("UPDATE users SET plan = 'free' WHERE account_type = 'customer'")
    op.execute("UPDATE users SET plan = 'free' WHERE plan IS NULL")
    op.alter_column('users', 'plan', nullable=False)

    # ── customers.plan ──────────────────────────────────────────────
    op.add_column('customers', sa.Column('plan', sa.Text(), nullable=True))
    op.execute("UPDATE customers SET plan = 'free' WHERE plan IS NULL")
    op.alter_column('customers', 'plan', nullable=False)


def downgrade() -> None:
    op.drop_column('users', 'plan')
    op.drop_column('users', 'role')
    op.drop_column('customers', 'plan')
