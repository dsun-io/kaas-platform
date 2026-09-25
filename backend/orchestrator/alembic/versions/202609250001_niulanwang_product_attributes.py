"""牛栏网产品属性与计算逻辑

Revision ID: 202609250001
Revises: 202609230006
Create Date: 2026-09-25

把牛栏网（`niulanwang`）实际报价用到的**属性**与**计算逻辑**登记进规格体系。

背景
----
规格体系 v1 只给牛栏网挂了 6 个属性（产品形态／丝径／高度／网宽／网孔规格／卷长），
装不下实际产品。用牛栏网出口报价表核对过的规格空间是 5 个 SKU 轴：

    丝径方案 × 网高 × 竖丝间距 × 镀锌量 × 工艺
       3     ×  2   ×    2      ×   2   ×  2   = 48 个组合

本迁移补齐缺失属性、派生量与计算逻辑，并写入官方模板。

与平台既有数据的对齐（已在真实库上逐项核对）
--------------------------------------------
1. **体积单位是 `cbm` 而不是 `m3`** —— 平台 `units` 用 `cbm` 表示体积，本迁移沿用。
2. **`units` 缺 `cm` / `mm`** —— 真实库长度只有 `m`。竖丝间距、卷径要用 cm，
   三个丝径要用 mm，故补齐。
3. **`price_units` 是空的** —— 出口报价要用「元/米」「元/卷」「USD/卷」，故补齐。
4. **`product_categories` 是空的** —— 「护栏 → 牛栏网」这条路径还没建，故按需创建。
5. **派生量要有单位** —— 用 cm/mm 的属性必须能在 units 里找到单位，
   否则前端渲染会缺标签。

幂等说明
--------
真实库里这些表由 `create_all` 建出，**没有 CHECK 约束、也没有 UNIQUE 约束**
（已在 pg_constraint 上核对），因此不能靠唯一索引去重。
本迁移统一用 `WHERE NOT EXISTS` 守卫，可重复执行。

建模原则（踩过坑，故写在这里）
------------------------------
· **只有真正会变的量才做 SKU 轴**：网孔分布按品种固定为「拧编型上疏下密」，
  若当作变体轴会虚增成 3×3×2×2×2×2 = 144 个组合。
· **由其它轴决定的量不要做轴**：卷长由丝径方案决定（全丝2.5 → 50m/卷），
  若留作 SKU 轴会产生「全丝2.5 + 100m/卷」这类不存在的组合。
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "202609250001"
down_revision: Union[str, None] = "202609230006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

ROOT_CODE = "fence_root"
ROOT_NAME = "护栏"
CAT_CODE = "niulanwang"
CAT_NAME = "牛栏网"
TEMPLATE_CODE = "niulanwang_official_v1"

# 平台原有的单位（真实库已核对）。downgrade 时只删本迁移新增的那些，
# 不碰这些既有单位，避免影响其它产品的属性。
_PLATFORM_UNITS = {
    "sqm", "pcs", "roll", "bundle", "pallet", "bag", "m", "cbm", "kg", "ton",
}

# ── 单位族（平台已有；此处仅兜底）──
_UNIT_GROUPS = [
    ("length", "长度", "m"),
    ("area", "面积", "sqm"),
    ("weight", "重量", "kg"),
    ("count", "数量", "pcs"),
    ("volume", "体积", "cbm"),
]

# ── 单位：补真实库缺的；体积沿用平台的 cbm ──
# (code, label, unit_group, to_base_factor, sort_order)
_UNITS = [
    ("mm", "mm", "length", "1", 1),
    ("cm", "cm", "length", "10", 2),
    ("m", "m", "length", "1000", 3),
    ("kg", "kg", "weight", "1", 1),
    ("cbm", "m³", "volume", "1", 1),
    ("pcs", "件", "count", "1", 1),
]

# ── 计价单位：真实库为空，补齐出口报价要用的 ──
# (code, label, currency, unit, unit_group, sort_order)
_PRICE_UNITS = [
    ("cny_per_m", "元/米", "CNY", "m", "length", 1),
    ("cny_per_kg", "元/千克", "CNY", "kg", "weight", 2),
    ("cny_per_roll", "元/卷", "CNY", "pcs", "count", 3),
    ("cny_per_sqm", "元/平方米", "CNY", "sqm", "area", 4),
    ("usd_per_roll", "USD/卷", "USD", "pcs", "count", 5),
]

# ── 平台公库基础属性（规格体系 v1 的公共词汇）──
# 真实库由 create_all 建表，**这些种子数据从未写入**，但牛栏网的绑定要引用其中 7 个
# （height / product_form / surface_finish / wire_diameter / mesh_width /
#   mesh_spec / roll_length）。缺了它们，绑定会被 NOT EXISTS 守卫静默跳过，
# 结果是 SKU 轴少一个、枚举值缺两个 —— 已在真实库上实测到这个现象。
# 故本迁移把它们补齐，定义与 202605170001 的种子保持一致。
# (code, name, group_code, data_type, unit, unit_group)
_BASE_ATTRIBUTES = [
    ("edge_style", "边型", "variant", "enum", None, None),
    ("surface_finish", "表面处理", "variant", "enum", None, None),
    ("color", "颜色", "variant", "enum", None, None),
    ("product_form", "产品形态", "variant", "enum", None, None),
    ("height", "高度", "spec", "number", "m", "length"),
    ("wall_thickness", "壁厚", "spec", "number", "mm", "length"),
    ("cross_section", "截面尺寸", "spec", "text", "mm", "length"),
    ("wire_diameter", "丝径", "spec", "number", "mm", "length"),
    ("mesh_width", "网宽", "spec", "number", "cm", "length"),
    ("mesh_spec", "网孔规格", "spec", "text", None, None),
    ("roll_length", "卷长", "spec", "number", "m", "length"),
]

# 上述基础属性的枚举值（与 202605170001 的种子一致）
# (attribute_code, value_code, value_label, value_number, sort_order)
_BASE_VALUES = [
    ("edge_style", "zhbian", "直边", None, 1),
    ("edge_style", "huabian", "花边", None, 2),
    ("edge_style", "bolangbian", "波浪边", None, 3),
    ("surface_finish", "kaoqi", "烤漆", None, 1),
    ("surface_finish", "duxin", "镀锌", None, 2),
    ("surface_finish", "pentu", "喷塑", None, 3),
    ("color", "heise", "黑色", None, 1),
    ("color", "baise", "白色", None, 2),
    ("color", "lvse", "绿色", None, 3),
    ("color", "huise", "灰色", None, 4),
    ("product_form", "shangshuxiami", "上疏下密", None, 1),
    ("product_form", "huankou", "环扣", None, 2),
]

# ── 新增属性（输入类）──
# (code, name, group_code, data_type, unit, unit_group, min, max, step, description)
_NEW_ATTRIBUTES = [
    ("wire_option", "丝径方案", "variant", "enum", None, None, None, None, None,
     "牛栏网丝径组合方案；三个方向丝径由本项决定"),
    ("wave_type", "工艺", "variant", "enum", None, None, None, None, None,
     "波弯款在无波款基础上每 100 米增重 3kg"),
    ("zinc_coating", "镀锌量", "variant", "enum", None, None, None, None, None,
     "value_number 记录名义镀锌量 g/㎡：普锌 40、重镀锌 200"),
    ("packing", "包装", "variant", "enum", None, None, None, None, None,
     "牛栏网默认无包装"),

    ("vertical_wire_spacing", "竖丝间距", "spec", "number", "cm", "length",
     "5", "30", "5", "网孔竖丝间距；横向间距上疏下密，不参与重量与计价"),
    ("horizontal_wire_count", "横丝数", "spec", "number", "pcs", "count",
     "2", "30", "1", "横丝（径丝）根数，即重量公式中的 n"),

    ("edge_wire_diameter", "边丝径", "spec", "number", "mm", "length",
     "1.0", "5.0", "0.1", "两侧边丝直径，重量公式中的 d边"),
    ("inner_wire_diameter", "内横丝径", "spec", "number", "mm", "length",
     "1.0", "5.0", "0.1", "内横丝直径，重量公式中的 d横"),
    ("vertical_wire_diameter", "竖丝径", "spec", "number", "mm", "length",
     "1.0", "5.0", "0.1", "纬丝（竖丝）直径，重量公式中的 d竖"),
    ("roll_diameter", "卷径", "spec", "number", "cm", "length",
     "10", "80", "0.5",
     "默认值随丝径方案联动：100 米卷 30cm、50 米卷 25cm；可按实际装箱覆盖重设"),
]

# ── 派生量属性：系统算出来的结果量，只读 ──
# 登记它们有两个用处：
#   1. 产品属性表上能直接看到「单卷净重是多少、怎么来的」
#   2. 属性集与计算规格（export_quote 的 FormulaSpec）一一对齐，两边不走散
# (code, name, group_code, unit, unit_group, description)
_DERIVED_ATTRIBUTES = [
    ("weight_base_kg", "单卷基础净重", "spec", "kg", "weight",
     "公式：0.00617 × L × [2·d边² + (n−2)·d横² + d竖² × (w + (n−1)×50) / s]，"
     "L=卷长(m)、n=横丝根数、w=网高(mm)、s=竖丝间距(mm)。尚未加波弯增重。"),
    ("edge_weight_kg", "单卷边丝重", "spec", "kg", "weight",
     "公式：0.01234 × L × d边²（两侧边丝合计，系数是 0.00617 的两倍）。"),
    ("wave_add_kg", "波弯增重", "spec", "kg", "weight",
     "公式：wave_factor × 3 × 卷长 ÷ 100。波弯款按每 100 米增重 3kg 折算，"
     "故 100 米卷 +3kg、50 米卷只 +1.5kg；无波款为 0。"),
    ("weight_per_piece_kg", "单卷净重", "spec", "kg", "weight",
     "公式：单卷基础净重 + 波弯增重。按 4 位小数落定，下游总重由落定值乘卷数，"
     "以保证表上「单卷重 × 卷数 = 总重」能对上。"),
    ("volume_per_piece_m3", "单卷净体积", "spec", "cbm", "volume",
     "公式：π/4 × 卷径² × 网高（按**实际圆柱体**计，即 π × (卷径/2)² × 网高）。"
     "这是钢材本身占用的体积。"),
    ("volume_box_per_piece_m3", "单卷长方体体积", "spec", "cbm", "volume",
     "公式：卷径² × 网高（按**外接方柱**计）。堆码与报运价用这个口径，"
     "比圆柱体大约 27 个百分点。"),
    ("roll_count", "卷数", "spec", "pcs", "count",
     "公式：订单总长度 ÷ 每卷长度。全丝2.5 每卷 50 米、其余每卷 100 米。"),
    ("total_net_weight_kg", "订单总净重", "spec", "kg", "weight",
     "公式：单卷净重 × 卷数。"),
    ("volume_box_m3", "长方体总体积", "spec", "cbm", "volume",
     "公式：单卷长方体体积 × 卷数。全部卷按方柱直接累加，**尚未扣减**空间。"),
    ("volume_effective_m3", "实际占用体积", "spec", "cbm", "volume",
     "公式：长方体总体积 − 空间扣减（本项目取中位数 2.5 m³，每单只扣一次，"
     "不随卷数放大）。对外报运价/报关用这个口径。"),
    ("price_per_piece", "单卷售价", "pricing", "元/卷", None,
     "公式：单价(元/kg) × 单卷净重；启用贸易术语时取主术语（含税）单件价。"),
    ("price_per_meter", "单价", "pricing", "元/米", None,
     "公式：单卷售价 ÷ 卷长。与单卷价同源，故「每米价 × 总米数」与"
     "「单卷价 × 卷数」必然相等。"),
    ("price_per_piece_fx", "单卷美元售价", "pricing", "USD/卷", None,
     "公式：人民币单卷价 ÷ 汇率。用已展示的人民币价折算，保证客户复算一致。"),
]

# ── 新增枚举值 ──
# (attribute_code, value_code, value_label, value_number, sort_order)
_NEW_VALUES = [
    ("wire_option", "all_wire_20", "全丝2.0", None, 1),
    ("wire_option", "all_wire_25", "全丝2.5", None, 2),
    ("wire_option", "edge25_inner20", "边丝2.5+内丝2.0", None, 3),

    ("wave_type", "no_wave", "无波款", None, 1),
    ("wave_type", "wave_bend", "波弯款", None, 2),

    ("zinc_coating", "zinc_40", "普锌40g/㎡", "40", 1),
    ("zinc_coating", "zinc_200", "重镀锌≥200g/㎡", "200", 2),

    ("packing", "no_packing", "无包装", None, 1),
    ("packing", "woven_bag", "编织袋", None, 2),

    # 补到既有属性上
    ("surface_finish", "hot_dip_galv", "热镀锌", None, 4),
    ("product_form", "ningbian_shangshuxiami", "拧编型上疏下密", None, 3),
]

# ── 牛栏网绑定（按展示顺序）──
# (code, role, required, locked, default_value_json, sort)
# SKU 轴恰好 5 个 → 3×2×2×2×2 = 48 个组合。
_BINDINGS = [
    ("wire_option", "sku", True, True, None, 1),
    ("height", "sku", True, True, None, 2),
    ("vertical_wire_spacing", "sku", True, True, None, 3),
    ("zinc_coating", "sku", True, True, None, 4),
    ("wave_type", "sku", True, True, None, 5),

    # 描述性：记录但不参与 SKU 编码
    ("product_form", "descriptive", False, True, '"ningbian_shangshuxiami"', 6),
    ("surface_finish", "descriptive", False, False, '"hot_dip_galv"', 7),
    ("packing", "descriptive", False, False, '"no_packing"', 8),
    ("horizontal_wire_count", "descriptive", False, False, "10", 9),
    ("edge_wire_diameter", "descriptive", False, False, None, 10),
    ("inner_wire_diameter", "descriptive", False, False, None, 11),
    ("vertical_wire_diameter", "descriptive", False, False, None, 12),
    ("roll_length", "descriptive", False, False, None, 13),
    ("roll_diameter", "descriptive", False, False, None, 14),
    ("mesh_spec", "descriptive", False, False, None, 15),
    ("wire_diameter", "descriptive", False, False, None, 16),
    ("mesh_width", "descriptive", False, False, None, 17),
]

# 迁移前就已存在的牛栏网绑定及其原始形状；downgrade 按此还原
_PREEXISTING = {
    "product_form": ("sku", True, True, 1),
    "wire_diameter": ("sku", True, True, 2),
    "height": ("sku", True, True, 3),
    "mesh_width": ("sku", False, False, 4),
    "mesh_spec": ("descriptive", False, False, 5),
    "roll_length": ("sku", False, False, 6),
}

_DERIVED_START_SORT = 100


def _lit(v) -> str:
    if v is None:
        return "NULL"
    return "'%s'" % str(v).replace("'", "''")


# ═══════════════════════════════════════════════════════════════════════════
# 基础数据兜底
# ═══════════════════════════════════════════════════════════════════════════
def _ensure_unit_groups() -> None:
    rows = ", ".join("(%s, %s, %s)" % (_lit(a), _lit(b), _lit(c))
                     for a, b, c in _UNIT_GROUPS)
    op.execute(
        """
        INSERT INTO unit_groups (code, name, base_unit)
        SELECT v.code, v.name, v.base_unit
        FROM (VALUES %s) AS v(code, name, base_unit)
        WHERE NOT EXISTS (SELECT 1 FROM unit_groups g WHERE g.code = v.code)
        """ % rows
    )


def _ensure_units() -> None:
    rows = ", ".join(
        "(%s, %s, %s, %s, %d)" % (_lit(c), _lit(lb), _lit(ug), _lit(f), so)
        for c, lb, ug, f, so in _UNITS
    )
    op.execute(
        """
        INSERT INTO units (code, label, unit_group, to_base_factor, sort_order)
        SELECT v.code, v.label, v.unit_group, v.factor::numeric,
               v.sort_order::int
        FROM (VALUES %s) AS v(code, label, unit_group, factor, sort_order)
        WHERE NOT EXISTS (SELECT 1 FROM units u WHERE u.code = v.code)
        """ % rows
    )


def _ensure_price_units() -> None:
    rows = ", ".join(
        "(%s, %s, %s, %s, %s, %d)"
        % (_lit(c), _lit(lb), _lit(cur), _lit(un), _lit(ug), so)
        for c, lb, cur, un, ug, so in _PRICE_UNITS
    )
    op.execute(
        """
        INSERT INTO price_units
            (code, label, currency, unit, unit_group, sort_order)
        SELECT v.code, v.label, v.currency, v.unit, v.unit_group,
               v.sort_order::int
        FROM (VALUES %s)
             AS v(code, label, currency, unit, unit_group, sort_order)
        WHERE NOT EXISTS (SELECT 1 FROM price_units p WHERE p.code = v.code)
        """ % rows
    )


def _ensure_categories() -> None:
    """确保「护栏 → 牛栏网」这条品类路径存在。"""
    op.execute(
        """
        INSERT INTO product_categories
            (code, name, parent_id, path, level, industry_code,
             sort_order, is_leaf, is_active)
        SELECT {c}, {n}, NULL, '/' || {n}, 1, 'fence', 1, FALSE, TRUE
        WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE code = {c})
        """.format(c=_lit(ROOT_CODE), n=_lit(ROOT_NAME))
    )
    op.execute(
        """
        INSERT INTO product_categories
            (code, name, parent_id, path, level, industry_code,
             sort_order, is_leaf, is_active)
        SELECT {c}, {n},
               (SELECT id FROM product_categories WHERE code = {rc}),
               '/' || {rn} || '/' || {n}, 2, 'fence', 1, TRUE, TRUE
        WHERE NOT EXISTS (SELECT 1 FROM product_categories WHERE code = {c})
        """.format(c=_lit(CAT_CODE), n=_lit(CAT_NAME),
                   rc=_lit(ROOT_CODE), rn=_lit(ROOT_NAME))
    )


# ═══════════════════════════════════════════════════════════════════════════
# 属性、取值、绑定
# ═══════════════════════════════════════════════════════════════════════════
def _ensure_base_attributes() -> None:
    """补齐平台公库基础属性 —— 真实库缺这批种子，而牛栏网绑定要引用它们。"""
    rows = ",\n            ".join(
        "(%s)" % ", ".join(_lit(v) for v in row) for row in _BASE_ATTRIBUTES
    )
    op.execute(
        """
        INSERT INTO spec_attributes
            (code, name, aliases, group_code, data_type, unit, unit_group,
             description, scope, tenant_id, source, status)
        SELECT v.code, v.name, '[]'::jsonb, v.group_code, v.data_type,
               v.unit, v.unit_group, NULL,
               'public', NULL, 'seed', 'active'
        FROM (VALUES
            %s
        ) AS v(code, name, group_code, data_type, unit, unit_group)
        WHERE NOT EXISTS (
            SELECT 1 FROM spec_attributes a
            WHERE a.code = v.code AND a.scope = 'public' AND a.tenant_id IS NULL
        )
        """ % rows
    )


def _ensure_base_values() -> None:
    rows = ",\n            ".join(
        "(%s)" % ", ".join(_lit(v) for v in row) for row in _BASE_VALUES
    )
    op.execute(
        """
        INSERT INTO spec_attribute_values
            (attribute_id, value_code, value_label, value_number,
             sort_order, scope, tenant_id, status)
        SELECT a.id, v.value_code, v.value_label, v.value_number::numeric,
               v.sort_order::int, 'public', NULL, 'active'
        FROM (VALUES
            %s
        ) AS v(attr_code, value_code, value_label, value_number, sort_order)
        JOIN spec_attributes a
          ON a.code = v.attr_code AND a.scope = 'public' AND a.tenant_id IS NULL
        WHERE NOT EXISTS (
            SELECT 1 FROM spec_attribute_values x
            WHERE x.attribute_id = a.id AND x.value_code = v.value_code
              AND x.scope = 'public' AND x.tenant_id IS NULL
        )
        """ % rows
    )


def _insert_attributes() -> None:
    rows = ",\n            ".join(
        "(%s)" % ", ".join(_lit(v) for v in row) for row in _NEW_ATTRIBUTES
    )
    op.execute(
        """
        INSERT INTO spec_attributes
            (code, name, aliases, group_code, data_type, unit, unit_group,
             number_min, number_max, number_step, description,
             scope, tenant_id, source, status)
        SELECT v.code, v.name, '[]'::jsonb, v.group_code, v.data_type,
               v.unit, v.unit_group,
               v.number_min::numeric, v.number_max::numeric,
               v.number_step::numeric, v.description,
               'public', NULL, 'seed', 'active'
        FROM (VALUES
            %s
        ) AS v(code, name, group_code, data_type, unit, unit_group,
               number_min, number_max, number_step, description)
        WHERE NOT EXISTS (
            SELECT 1 FROM spec_attributes a
            WHERE a.code = v.code AND a.scope = 'public' AND a.tenant_id IS NULL
        )
        """ % rows
    )


def _insert_derived_attributes() -> None:
    rows = ",\n            ".join(
        "(%s)" % ", ".join(_lit(v) for v in row) for row in _DERIVED_ATTRIBUTES
    )
    op.execute(
        """
        INSERT INTO spec_attributes
            (code, name, aliases, group_code, data_type, unit, unit_group,
             description, scope, tenant_id, source, status)
        SELECT v.code, v.name, '[]'::jsonb, v.group_code, 'number',
               v.unit, v.unit_group, v.description,
               'public', NULL, 'derived', 'active'
        FROM (VALUES
            %s
        ) AS v(code, name, group_code, unit, unit_group, description)
        WHERE NOT EXISTS (
            SELECT 1 FROM spec_attributes a
            WHERE a.code = v.code AND a.scope = 'public' AND a.tenant_id IS NULL
        )
        """ % rows
    )


def _insert_values() -> None:
    rows = ",\n            ".join(
        "(%s)" % ", ".join(_lit(v) for v in row) for row in _NEW_VALUES
    )
    op.execute(
        """
        INSERT INTO spec_attribute_values
            (attribute_id, value_code, value_label, value_number,
             sort_order, scope, tenant_id, status)
        SELECT a.id, v.value_code, v.value_label, v.value_number::numeric,
               v.sort_order::int, 'public', NULL, 'active'
        FROM (VALUES
            %s
        ) AS v(attr_code, value_code, value_label, value_number, sort_order)
        JOIN spec_attributes a
          ON a.code = v.attr_code AND a.scope = 'public' AND a.tenant_id IS NULL
        WHERE NOT EXISTS (
            SELECT 1 FROM spec_attribute_values x
            WHERE x.attribute_id = a.id AND x.value_code = v.value_code
              AND x.scope = 'public' AND x.tenant_id IS NULL
        )
        """ % rows
    )


def _bind(cat: str, code: str, role: str, required: bool, locked: bool,
          default_json, sort: int) -> None:
    default_sql = (
        "CAST(%s AS jsonb)" % _lit(default_json)
        if default_json is not None else "NULL"
    )
    op.execute(
        """
        INSERT INTO category_attribute_bindings
            (category_id, attribute_id, group_code, attr_role,
             is_required, is_locked, sort_order, default_value,
             scope, tenant_id, schema_version)
        SELECT {cat}, a.id, a.group_code, {role},
               {req}, {lock}, {sort}, {dflt},
               'public', NULL, 1
        FROM spec_attributes a
        WHERE a.code = {code} AND a.scope = 'public' AND a.tenant_id IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM category_attribute_bindings b
              WHERE b.category_id = {cat} AND b.attribute_id = a.id
                AND b.scope = 'public' AND b.tenant_id IS NULL
          )
        """.format(cat=cat, code=_lit(code), role=_lit(role),
                   req="TRUE" if required else "FALSE",
                   lock="TRUE" if locked else "FALSE",
                   sort=sort, dflt=default_sql)
    )
    op.execute(
        """
        UPDATE category_attribute_bindings
        SET attr_role = {role}, is_required = {req}, is_locked = {lock},
            sort_order = {sort}, default_value = {dflt}, updated_at = now()
        WHERE category_id = {cat}
          AND attribute_id = (SELECT id FROM spec_attributes
                              WHERE code = {code} AND scope = 'public'
                                AND tenant_id IS NULL)
          AND scope = 'public' AND tenant_id IS NULL
        """.format(cat=cat, code=_lit(code), role=_lit(role),
                   req="TRUE" if required else "FALSE",
                   lock="TRUE" if locked else "FALSE",
                   sort=sort, dflt=default_sql)
    )


def _replace_bindings() -> None:
    cat = "(SELECT id FROM product_categories WHERE code = %s)" % _lit(CAT_CODE)
    for code, role, required, locked, default_json, sort in _BINDINGS:
        _bind(cat, code, role, required, locked, default_json, sort)
    # 派生量：descriptive + 锁定（系统算，不可手改）
    for i, row in enumerate(_DERIVED_ATTRIBUTES):
        _bind(cat, row[0], "descriptive", False, True, None,
              _DERIVED_START_SORT + i)


# ═══════════════════════════════════════════════════════════════════════════
# 官方模板
# ═══════════════════════════════════════════════════════════════════════════
def _template_snapshot() -> dict:
    variant_codes = {
        "product_form", "wire_option", "zinc_coating", "wave_type",
        "packing", "surface_finish",
    }
    return {
        "categories": [{
            "category_code": CAT_CODE,
            "attributes": [
                {
                    "code": code,
                    "group": "variant" if code in variant_codes else "spec",
                    "role": role, "required": required, "locked": locked,
                    "sort": sort,
                }
                for code, role, required, locked, _dv, sort in _BINDINGS
            ],
            "derived_attributes": [
                {
                    "code": code, "group": group_code, "role": "descriptive",
                    "required": False, "locked": True, "unit": unit,
                    "sort": _DERIVED_START_SORT + i, "note": description,
                }
                for i, (code, _n, group_code, unit, _ug, description)
                in enumerate(_DERIVED_ATTRIBUTES)
            ],
        }],
        "calculation": {
            "engine": "export_quote",
            "product_key": "field_fence",
            "combo_count": 48,
            "spec_space": "丝径方案 × 网高 × 竖丝间距 × 镀锌量 × 工艺 "
                          "= 3 × 2 × 2 × 2 × 2 = 48",
            "volume_model": {
                "per_roll_cylinder": {
                    "formula": "pi / 4 * 卷径² * 网高",
                    "note": "单卷净体积按**实际圆柱体**计算。",
                },
                "per_roll_box": {
                    "formula": "卷径² * 网高",
                    "note": "单卷长方体体积按**外接方柱**计算，用于堆码与报运价。",
                },
                "order_total": "单卷长方体体积 * 卷数",
                "deduction": {
                    "mode": "median", "range": [2, 3], "value": 2.5,
                    "applies": "per_order",
                    "note": "实际占用体积 = 长方体总体积 − 2~3 m³"
                            "（取中位数 2.5 m³），每单只扣一次，不随卷数放大。",
                },
            },
            "defaults": {
                "roll_diameter_cm": {
                    "100m_roll": 30, "50m_roll": 25,
                    "note": "随丝径方案联动的默认值；可按实际装箱覆盖重设",
                },
                "horizontal_wire_count": 10,
                "wave_add_per_100m_kg": 3,
                "space_deduction_m3": 2.5,
            },
            "key_formulas": {
                "weight_base_kg": "0.00617 * L * [2·d边² + (n−2)·d横² "
                                  "+ d竖² * (w + (n−1)*50) / s]",
                "edge_weight_kg": "0.01234 * L * d边²",
                "wave_add_kg": "wave_factor * 3 * L / 100",
                "weight_per_piece_kg": "weight_base_kg + wave_add_kg",
                "volume_per_piece_m3": "pi / 4 * 卷径² * 网高",
                "volume_box_per_piece_m3": "卷径² * 网高",
                "volume_box_m3": "volume_box_per_piece_m3 * 卷数",
                "volume_effective_m3": "volume_box_m3 - space_deduction",
            },
            "note": "完整公式与口径见 "
                    "GET /api/v1/export-quote/products/field_fence/formulas；"
                    "可带规格取值调 POST /products/field_fence/explain 逐步自证。",
        },
        "notes": [
            "牛栏网标准规格空间：丝径方案 × 网高 × 竖丝间距 × 镀锌量 × 工艺 "
            "= 3×2×2×2×2 = 48 个组合。",
            "网孔分布按品种固定为「拧编型上疏下密」，故为 descriptive；"
            "若当作变体轴会虚增成 144 个组合。",
            "卷长／卷径／三个丝径由丝径方案决定，故为 descriptive，"
            "不参与 SKU 编码；若把卷长留作 SKU 轴，会产生"
            "「全丝2.5 + 100m/卷」这类不存在的组合。",
            "derived_attributes 是系统算出来的量（source='derived'），只读不可手改。",
        ],
    }


def _upsert_template() -> None:
    import json

    conn = op.get_bind()
    conn.execute(
        sa.text(
            "INSERT INTO industry_templates "
            "(code, name, description, industry_code, template_type, tenant_id, "
            " snapshot, snapshot_version, usage_count, is_active) "
            "VALUES (:code, :name, :desc, 'fence', 'official', NULL, "
            " CAST(:snap AS jsonb), 1, 0, TRUE) "
            "ON CONFLICT DO NOTHING"
        ),
        {
            "code": TEMPLATE_CODE,
            "name": "牛栏网-标准模板",
            "desc": "牛栏网出口报价用标准属性集与计算逻辑（48 组合规格空间）",
            "snap": json.dumps(_template_snapshot(), ensure_ascii=False),
        },
    )


# ═══════════════════════════════════════════════════════════════════════════
def upgrade() -> None:
    _ensure_unit_groups()
    _ensure_units()
    _ensure_price_units()
    _ensure_categories()
    _ensure_base_attributes()
    _ensure_base_values()
    _insert_attributes()
    _insert_derived_attributes()
    _insert_values()
    _replace_bindings()
    _upsert_template()


def downgrade() -> None:
    cat = "(SELECT id FROM product_categories WHERE code = %s)" % _lit(CAT_CODE)

    # 1) 派生量：先解绑再删属性
    op.execute("""
        DELETE FROM category_attribute_bindings
        WHERE category_id = {cat} AND scope = 'public' AND tenant_id IS NULL
          AND attribute_id IN (
              SELECT id FROM spec_attributes
              WHERE scope = 'public' AND tenant_id IS NULL AND source = 'derived'
          )""".format(cat=cat))
    op.execute("""
        DELETE FROM spec_attributes
        WHERE scope = 'public' AND tenant_id IS NULL AND source = 'derived'
          AND code IN ({codes})""".format(
        codes=", ".join(_lit(r[0]) for r in _DERIVED_ATTRIBUTES)))

    # 2) 本迁移新增的绑定
    added = [b[0] for b in _BINDINGS if b[0] not in _PREEXISTING]
    op.execute("""
        DELETE FROM category_attribute_bindings
        WHERE category_id = {cat} AND scope = 'public' AND tenant_id IS NULL
          AND attribute_id IN (
              SELECT id FROM spec_attributes
              WHERE scope = 'public' AND tenant_id IS NULL
                AND code IN ({codes})
          )""".format(cat=cat, codes=", ".join(_lit(c) for c in added)))

    # 3) 被改了形状的既有绑定，还原为迁移前的样子
    for code, (role, required, locked, sort) in _PREEXISTING.items():
        op.execute("""
            UPDATE category_attribute_bindings
            SET attr_role = {role}, is_required = {req}, is_locked = {lock},
                sort_order = {sort}, default_value = NULL, updated_at = now()
            WHERE category_id = {cat} AND scope = 'public' AND tenant_id IS NULL
              AND attribute_id = (SELECT id FROM spec_attributes
                                  WHERE code = {code} AND scope = 'public'
                                    AND tenant_id IS NULL)""".format(
            cat=cat, code=_lit(code), role=_lit(role),
            req="TRUE" if required else "FALSE",
            lock="TRUE" if locked else "FALSE", sort=sort))

    # 4) 本迁移新增的枚举值
    op.execute("""
        DELETE FROM spec_attribute_values
        WHERE scope = 'public' AND tenant_id IS NULL
          AND value_code IN ({codes})""".format(
        codes=", ".join(_lit(v[1]) for v in _NEW_VALUES)))

    # 5) 本迁移新增的属性
    op.execute("""
        DELETE FROM spec_attributes
        WHERE scope = 'public' AND tenant_id IS NULL
          AND code IN ({codes})""".format(
        codes=", ".join(_lit(a[0]) for a in _NEW_ATTRIBUTES)))

    # 6) 模板
    op.execute("DELETE FROM industry_templates WHERE code = %s"
               % _lit(TEMPLATE_CODE))

    # 7) 本迁移新增的单位与计价单位（不碰平台既有的那批）
    new_units = [c for c, *_ in _UNITS if c not in _PLATFORM_UNITS]
    if new_units:
        op.execute("DELETE FROM units WHERE code IN (%s)"
                   % ", ".join(_lit(c) for c in new_units))
    op.execute("DELETE FROM price_units WHERE code IN (%s)"
               % ", ".join(_lit(c) for c, *_ in _PRICE_UNITS))

    # 8) 品类节点与平台公库基础属性保留不动。
    #    它们可能在基础种子里就已存在（迁移 202605170001 会建），
    #    删掉会连带 CASCADE 掉别人挂在它下面的绑定；
    #    留一个空类目与通用词汇是无害的，所以这里刻意不删。
