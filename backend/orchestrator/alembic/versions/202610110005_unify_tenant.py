"""统一租户：业务逻辑不以租户做鉴权边界

Revision ID: 202610110005
Revises: 202610110004
Create Date: 2026-10-11

背景（业务确认）
----------------
**授权模型**：租户**不**作为业务鉴权边界。真正的边界是
「这个账号/团队开通了哪些**工位**」（订阅 + 付费）；
数据隔离靠**团队**（`docs/TEAMS_AND_VISIBILITY.md`）。

历史遗留问题
------------
数据里存在 3 个租户标签，且只有"公司账号行"贴着非默认值：

| 表 | 租户分布（迁移前） |
|---|---|
| `customers` | `lianjia` 1 行、`client_b` 1 行、`default` 1 行 |
| 报价 / 单证 / 联系人 / 企业抬头 / 线索 | **全部 `default`** |

而生产 Worker 是单租户实现（查询硬编码 `'default'`）、开发端按登录用户的租户查 ——
两边**都错，且错法相反**：

- 生产：联佳登录看不到自己的账号行（它是 `lianjia`），却看得到别家的 `default` 数据；
- 开发：联佳登录只看到自己那行账号，**看不到任何报价/单证**（业务数据都在 `default`）。

本迁移
------
把所有 `customers.tenant_id` 统一为 `default`。之后：
- 两端查询口径一致（都是 `default`），显示恢复正常；
- 隔离完全由**团队**承担（联佳丝网已归入联佳团队）；
- 开发端 `auth.tenant_id` 也随之变为 `default`（它取自绑定客户的租户）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110005"
down_revision: Union[str, None] = "202610110004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_TENANT = "default"


def upgrade() -> None:
    op.execute(sa.text(
        "UPDATE customers SET tenant_id = :default WHERE tenant_id <> :default"
    ).bindparams(default=DEFAULT_TENANT))


def downgrade() -> None:
    # 租户标签无法从"统一后的值"反推回原样（历史值已丢失），
    # 故 downgrade 只做无操作声明：需要回退请从备份恢复。
    pass
