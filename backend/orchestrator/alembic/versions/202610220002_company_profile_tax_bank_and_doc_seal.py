"""企业主体信息补税号/中英银行信息 + 单证盖章开关（2026-10-22）

Revision ID: 202610220002
Revises: 202610220001
Create Date: 2026-10-22 14:10:00.000000

用户口径（2026-10-22）
----------------------
1. 对外单证（PI/CI/合同）要印**卖方税号**与**结构化收款账户**（受益人名/址/税号、
   开户行及地址、账号、SWIFT）。`bank_name` 仍存英文开户行；中文名/中英地址另开列，
   英文单证只取英文列，中文仅内部识别。
2. 开单时可**取消盖章**：`trade_docs.with_seal`（BOOLEAN NOT NULL DEFAULT TRUE）。
   默认 TRUE ⇒ 历史单据行为不变（仍自动带出租户默认公章）；FALSE 时 render-data
   不注入默认章（显式 `custom.company_stamp` 仍以单据为准）。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "202610220002"
down_revision: Union[str, None] = "202610220001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# 期序列（down 时反序删；up 时按此顺序加）
PROFILE_COLUMNS = ("tax_id", "bank_name_zh", "bank_address_en", "bank_address_zh")


def upgrade() -> None:
    # ── 1) 企业主体信息：税号 + 中英银行信息 ──────────────────────────────
    for column in PROFILE_COLUMNS:
        op.add_column(
            "tenant_company_profile",
            sa.Column(column, sa.Text(), nullable=True),
        )

    # ── 2) 单证盖章开关 ──────────────────────────────────────────────────
    # 服务端默认值必须留：老行/漏写列的 INSERT 都要按"盖章"处理。
    op.add_column(
        "trade_docs",
        sa.Column(
            "with_seal", sa.Boolean(), nullable=False,
            server_default=sa.text("true"),
        ),
    )


def downgrade() -> None:
    op.drop_column("trade_docs", "with_seal")
    for column in reversed(PROFILE_COLUMNS):
        op.drop_column("tenant_company_profile", column)
