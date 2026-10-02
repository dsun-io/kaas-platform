"""单证工位独立化 · 公章存储 + 单证派生引用 + 行项目产品段/方案价

Revision ID: 202609300001
Revises: 202609270002
Create Date: 2026-09-30

三个业务缺口（单证工位独立可用的地基）：

1. **公章无处保存**：单证签章区要盖公司公章，原先只有 logo_url 外链，
   用户上传的公章图片需要转 PNG 后落库（BYTEA），并支持多枚 + 默认章。
   只存 PNG（打印色彩稳定）；其他格式由 API 层用 Pillow 转换后入库。

2. **单证不能从单证派生**：QUO→PI→CI→PL/CO 是一条出单链，后单应从前单
   提取参数而非重录。现有 refs 只有"上游实体→单证"（order/quote/inquiry），
   补"单证→单证"派生引用（derived_from），快照冻结语义与上游 refs 一致。

3. **行项目缺产品段与方案价**：多产品混一张单要分产品段（group_no）；
   报价单多方案（如 3万米/5万米）各方案单价不同（scheme_prices），
   PI 确认方案后手动录入数量单价。自由行与生成行用 source 区分。
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "202609300001"
down_revision: Union[str, None] = "202609270002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ─── 1. 公章（租户级，多枚 + 一枚默认）────────────────────────────────
    op.create_table(
        "tenant_company_seals",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 章的用途名：公章 / 财务章 / 法人章…
        sa.Column("name", sa.Text(), nullable=False),
        # 只存 PNG；上传其他格式由 API 层 Pillow 转换后入库
        sa.Column("mime", sa.Text(), nullable=False, server_default="image/png"),
        sa.Column("png_bytes", sa.LargeBinary(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("tenant_id", "name", name="uq_tenant_company_seals_name"),
    )
    # 每租户至多一枚默认章（部分唯一索引）
    op.create_index(
        "uq_tenant_company_seals_default",
        "tenant_company_seals",
        ["tenant_id"],
        unique=True,
        postgresql_where=sa.text("is_default"),
    )
    op.create_index(
        "idx_tenant_company_seals_tenant",
        "tenant_company_seals",
        ["tenant_id"],
    )

    # ─── 2. 单证→单证派生引用 ────────────────────────────────────────────
    op.create_table(
        "trade_doc_doc_refs",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column("trade_doc_id", sa.BigInteger(), nullable=False),
        sa.Column("source_trade_doc_id", sa.BigInteger(), nullable=False),
        sa.Column("ref_type", sa.Text(), nullable=False, server_default="derived_from"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "tenant_id", "trade_doc_id", "ref_type", "source_trade_doc_id",
            name="uq_trade_doc_doc_refs",
        ),
    )
    op.create_index(
        "idx_trade_doc_doc_refs_doc",
        "trade_doc_doc_refs",
        ["tenant_id", "trade_doc_id"],
    )
    op.create_index(
        "idx_trade_doc_doc_refs_source",
        "trade_doc_doc_refs",
        ["tenant_id", "source_trade_doc_id"],
    )

    # ─── 3. 行项目：产品段 / 方案价 / 来源 ────────────────────────────────
    op.add_column("trade_doc_items", sa.Column("group_no", sa.Integer(), nullable=False, server_default=sa.text("0")))
    op.add_column("trade_doc_items", sa.Column("scheme_prices", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.add_column("trade_doc_items", sa.Column("source", sa.Text(), nullable=False, server_default="manual"))

    # ─── 4. 按客户整理单证的查询索引 ─────────────────────────────────────
    op.create_index(
        "idx_trade_docs_customer",
        "trade_docs",
        ["tenant_id", "customer_id"],
    )


def downgrade() -> None:
    op.drop_index("idx_trade_docs_customer", table_name="trade_docs")
    op.drop_column("trade_doc_items", "source")
    op.drop_column("trade_doc_items", "scheme_prices")
    op.drop_column("trade_doc_items", "group_no")
    op.drop_index("idx_trade_doc_doc_refs_source", table_name="trade_doc_doc_refs")
    op.drop_index("idx_trade_doc_doc_refs_doc", table_name="trade_doc_doc_refs")
    op.drop_table("trade_doc_doc_refs")
    op.drop_index("idx_tenant_company_seals_tenant", table_name="tenant_company_seals")
    op.drop_index("uq_tenant_company_seals_default", table_name="tenant_company_seals")
    op.drop_table("tenant_company_seals")
