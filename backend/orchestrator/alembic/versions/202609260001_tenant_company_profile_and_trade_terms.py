"""tenant_company_profile + 报价/订单贸易条款正列

Revision ID: 202609260001
Revises: 202609250001
Create Date: 2026-09-26

修两个「单证出不来」的业务缺陷：

1. **卖方抬头无处配置**（最严重）
   全库只有注册流程存过公司名，单证里的卖方信头因此恒为空 ——
   单据没有卖方抬头等于废纸，且每张都要手填。
   新建 `tenant_company_profile`（租户级企业主体信息），保存后所有单证自动带入。

2. **贸易条款无法从报价/订单继承**
   报价谈定的 Incoterm / 付款方式 / 装卸港 / 唛头 / 原产国，是信用证审单的核心要素。
   原先 quote_orders / orders 没有这些列，单证只能手工重填 →
   极易与合同不一致，在信用证下就是「不符点」。
   因此加**正列**（而不是塞进 JSONB）：这些是稳定的核心业务字段，有查询与校验需求。

注：`incoterm` 在 intel_shipments（商情雷达货运记录）里已有，与本迁移无关。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "202609260001"
down_revision: Union[str, None] = "202609250001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 报价单 / 订单共用的贸易条款列
TRADE_TERM_COLUMNS = (
    "incoterm",
    "payment_terms",
    "port_of_loading",
    "port_of_destination",
    "shipping_marks",
    "country_of_origin",
)


def upgrade() -> None:
    # ── 1. 企业主体信息（租户级，单据卖方抬头）────────────────────────────
    op.create_table(
        "tenant_company_profile",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 公司名（英文为对外签约主体，必填）
        sa.Column("name_en", sa.Text(), nullable=False),
        sa.Column("name_zh", sa.Text(), nullable=True),
        # 地址：对外单据用英文
        sa.Column("address_en", sa.Text(), nullable=True),
        sa.Column("address_zh", sa.Text(), nullable=True),
        sa.Column("phone", sa.Text(), nullable=True),
        sa.Column("email", sa.Text(), nullable=True),
        sa.Column("website", sa.Text(), nullable=True),
        # 收款银行（PI / 合同 / 汇票用）
        sa.Column("bank_name", sa.Text(), nullable=True),
        sa.Column("bank_account", sa.Text(), nullable=True),
        sa.Column("swift_code", sa.Text(), nullable=True),
        sa.Column("logo_url", sa.Text(), nullable=True),
        # 单据默认条款（新开单时预填，省去每张重填）
        sa.Column("default_incoterm", sa.Text(), nullable=True),
        sa.Column("default_payment_terms", sa.Text(), nullable=True),
        sa.Column("default_country_of_origin", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", name="uq_tenant_company_profile_tenant"),
    )

    # ── 2. 报价单 / 订单的贸易条款列 ─────────────────────────────────────
    for table in ("quote_orders", "orders"):
        for column in TRADE_TERM_COLUMNS:
            op.add_column(table, sa.Column(column, sa.Text(), nullable=True))

    # 报价单已有 valid_until；订单没有，此处不加（避免改变既有业务语义）


def downgrade() -> None:
    for table in ("quote_orders", "orders"):
        for column in reversed(TRADE_TERM_COLUMNS):
            op.drop_column(table, column)

    op.drop_table("tenant_company_profile")
