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
    # ── 空库兜底：本迁移假设 `customer_capabilities` 已存在，但**没有任何迁移创建它**
    # （旧版本靠 `Base.metadata.create_all()` 建表）。所以在**全新空库**上按顺序跑迁移时，
    # 下面第一句 `op.add_column('customer_capabilities', ...)` 必然报
    # `relation "customer_capabilities" does not exist` —— 整条迁移链跑不到 head。
    #
    # 这里按 **ORM 模型的当前定义**补建（去掉本迁移马上要加的 tenant_id，避免重复加列），
    # 类型因此永远与模型一致，不会手写出错。已存在的库不受影响（checkfirst 语义）。
    bind = op.get_bind()
    if not sa.inspect(bind).has_table("customer_capabilities"):
        from app.db.models import CustomerCapability  # 延迟导入：迁移运行期 app 包已可用
        model_cols = [c for c in CustomerCapability.__table__.columns
                      if c.name != "tenant_id"]
        sa.Table(
            "customer_capabilities", sa.MetaData(),
            *[sa.Column(c.name, c.type, primary_key=c.primary_key, nullable=c.nullable)
              for c in model_cols],
        ).create(bind)

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
    # 空库兜底（与上面 `customer_capabilities` 同一处、同一思路）：`quotations` 同样
    # **没有任何更早的迁移创建它** —— 真实库靠 `Base.metadata.create_all()` 建好，
    # 真·空白库走到这里必然报 `relation "quotations" does not exist`（整条链断在这）。
    # 表不存在 ⇒ **跳过这整段**，把它留给后面真正建表的迁移
    # `f82ac951b473_intel_workstation_v1.py:661`：那份 `create_table('quotations')`
    # 本身就带 `tenant_id NOT NULL` 与同名的两个索引
    # （`idx_quotations_tenant` / `ix_quotations_tenant_id`）⇒ 空库上跳过**不丢语义**，
    # 也避免在这里先造一张表、再和那次 CREATE TABLE 撞车（already exists）。
    # 已有库（表在）⇒ 条件为真，下面语句与改动前**完全一致**。
    #
    # 注：只兜 `upgrade`。空库上 `downgrade` 仍会在 `drop_column('quotations', …)` 处
    # 因表不存在而报错，但那条路径现在本来就走不到（链还没修通），属同一个历史问题，
    # 留作单独决策 —— 本次不扩大改动。
    if sa.inspect(bind).has_table("quotations"):
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
