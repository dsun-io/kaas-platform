"""（安全占位）旧客户税率档案表删除延后到发布后迁移。

Revision ID: 202610180008
Revises: 202610180007
Create Date: 2026-10-18

原计划在本迁移直接 DROP `customer_quote_profiles`。生产部署时旧 Worker 仍可能
引用该表，先删会让旧版本在切换窗口内 500。因此本迁移改为**空操作**：

  · 发布前只跑新增表/列（006/007/009），旧 Worker 继续可用；
  · 新 Worker 稳定后，再跑 010 做清理（DROP 表 + 清掉企业税档里的进项/退税旧键）。

本地开发库已按旧逻辑执行过本迁移；010 使用 IF EXISTS / 幂等更新，不受影响。
"""
from typing import Sequence, Union

revision: str = "202610180008"
down_revision: Union[str, None] = "202610180007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 删除动作延后到 202610180010（发布后清理）
    pass


def downgrade() -> None:
    pass
