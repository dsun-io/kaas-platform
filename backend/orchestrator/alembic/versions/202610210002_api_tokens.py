"""W5 M1：对外 API token 基座 `api_tokens`

Revision ID: 202610210002
Revises: 202610210001
Create Date: 2026-10-21 13:10:00.000000

背景（设计 = docs/W5_MCP_REST_DESIGN_2026-10-21.md §2）
--------------------------------------------------
对外 REST / MCP 调用需要可吊销、可限权的长期凭据，不能复用 UI 会话 JWT。
本表**只存 sha256 哈希与前缀明文**：token 明文只在创建响应里出现一次，
不落库、不入日志；门面按哈希查表校验。

字段口径
--------
- `tenant_id` 恒为 'default'（生产单租户）；真正隔离边界是 `team_id`（可空）。
- `scopes` 是鉴权元数据白名单（如 customers:read），不是业务规则；具体校验在门面。
- `expires_at` 为空 = 不过期；`revoked_at` 非空 = 已吊销（软删，保留行便于追溯）。
- `last_used_at` 由门面在每次成功校验后更新（失败不改，避免侧信道放大）。

索引
----
- unique(token_hash)：校验主路径，同时保证同一明文不会被登记两次。
- (tenant_id, team_id)：管理面按租户/团队列举。

回滚 = drop 表（索引随表回收）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610210002"
down_revision: Union[str, None] = "202610210001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "api_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id", sa.Text(), nullable=False, server_default="default",
        ),
        # 可空：NULL = 租户级/个人级；非空 = 该团队的隔离边界
        sa.Column("team_id", sa.BigInteger(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        # 鉴权元数据（text[]），白名单校验在门面 tokens.ts；库层只保证是 text 数组
        sa.Column(
            "scopes", postgresql.ARRAY(sa.Text()), nullable=False,
            server_default=sa.text("'{}'::text[]"),
        ),
        # 只存 sha256 hex；明文永不落库
        sa.Column("token_hash", sa.Text(), nullable=False),
        # 前缀明文（kaas_oat_ + 若干位）用于 UI 识别，非机密
        sa.Column("prefix", sa.Text(), nullable=False),
        sa.Column("created_by", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "uq_api_tokens_token_hash", "api_tokens", ["token_hash"], unique=True,
    )
    op.create_index(
        "idx_api_tokens_tenant_team", "api_tokens", ["tenant_id", "team_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_api_tokens_tenant_team", table_name="api_tokens")
    op.drop_index("uq_api_tokens_token_hash", table_name="api_tokens")
    op.drop_table("api_tokens")
