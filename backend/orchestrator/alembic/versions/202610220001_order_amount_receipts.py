"""订单金额构成 + 实收登记（设计 §13.3，P1）与询盘多产品行（设计 §5，P2）

Revision ID: 202610220001
Revises: 202610210002
Create Date: 2026-10-22 13:30:00.000000

用户口径（2026-10-22 拍板）
--------------------------
1. 建单要填各项金额：货物金额（行项汇总）+ 运费 + 保险费 + 其他费用；
   订单总额 = 四项之和，仍落 `orders.total_amount`；
   四项明细进新列 `orders.amount_breakdown`（jsonb），供详情回显与修改。
2. 应收按填写的金额/比例直接算；创建订单时同一事务生成收款计划与应收台账。
3. 后期可登记实收（应收与实收可能对应不上）：一次收款一行，进新表
   `payment_receipts`；允许同一期多次收款、允许 schedule_id 为空（未分配收款）。
4. 到账截图走现有文件管线：文件归属类型新增 `payment_receipt`。
5. 询盘多产品：`cust_inquiries.items`（jsonb 数组）存多个产品行；
   **旧标量字段全部保留**（第一行同步写入），旧报表/链式分析不用改。

本迁移只加结构、不改任何历史列语义
--------------------------------
- `cust_inquiries.items` NOT NULL DEFAULT '[]'：历史行拿到空数组，
  读取时由共享序列化 `inquiry_items()` 用旧字段合成一行（不 backfill —— 回填会把
  "旧数据"和"新录入"混成一份，且今后改旧字段时 items 会变脏）。
- `orders.amount_breakdown` 可空：历史订单没有明细，前端回退 total_amount。
- `payment_receipts` 是纯增量表；已标记 paid 但无 receipts 的历史期次保持原样
  （应用层按"历史收款（无截图）"兼容，不强制补录）。
- `SCHEDULE_STATUS` 加 `partial` 只是共享枚举/校验，无表约束，故本迁移无列改动。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "202610220001"
down_revision: Union[str, None] = "202610210002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1) 询盘多产品行（P2）───────────────────────────────────────────────
    op.add_column(
        "cust_inquiries",
        sa.Column(
            "items", postgresql.JSONB(), nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )

    # ── 2) 订单金额构成（P1）───────────────────────────────────────────────
    op.add_column(
        "orders",
        sa.Column("amount_breakdown", postgresql.JSONB(), nullable=True),
    )

    # ── 3) 实收登记表（P1 核心新能力）──────────────────────────────────────
    # 一次收款一行；schedule_id 可空 = 这笔款暂不指定期次（页面「未分配收款」）。
    # amount 是**实际到账**金额，允许与期次金额不同（差异由页面展示，不静默改计划）。
    # file_id 指向到账截图（file_objects，owner_type='payment_receipt'）。
    op.create_table(
        "payment_receipts",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "tenant_id", sa.Text(), nullable=False, server_default="default",
        ),
        sa.Column(
            "order_id", sa.BigInteger(),
            sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False,
        ),
        # 可空：一笔款暂不指定期次；期次被删时收款记录保留（SET NULL 而非级联删）
        sa.Column(
            "schedule_id", sa.BigInteger(),
            sa.ForeignKey("payment_schedules.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("currency", sa.Text(), nullable=False, server_default="USD"),
        sa.Column("received_date", sa.Date(), nullable=False),
        # 实际汇率（可空）：与订单/应收锁定汇率不同即记汇兑差异（应用层计算）
        sa.Column("fx_rate", sa.Numeric(20, 8), nullable=True),
        # 到账截图文件 id（file_objects.id；可空 = 暂未上传）
        sa.Column("file_id", sa.BigInteger(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_by", sa.Text(), nullable=True),
        # 数据可见范围（与订单/收款计划同口径）
        sa.Column("owner_id", sa.Text(), nullable=True),
        sa.Column(
            "owner_scope", sa.Text(), nullable=False, server_default="private",
        ),
        # 三层组织：本行归属的团队（写入时取订单的团队；NULL = 未分组）
        sa.Column(
            "team_id", sa.BigInteger(),
            sa.ForeignKey("teams.id", ondelete="SET NULL"), nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "idx_payment_receipts_order",
        "payment_receipts", ["tenant_id", "order_id", "received_date"],
    )
    op.create_index(
        "idx_payment_receipts_schedule",
        "payment_receipts", ["tenant_id", "schedule_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_payment_receipts_schedule", table_name="payment_receipts")
    op.drop_index("idx_payment_receipts_order", table_name="payment_receipts")
    op.drop_table("payment_receipts")
    op.drop_column("orders", "amount_breakdown")
    op.drop_column("cust_inquiries", "items")
