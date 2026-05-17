"""spec system v1 — 13 tables + view + seed

Revision ID: 202605170001
Revises: feb821f0b9c0
Create Date: 2026-05-17

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '202605170001'
down_revision: Union[str, None] = 'feb821f0b9c0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Extensions ──
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")

    # ── 1. product_categories ──
    op.create_table(
        'product_categories',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('code', sa.Text, nullable=False, unique=True),
        sa.Column('name', sa.Text, nullable=False),
        sa.Column('parent_id', sa.BigInteger, sa.ForeignKey('product_categories.id', ondelete='RESTRICT'), nullable=True),
        sa.Column('path', sa.Text, nullable=False),
        sa.Column('level', sa.Integer, nullable=False, server_default='1'),
        sa.Column('industry_code', sa.Text, nullable=False),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
        sa.Column('is_leaf', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index('idx_pc_path', 'product_categories', ['path'])
    op.create_index('idx_pc_industry', 'product_categories', ['industry_code'])
    op.create_index('idx_pc_parent', 'product_categories', ['parent_id'])

    # ── 2. unit_groups ──
    op.create_table(
        'unit_groups',
        sa.Column('code', sa.Text, primary_key=True),
        sa.Column('name', sa.Text, nullable=False),
        sa.Column('base_unit', sa.Text, nullable=False),
    )

    # ── 3. units ──
    op.create_table(
        'units',
        sa.Column('code', sa.Text, primary_key=True),
        sa.Column('label', sa.Text, nullable=False),
        sa.Column('unit_group', sa.Text, sa.ForeignKey('unit_groups.code'), nullable=False),
        sa.Column('to_base_factor', sa.Numeric(20, 10), nullable=False),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
    )

    # ── 4. price_units ──
    op.create_table(
        'price_units',
        sa.Column('code', sa.Text, primary_key=True),
        sa.Column('label', sa.Text, nullable=False),
        sa.Column('currency', sa.Text, nullable=False),
        sa.Column('unit', sa.Text, nullable=False),
        sa.Column('unit_group', sa.Text, nullable=False),
        sa.Column('applicable_categories', postgresql.JSONB, nullable=True),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
    )

    # ── 5. spec_attributes ──
    op.create_table(
        'spec_attributes',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('code', sa.Text, nullable=False),
        sa.Column('name', sa.Text, nullable=False),
        sa.Column('aliases', postgresql.JSONB, nullable=False, server_default="'[]'::jsonb"),
        sa.Column('group_code', sa.Text, nullable=False),
        sa.Column('data_type', sa.Text, nullable=False),
        sa.Column('unit', sa.Text, nullable=True),
        sa.Column('unit_group', sa.Text, nullable=True),
        sa.Column('number_min', sa.Numeric, nullable=True),
        sa.Column('number_max', sa.Numeric, nullable=True),
        sa.Column('number_step', sa.Numeric, nullable=True),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('scope', sa.Text, nullable=False, server_default="'private'"),
        sa.Column('tenant_id', sa.Text, nullable=True),
        sa.Column('source', sa.Text, nullable=False, server_default="'tenant'"),
        sa.Column('status', sa.Text, nullable=False, server_default="'active'"),
        sa.Column('promoted_from', sa.BigInteger, nullable=True),
        sa.Column('created_by', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    # CHECK constraints
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_group CHECK (group_code IN ('identity','variant','spec','pricing','temporal'))")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_type CHECK (data_type IN ('enum','multi_enum','number','text','bool'))")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_scope CHECK (scope IN ('public','private','proposal'))")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_status CHECK (status IN ('active','deprecated','pending_review','rejected'))")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_group_type CHECK ((group_code = 'variant' AND data_type IN ('enum','multi_enum','bool')) OR (group_code = 'spec' AND data_type IN ('number','text','enum')) OR (group_code IN ('identity','pricing','temporal')))")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT chk_sa_spec_unit CHECK (group_code != 'spec' OR data_type != 'number' OR unit_group IS NOT NULL)")
    op.execute("ALTER TABLE spec_attributes ADD CONSTRAINT uq_sa_code UNIQUE (scope, tenant_id, code)")
    op.create_index('idx_sa_scope_status', 'spec_attributes', ['scope', 'status'])
    op.create_index('idx_sa_group', 'spec_attributes', ['group_code'])
    op.execute("CREATE INDEX idx_sa_name_trgm ON spec_attributes USING gin (name gin_trgm_ops)")

    # ── 6. spec_attribute_values ──
    op.create_table(
        'spec_attribute_values',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('attribute_id', sa.BigInteger, sa.ForeignKey('spec_attributes.id', ondelete='CASCADE'), nullable=False),
        sa.Column('value_code', sa.Text, nullable=False),
        sa.Column('value_label', sa.Text, nullable=False),
        sa.Column('value_number', sa.Numeric, nullable=True),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
        sa.Column('scope', sa.Text, nullable=False, server_default="'public'"),
        sa.Column('tenant_id', sa.Text, nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default="'active'"),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE spec_attribute_values ADD CONSTRAINT chk_sav_scope CHECK (scope IN ('public','private','proposal'))")
    op.execute("ALTER TABLE spec_attribute_values ADD CONSTRAINT chk_sav_status CHECK (status IN ('active','deprecated','rejected'))")
    op.execute("ALTER TABLE spec_attribute_values ADD CONSTRAINT uq_sav UNIQUE (attribute_id, scope, tenant_id, value_code)")
    op.create_index('idx_sav_attr', 'spec_attribute_values', ['attribute_id', 'status'])

    # ── 7. category_attribute_bindings ──
    op.create_table(
        'category_attribute_bindings',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('category_id', sa.BigInteger, sa.ForeignKey('product_categories.id', ondelete='CASCADE'), nullable=False),
        sa.Column('attribute_id', sa.BigInteger, sa.ForeignKey('spec_attributes.id', ondelete='CASCADE'), nullable=False),
        sa.Column('group_code', sa.Text, nullable=False),
        sa.Column('attr_role', sa.Text, nullable=False),
        sa.Column('is_required', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('is_locked', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('sort_order', sa.Integer, nullable=False, server_default='0'),
        sa.Column('default_value', postgresql.JSONB, nullable=True),
        sa.Column('depends_on', postgresql.JSONB, nullable=True),
        sa.Column('scope', sa.Text, nullable=False, server_default="'public'"),
        sa.Column('tenant_id', sa.Text, nullable=True),
        sa.Column('schema_version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE category_attribute_bindings ADD CONSTRAINT chk_cab_group CHECK (group_code IN ('identity','variant','spec','pricing','temporal'))")
    op.execute("ALTER TABLE category_attribute_bindings ADD CONSTRAINT chk_cab_role CHECK (attr_role IN ('key','sku','descriptive'))")
    op.execute("ALTER TABLE category_attribute_bindings ADD CONSTRAINT chk_cab_scope CHECK (scope IN ('public','private'))")
    op.execute("ALTER TABLE category_attribute_bindings ADD CONSTRAINT uq_cab UNIQUE (category_id, attribute_id, scope, tenant_id)")
    op.create_index('idx_cab_cat', 'category_attribute_bindings', ['category_id', 'scope', 'tenant_id'])

    # ── 8. industry_templates ──
    op.create_table(
        'industry_templates',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('code', sa.Text, nullable=False),
        sa.Column('name', sa.Text, nullable=False),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('industry_code', sa.Text, nullable=False),
        sa.Column('template_type', sa.Text, nullable=False),
        sa.Column('tenant_id', sa.Text, nullable=True),
        sa.Column('snapshot', postgresql.JSONB, nullable=False),
        sa.Column('snapshot_version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('usage_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_by', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE industry_templates ADD CONSTRAINT chk_it_type CHECK (template_type IN ('official','tenant','shared'))")
    op.execute("ALTER TABLE industry_templates ADD CONSTRAINT uq_it UNIQUE (template_type, tenant_id, code)")
    op.create_index('idx_it_industry', 'industry_templates', ['industry_code', 'is_active'])

    # ── 9. product_skus (含 revision 字段) ──
    op.create_table(
        'product_skus',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('category_id', sa.BigInteger, sa.ForeignKey('product_categories.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('spec_values', postgresql.JSONB, nullable=False),
        sa.Column('spec_hash', sa.Text, nullable=False),
        sa.Column('schema_version', sa.Integer, nullable=False, server_default='1'),
        sa.Column('revision', sa.Integer, nullable=False, server_default='1'),
        sa.Column('weight_kg', sa.Numeric, nullable=True),
        sa.Column('description', sa.Text, nullable=True),
        sa.Column('is_active', sa.Boolean, nullable=False, server_default='true'),
        sa.Column('created_by', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE product_skus ADD CONSTRAINT uq_psk UNIQUE (tenant_id, category_id, spec_hash)")
    op.create_index('idx_psk_lookup', 'product_skus', ['tenant_id', 'category_id', 'is_active'])
    op.execute("CREATE INDEX idx_psk_values_gin ON product_skus USING GIN (spec_values jsonb_path_ops)")

    # ── 10. product_sku_prices (含 change_reason 字段) ──
    op.create_table(
        'product_sku_prices',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('sku_id', sa.BigInteger, sa.ForeignKey('product_skus.id', ondelete='CASCADE'), nullable=False),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('price', sa.Numeric(18, 4), nullable=False),
        sa.Column('currency', sa.Text, nullable=False, server_default="'CNY'"),
        sa.Column('price_unit', sa.Text, sa.ForeignKey('price_units.code'), nullable=False),
        sa.Column('min_qty', sa.Numeric, nullable=True),
        sa.Column('tier_rules', postgresql.JSONB, nullable=True),
        sa.Column('effective_from', sa.DateTime(timezone=True), nullable=False),
        sa.Column('effective_to', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default="'active'"),
        sa.Column('note', sa.Text, nullable=True),
        sa.Column('change_reason', sa.Text, nullable=True),
        sa.Column('created_by', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE product_sku_prices ADD CONSTRAINT chk_psp_status CHECK (status IN ('draft','active','expired','superseded'))")
    op.execute("ALTER TABLE product_sku_prices ADD CONSTRAINT chk_psp_range CHECK (effective_to IS NULL OR effective_to > effective_from)")
    op.execute("""
        ALTER TABLE product_sku_prices ADD CONSTRAINT excl_psp_overlap
        EXCLUDE USING gist (
            sku_id WITH =,
            tstzrange(effective_from, COALESCE(effective_to, 'infinity'::timestamptz), '[)') WITH &&
        ) WHERE (status = 'active')
    """)
    op.create_index('idx_psp_sku_active', 'product_sku_prices', ['sku_id', 'status', 'effective_from'])

    # ── 11. product_sku_revisions (新增) ──
    op.create_table(
        'product_sku_revisions',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('sku_id', sa.BigInteger, sa.ForeignKey('product_skus.id', ondelete='CASCADE'), nullable=False),
        sa.Column('revision', sa.Integer, nullable=False),
        sa.Column('spec_values', postgresql.JSONB, nullable=False),
        sa.Column('spec_hash', sa.Text, nullable=False),
        sa.Column('schema_version', sa.Integer, nullable=False),
        sa.Column('change_reason', sa.Text, nullable=True),
        sa.Column('created_by', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE product_sku_revisions ADD CONSTRAINT uq_psr UNIQUE (sku_id, revision)")
    op.create_index('idx_psr_sku', 'product_sku_revisions', ['sku_id'])

    # ── 12. attribute_proposals (含推荐字段) ──
    op.create_table(
        'attribute_proposals',
        sa.Column('id', sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column('tenant_id', sa.Text, nullable=False),
        sa.Column('category_id', sa.BigInteger, sa.ForeignKey('product_categories.id', ondelete='CASCADE'), nullable=False),
        sa.Column('group_code', sa.Text, nullable=False),
        sa.Column('proposed_name', sa.Text, nullable=False),
        sa.Column('proposed_aliases', postgresql.JSONB, nullable=True, server_default="'[]'::jsonb"),
        sa.Column('proposed_unit', sa.Text, nullable=True),
        sa.Column('proposed_unit_group', sa.Text, nullable=True),
        sa.Column('proposed_type', sa.Text, nullable=False),
        sa.Column('sample_values', postgresql.JSONB, nullable=True),
        sa.Column('occurrence_count', sa.Integer, nullable=False, server_default='1'),
        sa.Column('similar_attribute_id', sa.BigInteger, sa.ForeignKey('spec_attributes.id'), nullable=True),
        sa.Column('similarity_score', sa.Numeric, nullable=True),
        sa.Column('private_attribute_id', sa.BigInteger, sa.ForeignKey('spec_attributes.id'), nullable=True),
        sa.Column('recommended_for_promotion', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('recommendation_score', sa.Numeric, nullable=True),
        sa.Column('recommended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.Text, nullable=False, server_default="'pending'"),
        sa.Column('reviewer', sa.Text, nullable=True),
        sa.Column('review_note', sa.Text, nullable=True),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('promoted_attribute_id', sa.BigInteger, sa.ForeignKey('spec_attributes.id'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.execute("ALTER TABLE attribute_proposals ADD CONSTRAINT chk_ap_status CHECK (status IN ('pending','promoted','merged','rejected'))")
    op.execute("ALTER TABLE attribute_proposals ADD CONSTRAINT chk_ap_group CHECK (group_code IN ('variant','spec'))")
    op.create_index('idx_ap_status', 'attribute_proposals', ['status', 'category_id'])
    op.execute("CREATE INDEX idx_ap_name_trgm ON attribute_proposals USING gin (proposed_name gin_trgm_ops)")

    # ── 13. quotations ALTER ──
    op.add_column('quotations', sa.Column('sku_id', sa.BigInteger, sa.ForeignKey('product_skus.id'), nullable=True))
    op.add_column('quotations', sa.Column('price_id', sa.BigInteger, sa.ForeignKey('product_sku_prices.id'), nullable=True))
    op.add_column('quotations', sa.Column('schema_version_v2', sa.Integer, nullable=True))
    op.create_index('idx_q_sku', 'quotations', ['sku_id'])

    # ── users 角色字段盘点 ──
    # users 表已有 role 字段 (system_admin/admin/owner/user) + plan 字段
    # 加 is_tenant_admin 用于 RBAC 三级角色
    op.add_column('users', sa.Column('is_tenant_admin', sa.Boolean, nullable=False, server_default='false'))

    # ── View: v_quote_records ──
    op.execute("""
        CREATE OR REPLACE VIEW v_quote_records AS
        SELECT
            s.id                AS sku_id,
            s.tenant_id,
            s.category_id,
            c.code              AS category_code,
            c.name              AS category_name,
            c.path              AS category_path,
            s.spec_values,
            s.spec_hash,
            s.schema_version,
            s.weight_kg,
            s.description,
            p.id                AS price_id,
            p.price,
            p.currency,
            p.price_unit,
            pu.label            AS price_unit_label,
            p.min_qty,
            p.tier_rules,
            p.effective_from,
            p.effective_to,
            p.status            AS price_status,
            p.created_at        AS quoted_at
        FROM product_skus s
        JOIN product_categories c ON c.id = s.category_id
        LEFT JOIN product_sku_prices p ON p.sku_id = s.id AND p.status = 'active'
        LEFT JOIN price_units pu ON pu.code = p.price_unit
        WHERE s.is_active = TRUE;
    """)

    # ══════════════════════════════════════════════════════════
    # SEED DATA (方案第七节)
    # ══════════════════════════════════════════════════════════

    # ── 单位族 ──
    op.execute("""
        INSERT INTO unit_groups (code, name, base_unit) VALUES
            ('length', '长度', 'mm'),
            ('area',   '面积', 'mm2'),
            ('weight', '重量', 'kg'),
            ('count',  '计数', 'pcs'),
            ('volume', '体积', 'm3');
    """)

    # ── 单位 ──
    op.execute("""
        INSERT INTO units (code, label, unit_group, to_base_factor, sort_order) VALUES
            ('mm', 'mm', 'length', 1,     1),
            ('cm', 'cm', 'length', 10,    2),
            ('m',  'm',  'length', 1000,  3),
            ('kg', 'kg', 'weight', 1,     1),
            ('g',  'g',  'weight', 0.001, 2),
            ('t',  '吨', 'weight', 1000,  3),
            ('pcs','件', 'count',  1,     1);
    """)

    # ── 计价单位 ──
    op.execute("""
        INSERT INTO price_units (code, label, currency, unit, unit_group, sort_order) VALUES
            ('cny_per_pcs',  '元/根',     'CNY', 'pcs', 'count',  1),
            ('cny_per_m',    '元/米',     'CNY', 'm',   'length', 2),
            ('cny_per_m2',   '元/平方米', 'CNY', 'm2',  'area',   3),
            ('cny_per_kg',   '元/千克',   'CNY', 'kg',  'weight', 4),
            ('cny_per_t',    '元/吨',     'CNY', 't',   'weight', 5),
            ('cny_per_roll', '元/卷',     'CNY', 'pcs', 'count',  6);
    """)

    # ── 品类树 ──
    op.execute("""
        WITH root AS (
            INSERT INTO product_categories (code, name, parent_id, path, level, industry_code, is_leaf)
            VALUES ('fence_root', '护栏', NULL, '/护栏', 1, 'fence', FALSE)
            RETURNING id
        )
        INSERT INTO product_categories (code, name, parent_id, path, level, industry_code, is_leaf)
        SELECT v.code, v.name, root.id, '/护栏/' || v.name, 2, 'fence', TRUE
        FROM root, (VALUES
            ('niulanwang', '牛栏网'),
            ('lizhu',      '立柱'),
            ('post',       'Post')
        ) AS v(code, name);
    """)

    # ── 公库属性 ──
    op.execute("""
        INSERT INTO spec_attributes (code, name, group_code, data_type, unit, unit_group, scope, source) VALUES
            ('edge_style',     '边型',       'variant', 'enum',   NULL,  NULL,     'public', 'seed'),
            ('surface_finish', '表面处理',   'variant', 'enum',   NULL,  NULL,     'public', 'seed'),
            ('color',          '颜色',       'variant', 'enum',   NULL,  NULL,     'public', 'seed'),
            ('product_form',   '产品形态',   'variant', 'enum',   NULL,  NULL,     'public', 'seed'),
            ('height',         '高度',       'spec',    'number', 'm',   'length', 'public', 'seed'),
            ('wall_thickness', '壁厚',       'spec',    'number', 'mm',  'length', 'public', 'seed'),
            ('cross_section',  '截面尺寸',   'spec',    'text',   'mm',  'length', 'public', 'seed'),
            ('wire_diameter',  '丝径',       'spec',    'number', 'mm',  'length', 'public', 'seed'),
            ('mesh_width',     '网宽',       'spec',    'number', 'cm',  'length', 'public', 'seed'),
            ('mesh_spec',      '网孔规格',   'spec',    'text',   NULL,  NULL,     'public', 'seed'),
            ('roll_length',    '卷长',       'spec',    'number', 'm',   'length', 'public', 'seed');
    """)

    # ── 枚举值 ──
    op.execute("""
        INSERT INTO spec_attribute_values (attribute_id, value_code, value_label, sort_order, scope)
        SELECT a.id, v.code, v.label, v.ord, 'public'
        FROM (VALUES
            ('edge_style', 'zhbian',   '直边',   1),
            ('edge_style', 'huabian',  '花边',   2),
            ('edge_style', 'bolangbian','波浪边', 3)
        ) AS v(attr_code, code, label, ord)
        JOIN spec_attributes a ON a.code = v.attr_code AND a.scope = 'public';
    """)
    op.execute("""
        INSERT INTO spec_attribute_values (attribute_id, value_code, value_label, sort_order, scope)
        SELECT a.id, v.code, v.label, v.ord, 'public'
        FROM (VALUES
            ('surface_finish', 'kaoqi',  '烤漆', 1),
            ('surface_finish', 'duxin',  '镀锌', 2),
            ('surface_finish', 'pentu',  '喷塑', 3)
        ) AS v(attr_code, code, label, ord)
        JOIN spec_attributes a ON a.code = v.attr_code AND a.scope = 'public';
    """)
    op.execute("""
        INSERT INTO spec_attribute_values (attribute_id, value_code, value_label, sort_order, scope)
        SELECT a.id, v.code, v.label, v.ord, 'public'
        FROM (VALUES
            ('color', 'heise', '黑色', 1),
            ('color', 'baise', '白色', 2),
            ('color', 'lvse',  '绿色', 3),
            ('color', 'huise', '灰色', 4)
        ) AS v(attr_code, code, label, ord)
        JOIN spec_attributes a ON a.code = v.attr_code AND a.scope = 'public';
    """)
    op.execute("""
        INSERT INTO spec_attribute_values (attribute_id, value_code, value_label, sort_order, scope)
        SELECT a.id, v.code, v.label, v.ord, 'public'
        FROM (VALUES
            ('product_form', 'shangshuxiami', '上疏下密', 1),
            ('product_form', 'huankou',       '环扣',     2)
        ) AS v(attr_code, code, label, ord)
        JOIN spec_attributes a ON a.code = v.attr_code AND a.scope = 'public';
    """)

    # ── 类目挂载：立柱 ──
    op.execute("""
        INSERT INTO category_attribute_bindings
            (category_id, attribute_id, group_code, attr_role, is_required, is_locked, sort_order, scope)
        SELECT (SELECT id FROM product_categories WHERE code='lizhu'),
               a.id, a.group_code, b.role, b.required, b.locked, b.ord, 'public'
        FROM (VALUES
            ('edge_style',     'sku',         TRUE,  TRUE,  1),
            ('surface_finish', 'sku',         TRUE,  TRUE,  2),
            ('color',          'descriptive', FALSE, FALSE, 3),
            ('height',         'sku',         TRUE,  TRUE,  4),
            ('wall_thickness', 'sku',         TRUE,  TRUE,  5),
            ('cross_section',  'descriptive', FALSE, FALSE, 6)
        ) AS b(code, role, required, locked, ord)
        JOIN spec_attributes a ON a.code = b.code AND a.scope = 'public';
    """)

    # ── 类目挂载：牛栏网 ──
    op.execute("""
        INSERT INTO category_attribute_bindings
            (category_id, attribute_id, group_code, attr_role, is_required, is_locked, sort_order, scope)
        SELECT (SELECT id FROM product_categories WHERE code='niulanwang'),
               a.id, a.group_code, b.role, b.required, b.locked, b.ord, 'public'
        FROM (VALUES
            ('product_form',  'sku',         TRUE,  TRUE,  1),
            ('wire_diameter', 'sku',         TRUE,  TRUE,  2),
            ('height',        'sku',         TRUE,  TRUE,  3),
            ('mesh_width',    'sku',         FALSE, FALSE, 4),
            ('mesh_spec',     'descriptive', FALSE, FALSE, 5),
            ('roll_length',   'sku',         FALSE, FALSE, 6)
        ) AS b(code, role, required, locked, ord)
        JOIN spec_attributes a ON a.code = b.code AND a.scope = 'public';
    """)

    # ── 类目挂载：Post ──
    op.execute("""
        INSERT INTO category_attribute_bindings
            (category_id, attribute_id, group_code, attr_role, is_required, is_locked, sort_order, scope)
        SELECT (SELECT id FROM product_categories WHERE code='post'),
               a.id, a.group_code, b.role, b.required, b.locked, b.ord, 'public'
        FROM (VALUES
            ('edge_style',     'sku', TRUE, TRUE, 1),
            ('surface_finish', 'sku', TRUE, TRUE, 2),
            ('height',         'sku', TRUE, TRUE, 3),
            ('wall_thickness', 'sku', TRUE, TRUE, 4)
        ) AS b(code, role, required, locked, ord)
        JOIN spec_attributes a ON a.code = b.code AND a.scope = 'public';
    """)

    # ── 官方模板（立柱）──
    op.execute("""
        INSERT INTO industry_templates (code, name, industry_code, template_type, snapshot) VALUES
        ('lizhu_official_v1', '立柱-标准模板', 'fence', 'official',
         '{"categories":[{"category_code":"lizhu","attributes":[{"code":"edge_style","group":"variant","role":"sku","required":true,"locked":true,"sort":1},{"code":"surface_finish","group":"variant","role":"sku","required":true,"locked":true,"sort":2},{"code":"height","group":"spec","role":"sku","required":true,"locked":true,"sort":3},{"code":"wall_thickness","group":"spec","role":"sku","required":true,"locked":true,"sort":4}]}]}'::jsonb);
    """)


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS v_quote_records")
    op.drop_column('users', 'is_tenant_admin')
    op.drop_index('idx_q_sku', table_name='quotations')
    op.drop_column('quotations', 'schema_version_v2')
    op.drop_column('quotations', 'price_id')
    op.drop_column('quotations', 'sku_id')
    op.drop_table('attribute_proposals')
    op.drop_table('product_sku_revisions')
    op.drop_table('product_sku_prices')
    op.drop_table('product_skus')
    op.drop_table('industry_templates')
    op.drop_table('category_attribute_bindings')
    op.drop_table('spec_attribute_values')
    op.drop_table('spec_attributes')
    op.drop_table('price_units')
    op.drop_table('units')
    op.drop_table('unit_groups')
    op.drop_table('product_categories')
