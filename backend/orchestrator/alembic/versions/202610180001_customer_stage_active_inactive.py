"""客户阶段模型收敛：六值 → 活跃/沉寂（已下单改为推导）

Revision ID: 202610180001
Revises: 202610170004
Create Date: 2026-10-18

**口径（用户 2026-10-18 明确）**
客户阶段与订单阶段是两层，不能混：
  · 客户阶段只有 `active`（活跃）/ `inactive`（沉寂，客户关系关闭）；
  · `ordered`（已下单）是**读时推导**：名下存在开启中的订单
    （pending/confirmed/producing/shipped）时显示已下单，**不落库**；
  · `lead/inquiry/quoted/won/lost` 属于**询盘/报价/订单（单据）阶段**，
    不再作为客户阶段。

**本迁移只做数据归一（不改列定义）**
`customers.stage` 历史上存的是六值开放字符串。本迁移把存量映射成两个手动值：
  · `inactive` / `lost` → `inactive`（流失并入沉寂：用户「沉寂=关闭」）
  · `lead` / `inquiry` / `quoted` / `won` / 其它/空 → `active`

**顺序无关性**：新代码的读路径（`customer_rules.normalize_manual_stage`）本身也能
容忍旧值，所以「代码先上线、迁移后跑」不会渲染出六种旧阶段；本迁移只是把数据
收敛干净，便于后续按 `stage` 直接筛选。

注意：历史 `cust_stage_log` **不**改写 —— 它是审计流水，保留当时真实发生的阶段。
"""
from typing import Sequence, Union

from alembic import op

revision: str = "202610180001"
down_revision: Union[str, None] = "202610170004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    # 先归一成 inactive（或含 lost），其余一律 active（含未知值/空值）
    bind.exec_driver_sql(
        "UPDATE customers SET stage = 'inactive'"
        " WHERE stage IN ('inactive', 'lost')"
    )
    bind.exec_driver_sql(
        "UPDATE customers SET stage = 'active'"
        " WHERE stage IS NULL OR stage NOT IN ('active', 'inactive')"
    )
    # 列默认值随 ORM 一起改成 active（存量 DB 的 server_default 还是 'lead'）
    bind.exec_driver_sql(
        "ALTER TABLE customers ALTER COLUMN stage SET DEFAULT 'active'"
    )


def downgrade() -> None:
    # 数据映射不可逆（无法区分原来的 lead/inquiry/quoted/won）。
    # 只把默认值恢复，避免 downgrade 之后新建客户直接落到非法值。
    bind = op.get_bind()
    bind.exec_driver_sql(
        "ALTER TABLE customers ALTER COLUMN stage SET DEFAULT 'lead'"
    )
