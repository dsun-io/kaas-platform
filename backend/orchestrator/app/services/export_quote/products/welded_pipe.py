"""焊管产品模型（welded steel pipe）。

用来验证引擎的通用性：与牛栏网的产品、单位、成本口径、利润模式**全都不同**，
却复用同一套报价内核。

与牛栏网的差异：
- 计量单位：按支/吨（牛栏网按卷）
- 重量：几何公式换算米重（牛栏网用工艺经验公式）
- 成本：按规格给定（牛栏网按镀锌档给定）
- 长度：独立规格轴（牛栏网由丝径方案携带）
"""
from __future__ import annotations

from ..models import (
    Axis,
    Column,
    FormulaSpec,
    Invariant,
    OrderSpec,
    ProductSpec,
    SpaceDeduction,
    VariantGroup,
)
from . import register

DENSITY_KG_M3 = 7850


@register("welded_pipe")
def build_spec() -> ProductSpec:
    return ProductSpec(
        key="welded_pipe",
        name="焊管",
        name_en="Welded Steel Pipe",
        category_code="welded_pipe",
        cost_field="cost_per_kg",
        cost_basis="pretax",
        cost_unit="CNY/kg",
        hs_codes=["7306309000"],

        constants={
            "pi": "3.141592653589793",
            "density": DENSITY_KG_M3,
            "product_name": "焊管",
            "product_name_en": "Welded Steel Pipe",
            "surface_treatment": "黑管（未镀锌）",
            "surface_treatment_en": "Black (ungalvanized)",
            "packing": "六角打包",
            "packing_en": "Hexagonal bundle",
        },

        axes=[Axis("length_m", (6, 12), "定尺(m)", "Length (m)")],

        variants=[
            VariantGroup(
                "size",
                (
                    {"name": "Φ32×2.5", "od_mm": 32, "wall_mm": 2.5,
                     "cost_per_kg": 4.05, "name_en": "Φ32×2.5"},
                    {"name": "Φ48×3.0", "od_mm": 48, "wall_mm": 3.0,
                     "cost_per_kg": 3.98, "name_en": "Φ48×3.0"},
                    {"name": "Φ60×3.5", "od_mm": 60, "wall_mm": 3.5,
                     "cost_per_kg": 3.92, "name_en": "Φ60×3.5"},
                ),
                "规格", "Size",
            ),
        ],

        derived=[
            # 米重(kg/m) = π × (外径 − 壁厚) × 壁厚 × 密度 ÷ 10⁶
            FormulaSpec("area_mm2", "pi * (od_mm - wall_mm) * wall_mm"),
            FormulaSpec("weight_per_m_kg", "area_mm2 * density / 1000000", 4),
            FormulaSpec("weight_per_piece_kg", "weight_per_m_kg * length_m", 4),
        ],

        space_deduction=SpaceDeduction(mode="fixed", value=0),

        piece_metrics=[
            FormulaSpec(
                "price_per_piece",
                "main_price_incl if terms_enabled else unit_price * weight_per_piece_kg",
                2,
            ),
            FormulaSpec("price_per_ton", "unit_price * 1000", 2),
            FormulaSpec("price_per_kg_fx", "unit_price / fx_rate", 4),
        ],

        order_metrics=[
            FormulaSpec("pieces", "total / length_m", 0, integer=True),
            FormulaSpec("total_weight_kg", "total * weight_per_m_kg", 4),
            FormulaSpec("total_price", "pieces * price_per_piece", 2),
            FormulaSpec("total_price_fx", "total_price / fx_rate", 2),
        ],

        invariants=[
            Invariant("总价 = 单支价 × 支数",
                      "total_price == round(pieces * price_per_piece, 2)"),
            Invariant("总重 = 每米重 × 总米数",
                      "total_weight_kg == round(total * weight_per_m_kg, 4)"),
            Invariant("总外币价 = 总价 ÷ 汇率",
                      "total_price_fx == round(total_price / fx_rate, 2)"),
            Invariant("吨价 = 单价 × 1000", "price_per_ton == round(unit_price * 1000, 2)"),
            Invariant("含税售价 = 不含税售价 + 销项税额",
                      "quote_incl_vat == round(quote_excl_vat + output_vat, 4)"),
            Invariant("进项税额 = 含税采购价 − 税前成本",
                      "input_vat == round(cost_incl - cost_pretax, 4)"),
            Invariant("可退进项增值税税额 = 进项税额 × 可退税比例",
                      "refundable_input_vat == round(input_vat * refund_ratio_used, 4)"),
            Invariant("让利额 = 可退进项增值税税额 × 让利比例",
                      "give_amount == round(refundable_input_vat * give_ratio, 4)"),
            Invariant("不含税售价 = 成本 + 利润 + 不可退进项税额 + 自留可退税额 + 印花税",
                      "quote_excl_vat == round(cost_pretax + profit_amount"
                      " + non_refundable_input_vat + retained_refundable + stamp_duty, 4)"),
        ],

        columns=[
            Column("index", "序号", "No.", 0, width=6),
            Column("spec.product_name", "产品", "Product", width=10),
            Column("spec.size", "规格", "Size", width=14),
            Column("spec.od_mm", "外径(mm)", "O.D. (mm)", width=10),
            Column("spec.wall_mm", "壁厚(mm)", "Wall Thickness (mm)", width=10),
            Column("spec.length_m", "定尺(m)", "Length (m)", width=9),
            Column("spec.surface_treatment", "表面处理", "Surface Treatment", width=14),
            Column("spec.packing", "包装", "Packing", width=10),
            Column("derived.weight_per_m_kg", "米重(kg/m)", "Weight per metre (kg/m)", 4, width=12),
            Column("derived.weight_per_piece_kg", "单支重(kg)", "Weight per length (kg)", 4, width=12),
            Column("piece.price_per_piece", "单支售价(元)", "Price per length (CNY)", 2, width=13),
            Column("piece.price_per_ton", "吨价(元/t)", "Price per tonne (CNY)", 2, width=12),
            Column("piece.price_per_kg_fx", "单价(USD/kg)", "Unit Price (USD/kg)", 4, width=13),
            Column("price.cost_pretax", "税前成本(元/kg)", None, 4, internal=True, width=15),
            Column("price.cost_incl", "含税采购价(元/kg)", None, 4, internal=True, width=16),
            Column("price.profit_amount", "加工利润(元/kg)", None, 4, internal=True, width=14),
            Column("price.input_vat", "进项税额(元/kg)", None, 4, internal=True, width=14),
            Column("price.refundable_input_vat", "可退进项增值税税额(元/kg)",
                   None, 4, internal=True, width=20),
            Column("price.non_refundable_input_vat", "不可退进项税额(元/kg)",
                   None, 4, internal=True, width=18),
            Column("price.stamp_duty", "印花税(元/kg)", None, 4, internal=True, width=13),
            Column("price.quote_excl_vat", "不含税售价(元/kg)", None, 4, internal=True, width=16),
            Column("price.output_vat", "销项税额(元/kg)", None, 4, internal=True, width=14),
            Column("price.quote_incl_vat", "含税售价(元/kg)", None, 4, internal=True, width=15),
        ],

        params=[
            ["材质成本", "4.05 / 3.98 / 3.92", "元/kg", "按规格不同，可由报价单覆盖"],
            ["密度", DENSITY_KG_M3, "kg/m³", "钢的密度，用于几何换算米重"],
            ["横截面公式", "π × (外径 − 壁厚) × 壁厚", "", "焊接钢管有效截面"],
        ],

        notes=[
            "1. 米重(kg/m) = π × (外径 − 壁厚) × 壁厚 × 7850 ÷ 10⁶；"
            "单支重 = 米重 × 定尺长度。",
            "2. 含税采购价 = 税前成本 ÷ (1 − 进项票税点)；"
            "进项税额 = 含税采购价 − 税前成本。",
            "3. 单支售价 = 单价 × 单支重；总价 = 单支售价 × 支数。",
        ],
    )


def order_specs(totals=(6000, 12000)) -> list[OrderSpec]:
    out = []
    for t in totals:
        out.append(
            OrderSpec(
                name=f"o{t}m",
                total=t,
                unit="m",
                label=f"{t}米",
                label_en=f"{t:,} m",
            )
        )
    return out
