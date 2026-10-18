"""税务档案表 + 种子 + 旧客户税率档案迁移

Revision ID: 202610180006
Revises: 202610180005
Create Date: 2026-10-18

TAX-00 拍板结果：
  · 新表 `tax_archives`，团队级（tenant_id + team_id）；
  · 旧 `customer_quote_profiles` 按「团队 + 税率组合」去重迁移；
    旧表停写、数据保留，不删表；
  · 每个有旧档案的团队：迁移出的组合各成一份档案；
    没有旧档案的团队：种一份 `默认税率档案（2026-09）`
    （进项 10% / 销项 0 / 出口退税空 / 杂税 3%）。

旧 `tax_overrides` 里可能有 `stamp_rate`（fixed/ratio 模式用），新口径印花税
已并入杂税（`misc_fee_rate`）——迁移时把 `stamp_rate` 映射为 `misc_fee_rate`。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "202610180006"
down_revision: Union[str, None] = "202610180005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "tax_archives",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.Text(), nullable=False, server_default="default"),
        sa.Column("team_id", sa.BigInteger(), nullable=True),
        sa.Column("code", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("effective_from", sa.Date(), nullable=True),
        sa.Column("effective_to", sa.Date(), nullable=True),
        sa.Column("tax_values", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("source", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False, server_default="active"),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("tenant_id", "team_id", "name", name="uq_tax_archives_team_name"),
        sa.UniqueConstraint("tenant_id", "team_id", "code", name="uq_tax_archives_team_code"),
    )
    op.create_index(
        "idx_tax_archives_team_status",
        "tax_archives",
        ["tenant_id", "team_id", "status", "effective_from", "updated_at"],
    )

    # ── 旧客户税率档案 → 团队级档案（按税率组合去重）────────────────────
    # 只用 active 档案；只迁能挂到客户团队的行（team_id 为空的旧行跳过）。
    op.execute(
        """
        WITH normalized AS (
            SELECT
                c.team_id AS team_id,
                p.profile_name AS profile_name,
                p.created_at AS created_at,
                jsonb_strip_nulls(jsonb_build_object(
                    'input_vat_rate',
                        CASE WHEN p.tax_overrides ? 'input_vat_rate'
                             THEN (p.tax_overrides->>'input_vat_rate')::numeric END,
                    'output_vat_rate',
                        CASE WHEN p.tax_overrides ? 'output_vat_rate'
                             THEN (p.tax_overrides->>'output_vat_rate')::numeric END,
                    'rebate_rate',
                        CASE WHEN p.tax_overrides ? 'rebate_rate'
                             THEN (p.tax_overrides->>'rebate_rate')::numeric END,
                    -- 旧 fixed/ratio 的印花税并入新杂税
                    'misc_fee_rate',
                        CASE WHEN p.tax_overrides ? 'misc_fee_rate'
                             THEN (p.tax_overrides->>'misc_fee_rate')::numeric
                             WHEN p.tax_overrides ? 'stamp_rate'
                             THEN (p.tax_overrides->>'stamp_rate')::numeric END
                )) AS tax_values
            FROM customer_quote_profiles p
            JOIN customers c
              ON c.tenant_id = p.tenant_id
             AND c.id::text = p.customer_id
            WHERE p.status = 'active'
              AND c.team_id IS NOT NULL
              AND p.tax_overrides IS NOT NULL
              AND p.tax_overrides <> '{}'::jsonb
        ),
        dedup AS (
            SELECT
                team_id,
                tax_values,
                min(profile_name) AS sample_name,
                row_number() OVER (
                    PARTITION BY team_id ORDER BY min(created_at), min(profile_name)
                ) AS rn
            FROM normalized
            GROUP BY team_id, tax_values
            HAVING bool_or(tax_values <> '{}'::jsonb)
        )
        INSERT INTO tax_archives
            (tenant_id, team_id, code, name, effective_from, tax_values, source, status)
        SELECT
            t.tenant_id,
            d.team_id,
            'TAX-MIG-' || d.rn,
            '迁移-' || left(d.sample_name, 40) || '-' || d.rn,
            DATE '2026-09-01',
            d.tax_values,
            'legacy-customer-profile',
            'active'
        FROM dedup d
        JOIN teams t ON t.id = d.team_id
        """
    )

    # ── 没有旧档案的团队：种一份默认档案 ────────────────────────────────
    op.execute(
        """
        INSERT INTO tax_archives
            (tenant_id, team_id, code, name, effective_from, tax_values, source, status)
        SELECT
            t.tenant_id,
            t.id,
            'TAX-202609',
            '默认税率档案（2026-09）',
            DATE '2026-09-01',
            jsonb_build_object(
                'input_vat_rate', 0.10,
                'output_vat_rate', 0,
                'misc_fee_rate', 0.03
            ),
            'seed',
            'active'
        FROM teams t
        WHERE NOT EXISTS (
            SELECT 1 FROM tax_archives a
            WHERE a.tenant_id = t.tenant_id AND a.team_id = t.id
        )
        """
    )


def downgrade() -> None:
    op.drop_index("idx_tax_archives_team_status", table_name="tax_archives")
    op.drop_table("tax_archives")
