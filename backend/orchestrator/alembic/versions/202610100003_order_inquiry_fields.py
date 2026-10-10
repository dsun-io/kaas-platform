"""订单/运输信息补字段 + 询价历史留存增强

Revision ID: 202610100003
Revises: 202610100002
Create Date: 2026-10-10

1. **订单地区 ≠ 客户地区**：客户档案里的「地区」是客户注册地，订单/运输信息里的
   destination_country/region 是收货地（经销商/中间商场景下两者常不同，如美国客户发南非）。
2. **海运费有效期**（起/截止日）落在订单/运输范围内；**船公司** carrier 加上。
3. **产品图片**：报价/订单行项已有 image_url（202610100001），这里给订单头补 notes 兜底。
4. **询价历史留存**：同客户同订单多次询价（不同产品/规格）+ 我方报价 + 时间线。
   cust_inquiries 加 inquiry_seq（同客户下第几次询价）、spec_snapshot（本次询价的产品/规格快照）。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202610100003"
down_revision: Union[str, None] = "202610100002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 订单/运输：收货地、海运费有效期、船公司 ──
    for table in ("orders", "quote_orders"):
        op.add_column(table, sa.Column("destination_country", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("destination_region", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("carrier", sa.Text(), nullable=True))
        op.add_column(table, sa.Column("freight_valid_from", sa.Date(), nullable=True))
        op.add_column(table, sa.Column("freight_valid_to", sa.Date(), nullable=True))

    # ── 询价历史留存：同客户多次询价 + 产品/规格快照 ──
    op.add_column("cust_inquiries", sa.Column("inquiry_seq", sa.Integer(), nullable=True))
    op.add_column("cust_inquiries", sa.Column("spec_snapshot", postgresql.JSONB(), nullable=True))
    op.create_index(
        "idx_cust_inquiries_customer_seq",
        "cust_inquiries",
        ["customer_id", "inquiry_seq"],
    )


def downgrade() -> None:
    op.drop_index("idx_cust_inquiries_customer_seq", table_name="cust_inquiries")
    op.drop_column("cust_inquiries", "spec_snapshot")
    op.drop_column("cust_inquiries", "inquiry_seq")
    for table in ("orders", "quote_orders"):
        op.drop_column(table, "freight_valid_to")
        op.drop_column(table, "freight_valid_from")
        op.drop_column(table, "carrier")
        op.drop_column(table, "destination_region")
        op.drop_column(table, "destination_country")
