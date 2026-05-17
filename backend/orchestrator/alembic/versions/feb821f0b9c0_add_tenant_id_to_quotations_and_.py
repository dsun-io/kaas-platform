"""add tenant_id to quotations and customer_capabilities

Revision ID: feb821f0b9c0
Revises: 82e2cd95a9dd
Create Date: 2026-05-05 17:45:03.500289

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'feb821f0b9c0'
down_revision: Union[str, None] = '82e2cd95a9dd'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Add tenant_id to customer_capabilities (nullable first for backfill) ──
    op.add_column('customer_capabilities',
        sa.Column('tenant_id', sa.Text(), nullable=True))
    op.execute("""
        UPDATE customer_capabilities cc
        SET tenant_id = c.tenant_id
        FROM customers c
        WHERE cc.customer_id = c.code AND cc.tenant_id IS NULL
    """)
    op.execute("""
        UPDATE customer_capabilities
        SET tenant_id = customer_id
        WHERE tenant_id IS NULL
    """)
    op.alter_column('customer_capabilities', 'tenant_id', nullable=False)
    op.create_index('idx_capabilities_tenant', 'customer_capabilities',
                    ['tenant_id', 'customer_id'], unique=False)
    op.create_index(op.f('ix_customer_capabilities_tenant_id'),
                    'customer_capabilities', ['tenant_id'], unique=False)

    # ── Add tenant_id to quotations (nullable first for backfill) ──
    op.add_column('quotations',
        sa.Column('tenant_id', sa.Text(), nullable=True))
    op.execute("""
        UPDATE quotations q
        SET tenant_id = c.tenant_id
        FROM customers c
        WHERE q.customer_id = c.code AND q.tenant_id IS NULL
    """)
    op.execute("""
        UPDATE quotations
        SET tenant_id = customer_id
        WHERE tenant_id IS NULL
    """)
    op.alter_column('quotations', 'tenant_id', nullable=False)
    op.create_index('idx_quotations_tenant', 'quotations',
                    ['tenant_id', 'customer_id'], unique=False)
    op.create_index(op.f('ix_quotations_tenant_id'),
                    'quotations', ['tenant_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_quotations_tenant_id'), table_name='quotations')
    op.drop_index('idx_quotations_tenant', table_name='quotations')
    op.drop_column('quotations', 'tenant_id')
    op.drop_index(op.f('ix_customer_capabilities_tenant_id'),
                  table_name='customer_capabilities')
    op.drop_index('idx_capabilities_tenant', table_name='customer_capabilities')
    op.drop_column('customer_capabilities', 'tenant_id')
