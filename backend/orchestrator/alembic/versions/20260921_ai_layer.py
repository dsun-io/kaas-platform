"""ai_layer

Revision ID: 20260921_ai_layer
Revises: 20260921_business_foundation
Create Date: 2026-09-21

P1 AI 层（docs 最终设计 §四）：
- ai_providers：客户自配 Provider（DS / Kimi / Zhipu），API Key + 模型 + 启用开关
- ai_task_bindings：任务绑定（配置校验/线索评分/开场白/邮件生成/询盘分类），
  每任务选 Provider/模型/是否启用；"不用 AI"= enabled=false，走纯模板降级路径
- ai_usage：每次 AI 调用对账记录（铁律：每次调用产生 usage 记录，失败默认退款）

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

# revision identifiers, used by Alembic.
revision: str = '20260921_ai_layer'
down_revision: Union[str, None] = '20260921_business_foundation'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Provider 配置（每租户每 Provider 一行）─────────────────────────────
    op.create_table(
        'ai_providers',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('provider', sa.Text(), nullable=False),   # deepseek | kimi | zhipu
        sa.Column('api_key', sa.Text(), nullable=True),
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('base_url', sa.Text(), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'provider', name='uq_ai_providers_tenant_provider'),
    )

    # ── 任务绑定（每租户每任务一行；"不用 AI" 是合法选项 = enabled false）─────
    op.create_table(
        'ai_task_bindings',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('task_key', sa.Text(), nullable=False),
        # config_validation | lead_scoring | opening_line | email_generation | inquiry_classification
        sa.Column('provider', sa.Text(), nullable=True),    # 覆盖 Provider 配置中的模型选择
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('enabled', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('config', JSONB(), nullable=True),        # 任务级参数（prompt 覆盖等）
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now(), onupdate=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'task_key', name='uq_ai_task_bindings_tenant_task'),
    )

    # ── AI 调用对账记录（铁律：每次调用必落一条，失败可退款核对）────────────
    op.create_table(
        'ai_usage',
        sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column('tenant_id', sa.Text(), nullable=False),
        sa.Column('task_key', sa.Text(), nullable=False),
        sa.Column('provider', sa.Text(), nullable=True),    # 实际命中的 Provider（模板降级为 null）
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('prompt_tokens', sa.Integer(), nullable=True),
        sa.Column('completion_tokens', sa.Integer(), nullable=True),
        sa.Column('cost_usd', sa.Numeric(12, 6), nullable=True),
        sa.Column('status', sa.Text(), nullable=False, server_default='success'),
        # success | failed | template_only（未启用 AI / 链全挂走模板）
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('latency_ms', sa.Integer(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('idx_ai_usage_tenant_time', 'ai_usage', ['tenant_id', 'created_at'])
    op.create_index('idx_ai_usage_tenant_task', 'ai_usage', ['tenant_id', 'task_key'])

    # 推荐默认值种子：DS 配置校验、Kimi 开场白/邮件/询盘分类（推荐≠强制，客户可改可关）
    op.execute("""
        INSERT INTO ai_task_bindings (tenant_id, task_key, provider, enabled)
        SELECT 'default', k, v, false FROM (VALUES
            ('config_validation', 'deepseek'),
            ('lead_scoring', 'deepseek'),
            ('opening_line', 'kimi'),
            ('email_generation', 'kimi'),
            ('inquiry_classification', 'kimi')
        ) AS t(k, v)
    """)


def downgrade() -> None:
    op.drop_index('idx_ai_usage_tenant_task', table_name='ai_usage')
    op.drop_index('idx_ai_usage_tenant_time', table_name='ai_usage')
    op.drop_table('ai_usage')
    op.drop_table('ai_task_bindings')
    op.drop_table('ai_providers')
