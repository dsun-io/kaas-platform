"""单证指纹对账结果表 `trade_doc_render_checks`（TODO A8/A9）

背景
----
签发时会冻结「渲染输入指纹」（`raw_payload._render`），单张/批量对账端点能回答
"这张单据签发后内容被改过吗"。但此前两个缺口（`docs/TRADE_DOC_PDF_ARCHIVAL.md` §〇.3 自述）：
1. **没有定时调度**：批量对账一次最多 50 张、必须人工触发；
2. **列表页看不到**：结论要逐张点开才知道。

本表存**每张单据最近一次**定时对账的结论（按 tenant+doc 唯一，覆盖写），
cron 每日扫描近 30 天签发的单据写入；列表端点 join 它给出「已变更」标识。

为什么单独建表而不塞进 events / business_events
-----------------------------------------------
- `business_events` 的 event_type 是契约枚举（R0 锁死 11 类），加类型要动前后端契约；
- 本表是**运维对账状态**（每单一行、覆盖写），不是业务事件流（只增不删）。

Revision ID: 202610200002
Revises: 202610200001
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202610200002"
down_revision: Union[str, None] = "202610200001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "trade_doc_render_checks",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False),
        sa.Column(
            "trade_doc_id", sa.BigInteger(),
            sa.ForeignKey("trade_docs.id", ondelete="CASCADE"), nullable=False,
        ),
        sa.Column("checked_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("matches", sa.Boolean(), nullable=False),
        # matched | data_changed | version_drift | no_fingerprint |
        # current_unavailable | frozen_unavailable（内核原值）
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("render_version_drift", sa.Boolean(), nullable=False, server_default="false"),
        # 完整卡片（含两侧 sha256 / note / error），排查时不用重跑对账
        sa.Column("result", JSONB, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "tenant_id", "trade_doc_id", name="uq_trade_doc_render_checks_doc",
        ),
    )


def downgrade() -> None:
    op.drop_table("trade_doc_render_checks")
