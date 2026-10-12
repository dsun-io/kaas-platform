"""忘记密码：`password_reset_tokens` 表（token 只存哈希，30 分钟过期，用后即废）

Revision ID: 202610120001
Revises: 202610110019
Create Date: 2026-10-12

设计口径（安全实践）：
- `token_hash`：SHA-256（hex）**唯一**索引 —— 库里永远看不到明文 token；
  查找时把请求里的明文 token 哈希后比对（与 `team_invites.token` 明文存的风格不同，
  邀请码是人读的人工码，重置链接是机器生成的高熵凭证，必须哈希）。
- `expires_at`：创建后 30 分钟；`used_at`：改密成功即置时间戳（用后即废）。
- 改密成功时同用户**其它未用 token 一并失效**（防旧链接重放）——在 API 层做，不在迁移里。
- `requested_ip`：审计用，可空。

`down_revision = "202610110019"`（当前 head，见 PROBLEM_STATUS 2026-10-12 迁移线通告）。
"""
from alembic import op
import sqlalchemy as sa

revision = "202610120001"
down_revision = "202610110019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", sa.BigInteger(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("requested_ip", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("uq_password_reset_token_hash", "password_reset_tokens", ["token_hash"], unique=True)
    op.create_index("idx_password_reset_user", "password_reset_tokens", ["user_id", "used_at"])


def downgrade() -> None:
    op.drop_index("idx_password_reset_user", table_name="password_reset_tokens")
    op.drop_index("uq_password_reset_token_hash", table_name="password_reset_tokens")
    op.drop_table("password_reset_tokens")
