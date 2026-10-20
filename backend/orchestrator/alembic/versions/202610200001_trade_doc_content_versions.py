"""单证内容级版本表 `trade_doc_content_versions`（TODO A1）

背景
----
单证草稿期反复改 `raw_payload.custom` 时，内容**直接覆盖**，改前找不回。
`raw_payload._audit` 只记"谁/何时/改了哪些 custom 键"（可读、不可回滚，也不含 sources）。
本表按单据内递增版本号存**整份 payload 快照**（sources + custom），支持回看与恢复。
签发（issued）后内容锁死，不再产生新版本。

与既有版本链的区别
------------------
`file_objects.version/is_current/supersedes_id` 是**上传 PDF 文件**的版本链；
本表是**单证内容**的版本链，两者互不替代（同一份单据可以"内容 v3 + 文件 v2"）。

Revision ID: 202610200001
Revises: 202610190020
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202610200001"
down_revision: Union[str, None] = "202610190020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "trade_doc_content_versions",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        # 单据删除时版本一并回收（版本只是内容留档，不是对外凭证）
        sa.Column(
            "trade_doc_id", sa.BigInteger(),
            sa.ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("version_no", sa.Integer(), nullable=False),
        sa.Column("raw_payload", JSONB, nullable=False),
        # custom_update | refresh_sources | issue | restore
        sa.Column("change_source", sa.Text(), nullable=False, server_default="custom_update"),
        sa.Column("actor_id", sa.Text(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.UniqueConstraint(
            "tenant_id", "trade_doc_id", "version_no",
            name="uq_trade_doc_content_versions_no",
        ),
    )
    op.create_index(
        "idx_trade_doc_content_versions_doc",
        "trade_doc_content_versions",
        ["tenant_id", "trade_doc_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "idx_trade_doc_content_versions_doc",
        table_name="trade_doc_content_versions",
    )
    op.drop_table("trade_doc_content_versions")
