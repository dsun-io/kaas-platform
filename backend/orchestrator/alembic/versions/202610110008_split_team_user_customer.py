"""拆分「团队 / 用户(账号) / 业务客户」三个概念

Revision ID: 202610110008
Revises: 202610110007
Create Date: 2026-10-11

背景（业务确认）
----------------
`customers` 表此前一身二任，装了两种语义完全不同的行：

1. **团队身份行** —— 注册时给公司建的那一行（如 `联佳丝网` code=`lianjia`）。
   它其实是"这家公司/团队"的身份，真正的团队已经由 `teams` 承载；
2. **业务客户行** —— 客户工位里录入的"我的客户"（Tim、ABC Trading……）。

`user_customers` 又把**用户**绑到第 1 种行上，于是鉴权写成了
"账号没有绑定就 403"（`app/middleware/auth.py`、`app/core/auth.py`）。
本次拆开之后：

| 概念 | 表 | 职责 |
|---|---|---|
| 团队 | `teams` | 公司/团队；`created_by`=团队管理员；成员靠 `users.team_id` |
| 用户(账号) | `users` | 登录账号 + `team_id` + `console_access`（官网数据后台权限） |
| 业务客户 | `customers` | **只放业务客户** |
| 官网数据后台授权 | `user_customers` | 用户 ↔ **业务客户** 的后台访问授权 |

**关键**：账号归属不再来自 `user_customers`（它原来指向公司行，而公司行本次被删）
—— 否则绑定一删，所有 customer 账号都会被锁在门外。团队归属改用 `users.team_id`。

本迁移做三件事
--------------
1. `users` 加 `console_access BOOLEAN NOT NULL DEFAULT false`
   —— 官网数据后台是**独立权限**，与"是不是团队管理员"无关，默认关闭（要显式授予）。
2. 删除代表团队/公司的 `customers` 行：`code = 'lianjia'`
   （`client_b` 与 `[BUYER COMPANY NAME]` 已由 202610110004 软删除，本次不动）。
3. 清理指向被删客户的 `user_customers` 绑定 —— 客户行都没了，绑定没有意义。

为什么先删绑定再删客户行
------------------------
`user_customers.customer_id` 是 `NO ACTION` 外键（不是 CASCADE），顺序反了会直接撞外键。
同类"NO ACTION"外键还有 `channel_links` / `usage_events`，本迁移按表逐个检查：
**有引用就中止并报错**，而不是擅自 CASCADE —— 静默连带删除业务数据比迁移失败危险得多。
（`cust_contacts` / `cust_inquiries` / `cust_stage_log` 是 CASCADE：它们本来就是挂在客户下的子行。）

downgrade
---------
只删列，**不重建数据** —— 被删的客户行/绑定是业务决定，可回滚的只有 schema。
需要数据回退请从备份恢复（与 202610110004、202610110005 同一口径）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202610110008"
down_revision: Union[str, None] = "202610110007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# 被删除的"团队身份行"：联佳丝网的账号行（真正身份在 teams 表里）
TEAM_CUSTOMER_CODE = "lianjia"

# 允许随客户行一起级联消失的子表（本来就是客户的明细行）
CASCADING_REFS = ("cust_contacts", "cust_inquiries", "cust_stage_log")
# 不允许静默连带删除的引用表：有数据就中止本次迁移，交给人处理
BLOCKING_REFS = ("channel_links", "usage_events")


def _count_ref(conn, table: str, customer_id: int) -> int:
    return int(conn.execute(
        sa.text(f"SELECT count(*) FROM {table} WHERE customer_id = :cid"),
        {"cid": customer_id},
    ).scalar() or 0)


def _delete_customer_rows(conn, codes, names, *, is_deleted=None) -> None:
    """按 code/name 定位并删除客户行（含它们的外键引用）。

    刻意**不按 tenant_id 过滤**：历史数据的租户标签各不相同
    （202610110004 的注释里记过这个坑），按租户过滤会静默漏删。
    """
    sql = "SELECT id, code, name, is_deleted FROM customers WHERE code = ANY(:codes) OR name = ANY(:names)"
    params = {"codes": list(codes), "names": list(names)}
    if is_deleted is not None:
        sql += " AND is_deleted = :is_deleted"
        params["is_deleted"] = is_deleted
    rows = conn.execute(sa.text(sql), params).fetchall()

    for row in rows:
        cid = int(row[0])
        for table in CASCADING_REFS:
            conn.execute(
                sa.text(f"DELETE FROM {table} WHERE customer_id = :cid"), {"cid": cid})
        for table in BLOCKING_REFS:
            n = _count_ref(conn, table, cid)
            if n:
                # 中止整个迁移（Alembic 每个迁移跑在单事务里，异常即整体回滚）：
                # 这里宁可失败也不能让别处的业务数据被静默带走。
                raise RuntimeError(
                    f"customers.id={cid}（code={row[1]!r}）仍被 {table} 引用 {n} 行，"
                    f"迁移中止：请先确认这些数据的归属再删客户行"
                )
        conn.execute(
            sa.text("DELETE FROM user_customers WHERE customer_id = :cid"), {"cid": cid})
        conn.execute(
            sa.text("DELETE FROM customers WHERE id = :cid"), {"cid": cid})


def upgrade() -> None:
    # server_default 让**存量行**立刻有确定值（NOT NULL 加列必须有 default），
    # 否则老账号这一列会是 NULL，"有没有后台权限"就变成了三态。
    op.add_column("users", sa.Column(
        "console_access", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    # 只删"活着的"那一行：已软删除的行（client_b / [BUYER COMPANY NAME]）本次不动，
    # 也不能因为 code/name 撞上而被顺手带走。
    _delete_customer_rows(op.get_bind(), (TEAM_CUSTOMER_CODE,), (), is_deleted=False)


def downgrade() -> None:
    # 数据回退从备份恢复（见模块 docstring）；这里只撤销 schema。
    op.drop_column("users", "console_access")
