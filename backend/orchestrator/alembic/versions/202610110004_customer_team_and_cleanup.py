"""客户域收尾：联佳账号行归入联佳团队 + 清掉两条不需要的记录

Revision ID: 202610110004
Revises: 202610110003
Create Date: 2026-10-11

背景
----
客户域原先**不执行可见性过滤**，而订单/报价/单证/询盘都执行 —— 同一个客户会出现
「列表里看得见、点进去 404」。本次让客户域执行同一套规则（代码侧改动），
这里补上配套的数据归属。

本迁移做两件事
--------------
1. **联佳丝网的账号行归入「安平县联佳丝网制品有限公司」团队**。
   它 `team_id` 为空时，按新规则对成员账号不可见 —— 会"凭空消失"。
   归入团队后联佳账号照旧看得见自己的这一行。
2. **软删除 `客户B`(code=client_b) 与 `[BUYER COMPANY NAME]`**（业务确认不需要）。
   用**软删除**而非物理删除：单证的 `customer_id` 是 TEXT 引用（无外键），
   物理删除会让历史报价/单证指向一个不存在的客户，而软删除保住了历史可追溯性。

注意
----
- **不能用 `tenant_id = 'default'` 过滤**：这三行是历史多租户种子数据，
  `联佳丝网` 的 tenant 是 `'lianjia'`、`客户B` 是 `'client_b'`、`[BUYER COMPANY NAME]`
  才是 `'default'`。按 `'default'` 过滤只会命中第三行（第一版就踩了这个坑）。
  故一律按 `code` / `name` 定位。
- `is_deleted` 此前**只写不读**（软删除标记了但列表照样列出来）。本次代码侧已同步补上
  读取过滤（两端），所以这里的软删除才会真正生效。
- `clientb@kaas.local` 账号仍绑定在被删除的客户B上（登录不受影响，其客户列表会为空）——
  如需一并处理该账号，请单独确认。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110004"
down_revision: Union[str, None] = "202610110003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TEAM_NAME = "安平县联佳丝网制品有限公司"
# 保留：联佳丝网的账号行（归入联佳团队）；删除：下面两条
KEEP_CODE = "lianjia"
DELETE_CODES = ("client_b",)
DELETE_NAMES = ("[BUYER COMPANY NAME]",)


def upgrade() -> None:
    # 1) 联佳的账号行归入联佳团队（按 code 定位，不假设租户——
    #    否则会写进空子查询，把 team_id 设成 NULL 而"什么都没发生"）
    op.execute(sa.text(
        "UPDATE customers SET team_id = ("
        "  SELECT id FROM teams WHERE name = :team ORDER BY id LIMIT 1"
        ") WHERE code = :code AND team_id IS NULL"
    ).bindparams(team=TEAM_NAME, code=KEEP_CODE))

    # 2) 清掉两条不需要的记录（软删除：单证/报价的 customer_id 是 TEXT 引用，
    #    物理删除会让历史单据指向不存在的客户）
    op.execute(sa.text(
        "UPDATE customers SET is_deleted = true, deleted_at = now()"
        " WHERE is_deleted = false"
        "   AND (code = ANY(:codes) OR name = ANY(:names))"
    ).bindparams(codes=list(DELETE_CODES), names=list(DELETE_NAMES)))


def downgrade() -> None:
    # 只撤销软删除与团队归属，不重建数据（删除是业务决定，回滚不该"复活"客户）
    op.execute(sa.text(
        "UPDATE customers SET is_deleted = false, deleted_at = NULL"
        " WHERE code = ANY(:codes) OR name = ANY(:names)"
    ).bindparams(codes=list(DELETE_CODES), names=list(DELETE_NAMES)))
    op.execute(sa.text(
        "UPDATE customers SET team_id = NULL WHERE code = :code"
    ).bindparams(code=KEEP_CODE))
