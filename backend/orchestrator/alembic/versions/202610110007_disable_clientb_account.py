"""停用 clientb 账号（其公司行已删除）

Revision ID: 202610110007
Revises: 202610110006
Create Date: 2026-10-11

业务确认：`客户B` 这条公司行已删除（迁移 202610110004 软删除），
其账号 `clientb@kaas.local` 也一并停用。

为什么是**停用**而不是物理删除：
- `user_subscriptions` / `team_invites` 等表有指向 `users.id` 的外键
  （CASCADE / SET NULL），物理删除会连带丢审计痕迹；
- 登录与鉴权都要求 `status='active'`（`/auth/login`、`_get_current_user`），
  停用后该账号立刻无法登录，效果等同删除，且可回滚。
同时解除它与已删除公司的 `user_customers` 绑定（公司都没了，绑定无意义）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110007"
down_revision: Union[str, None] = "202610110006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DISABLED_EMAIL = "clientb@kaas.local"


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE users SET status='disabled', team_id=NULL, updated_at=now()"
        " WHERE email = :email"
    ).bindparams(email=DISABLED_EMAIL))
    op.execute(sa.text(
        "DELETE FROM user_customers WHERE user_id IN"
        " (SELECT id FROM users WHERE email = :email)"
    ).bindparams(email=DISABLED_EMAIL))


def downgrade() -> None:
    op.execute(sa.text(
        "UPDATE users SET status='active', updated_at=now() WHERE email = :email"
    ).bindparams(email=DISABLED_EMAIL))
