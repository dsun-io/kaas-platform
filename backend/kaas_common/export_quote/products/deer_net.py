"""鹿网产品模型（deer net / 环扣型）。

公式取自企微智能表格「客户询盘跟进表 → 明细表」的公式字段。
**注意**：表里**没有鹿网的数据行**（21 行里只有牛栏网 / 勾花网 / 刺绳 /
Y型立柱等），所以无法用真实记录核对 —— 只能对齐**公式本身**。
`tests/test_export_quote_deer_net.py` 用"把表格公式原样抄进测试再逐点比对"
的办法替代：在一组输入上求值，两条公式必须完全相等。

表格原式（逐字）：
    单件重量 = 0.01234 × L × ( De² + Di²(N−2)/2
                              + (W×1000+80)×Dw²/(S×10)/2
                              + (N−2)×140×Dt²/(S×10)/2 )

整理成与牛栏网同一写法（0.00617 = 0.01234 ÷ 2）：
    单件重量 = 0.00617 × L × [ 2·De² + Di²(N−2)
                              + (W×1000+80)·Dw²/(S×10)
                              + (N−2)·140·Dt²/(S×10) ]

    变量：De=边丝直径(mm)、Di=内经丝直径(mm)、Dw=内纬丝直径(mm)、
          Dt=拧花丝径(mm)、N=横丝根数、W=宽度(m)、S=网孔/刺尖间距(cm)、
          L=单件长度(m)

与牛栏网的差别只在重量式：鹿网多出「拧花丝径」一项，且内纬丝项多一个 +80 的
常数、并带 (N−2)×140 的系数 —— 都是表格里的经验项，**原样照搬，不改造**。

计价口径由表格定的：表中成本公式为
    IF(产品 = "勾花网", L × W × 元/㎡, 元/kg × 单件重量)
即**除勾花网外都按重量**，鹿网属后者 → `cost_unit = "CNY/kg"`。

档位同样**不预置**（用户裁决：由客户在定价数据里自建）。
"""
from __future__ import annotations

from ..models import (
    Column,
    FormulaSpec,
    Invariant,
    NumericInput,
    OrderSpec,
    ProductSpec,
    SpaceDeduction,
    VariantGroup,
)
from . import register

# 鹿网常用 HS 编码（镀锌钢丝机织网 / 环扣网）
HS_CODES = ["7314410000"]

# 表格里两个经验常数，原样照搬
WIDTH_BIAS_MM = 80      # (W×1000 + 80)
TWIST_PER_ROW = 140     # (N−2) × 140 × Dt² / (S×10)
STOWAGE_DEDUCTION_RATIO = "0.04"


@register("deer_net")
def build_spec() -> ProductSpec:
    return ProductSpec(
        key="deer_net",
        name="鹿网",
        name_en="Deer Net",
        category_code="luwang",
        cost_field="raw_price",
        cost_basis="pretax",
        # 表格的成本公式：除勾花网（按面积）外都按**重量**
        cost_unit="CNY/kg",
        hs_codes=list(HS_CODES),

        pricing_key=[
            {"field": "de", "label": "边丝直径", "unit": "mm"},
            {"field": "coating_code", "label": "表面处理"},
        ],

        constants={
            "product_name": "鹿网",
            "product_name_en": "Deer Net",
            "packing": "无包装",
            "packing_en": "No packing",
            "width_bias_mm": WIDTH_BIAS_MM,
            "twist_per_row": TWIST_PER_ROW,
            "pi": "3.14159265358979323846",
        },

        axes=[],

        numeric_inputs=[
            NumericInput("de", "边丝直径(mm)", "Edge Wire Dia. (mm)",
                         unit="mm", default=2.5, min_value=0.3, max_value=8,
                         decimals=2, note="重量公式里的 De。"),
            NumericInput("di", "内经丝直径(mm)", "Inner Warp Wire Dia. (mm)",
                         unit="mm", default=2.5, min_value=0.3, max_value=8,
                         decimals=2, note="重量公式里的 Di。"),
            NumericInput("dw", "内纬丝直径(mm)", "Inner Weft Wire Dia. (mm)",
                         unit="mm", default=2.5, min_value=0.3, max_value=8,
                         decimals=2, note="重量公式里的 Dw。"),
            NumericInput("dt", "拧花丝径(mm)", "Twisted Wire Dia. (mm)",
                         unit="mm", default=2.0, min_value=0.3, max_value=8,
                         decimals=2, note="重量公式里的 Dt —— 鹿网特有（拧花）。"),
            NumericInput("n", "横丝根数", "No. of Horizontal Wires",
                         unit="根", default=10, min_value=2, max_value=100,
                         note="重量公式里的 N。"),
            NumericInput("height_m", "宽度(m)", "Width (m)",
                         unit="m", default=1.5, min_value=0.3, max_value=6,
                         decimals=2, note="重量公式里的 W；体积口径也按它算。"),
            NumericInput("mesh_mm", "网孔/刺尖间距(mm)", "Mesh Opening (mm)",
                         unit="mm", default=150, min_value=10, max_value=1000,
                         note="重量公式里的 S×10（表里按 cm 填，内部按 mm 算）。"),
            NumericInput("roll_len_m", "单件长度(m)", "Length per Piece (m)",
                         unit="m", default=100, min_value=1, max_value=1000,
                         note="重量公式里的 L，也是每件的米数。"),
            NumericInput("roll_dia_m", "卷径", "Roll Diameter",
                         unit="m", ui_unit="公分", ui_scale=100,
                         default=0.30, min_value=0.05, max_value=2,
                         note="决定体积（π/4 × 卷径² × 宽度），报运价/报关口径。"),
        ],

        # 档位由客户自建（用户裁决）—— 声明但不预置取值
        variants=[
            VariantGroup("coating", (), "表面处理", "Surface Treatment"),
        ],

        derived=[
            FormulaSpec("width_mm", "height_m * 1000", None, False,
                        "宽度(mm)", "Width (mm)", "mm",
                        "统一到毫米参与重量公式，避免量纲混用。"),
            FormulaSpec(
                "weight_base_kg",
                "0.00617 * roll_len_m * (2*de**2 + di**2*(n-2)"
                " + (width_mm + width_bias_mm) * dw**2 / mesh_mm"
                " + (n-2) * twist_per_row * dt**2 / mesh_mm)",
                None, False,
                "单件基础净重(kg)", "Base Net Weight per Piece (kg)", "kg",
                "单件重量 = 0.00617 × L × [2·De² + Di²(N−2) "
                "+ (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]。"
                "由表格原式 0.01234 × L × (De² + Di²(N−2)/2 "
                "+ (W×1000+80)Dw²/(S×10)/2 + (N−2)×140×Dt²/(S×10)/2) "
                "整理而来（0.01234 = 2×0.00617），逐项等价。"
                "80 与 140 是表格里的经验常数，原样照搬。",
            ),
            FormulaSpec("weight_per_piece_kg", "weight_base_kg", 4, False,
                        "单件净重(kg)", "Net Weight per Piece (kg)", "kg",
                        "按 4 位小数落定后供下游乘件数，"
                        "以保证表上「单件重 × 件数 = 总重」能对上。"),
            FormulaSpec("volume_per_piece_m3", "pi / 4 * roll_dia_m**2 * height_m",
                        4, False,
                        "单件净体积(m³)", "Net Volume per Piece (m³)", "m³",
                        "按**实际圆柱体**计：π/4 × 卷径² × 宽度。"),
            FormulaSpec("volume_box_per_piece_m3", "roll_dia_m**2 * height_m",
                        4, False,
                        "单件长方体体积(m³)", "Box Volume per Piece (m³)", "m³",
                        "按**外接长方体**计：卷径² × 宽度。堆码/报运价用这个口径。"),
        ],

        space_deduction=SpaceDeduction(
            mode="ratio", value=STOWAGE_DEDUCTION_RATIO,
            note="实际占用体积 = 长方体累计总体积 × (1 − 扣减比例)，即 × 装柜系数 0.96。"
                 "取值来源：智能表格「明细表」21 行的装柜系数实测值 0.96。"
                 "按比例而非固定 m³ —— 固定值不随数量缩放，小单会算出负体积。",
        ),

        piece_metrics=[
            # 与牛栏网同口径：**按重量**（表格的成本公式：除勾花网外都按重量）
            FormulaSpec(
                "price_per_piece",
                "main_price_incl if terms_enabled else unit_price * weight_per_piece_kg",
                2, False,
                "单件售价(元/件)", "Price per Piece (CNY)", "元/件",
                "单件售价 = 单价(元/kg) × 单件净重。"
                "表格的成本公式为 IF(产品=\"勾花网\", L×W×元/㎡, 元/kg×单件重量)，"
                "鹿网属后者，**按重量**。",
            ),
            FormulaSpec("price_per_meter", "price_per_piece / roll_len_m", 4, False,
                        "单价(元/米)", "Unit Price (CNY/m)", "元/米",
                        "每米价 = 单件售价 ÷ 单件长度。"),
            FormulaSpec("price_per_piece_fx", "price_per_piece / fx_rate", 4, False,
                        "单件美元售价(USD/件)", "Price per Piece (USD)", "USD/件",
                        "外币价由已展示的人民币件价除以汇率得到。"),
        ],

        order_metrics=[
            FormulaSpec("pieces", "total / roll_len_m", 0, True,
                        "件数", "Pieces", "件",
                        "件数 = 订单总长度 ÷ 单件长度。"),
            FormulaSpec("total_net_weight_kg", "pieces * weight_per_piece_kg",
                        4, False,
                        "总净重(kg)", "Total Net Weight (kg)", "kg",
                        "总净重 = 单件净重（落定值）× 件数。"),
            FormulaSpec("volume_box_m3", "pieces * volume_box_per_piece_m3",
                        4, False,
                        "长方体总体积(m³)", "Total Box Volume (m³)", "m³",
                        "长方体总体积 = 单件外接长方体体积（落定值）× 件数。"),
            FormulaSpec("volume_effective_m3",
                        "volume_box_m3 * (1 - space_deduction_ratio) - space_deduction",
                        4, False,
                        "实际占用体积(m³)", "Effective Occupied Volume (m³)", "m³",
                        "实际占用体积 = 长方体总体积 × (1 − 扣减比例)。"
                        "按比例而非固定扣减 —— 固定值在小单上会算出负体积。"),
            FormulaSpec("total_price", "pieces * price_per_piece", 2, False,
                        "总售价(元)", "Total Price (CNY)", "元",
                        "总售价 = 单件售价 × 件数。"),
            FormulaSpec("total_price_fx", "pieces * price_per_piece_fx", 4, False,
                        "总美元售价(USD)", "Total Price (USD)", "USD",
                        "总美元售价 = 单件美元售价 × 件数。"),
        ],

        invariants=[
            Invariant("总价 = 单件价 × 件数",
                      "total_price == round(pieces * price_per_piece, 2)"),
            Invariant("单件重量 = 0.00617 × L × [2·De² + Di²(N−2) "
                      "+ (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]",
                      "weight_base_kg == 0.00617 * roll_len_m * (2*de**2"
                      " + di**2*(n-2)"
                      " + (width_mm + width_bias_mm) * dw**2 / mesh_mm"
                      " + (n-2) * twist_per_row * dt**2 / mesh_mm)"),
            Invariant("总重 = 单件重 × 件数",
                      "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)"),
            Invariant("实际占用 = 总体积 × (1 − 扣减比例)",
                      "volume_effective_m3 == round(volume_box_m3"
                      " * (1 - space_deduction_ratio) - space_deduction, 4)"),
            Invariant("单件净体积 = π/4 × 卷径² × 宽度（圆柱体）",
                      "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * height_m, 4)"),
            Invariant("单件长方体体积 = 卷径² × 宽度（外接方柱）",
                      "volume_box_per_piece_m3 == round(roll_dia_m**2 * height_m, 4)"),
            Invariant("零税率时销项税额为 0",
                      "output_vat_rate_used != 0 or output_vat == 0"),
        ],

        columns=[
            Column("index", "序号", "No.", 0, width=6),
            Column("spec.product_name", "产品", "Product", width=10),
            Column("spec.de", "边丝直径(mm)", "Edge Wire Dia. (mm)", 1, width=14),
            Column("spec.di", "内经丝直径(mm)", "Inner Warp Wire Dia. (mm)",
                   1, width=16),
            Column("spec.dw", "内纬丝直径(mm)", "Inner Weft Wire Dia. (mm)",
                   1, width=16),
            Column("spec.dt", "拧花丝径(mm)", "Twisted Wire Dia. (mm)",
                   1, width=14),
            Column("spec.height_m", "宽度(m)", "Width (m)", 2, width=11),
            Column("spec.n", "横丝根数", "No. of Horizontal Wires", 0, width=11),
            Column("spec.mesh_mm", "网孔/刺尖间距(mm)", "Mesh Opening (mm)",
                   0, width=16),
            Column("spec.coating", "表面处理", "Surface Treatment", width=18),
            Column("spec.roll_len_m", "单件长度(m)", "Length per Piece (m)",
                   3, width=13),
            Column("spec.roll_dia_m", "卷径(m)", "Roll Diameter (m)", 3, width=12),
            Column("derived.weight_per_piece_kg", "单件净重(kg)",
                   "Net Weight per Piece (kg)", 4, width=14),
            Column("derived.volume_per_piece_m3", "单件净体积(m³)",
                   "Net Volume per Piece (m³)", 4, width=15),
            Column("derived.volume_box_per_piece_m3", "单件长方体体积(m³)",
                   "Box Volume per Piece (m³)", 4, width=16),
            Column("piece.price_per_piece", "单件售价(元/件)",
                   "Price per Piece (CNY)", 2, width=14),
            Column("piece.price_per_meter", "单价(元/米)", "Unit Price (CNY/m)",
                   4, width=12),
            Column("piece.price_per_piece_fx", "单件美元售价(USD/件)",
                   "Price per Piece (USD)", 4, width=16),
            Column("price.cost_pretax", "税前成本(元/kg)", None, 4,
                   internal=True, width=14),
            Column("price.cost_incl", "含税采购价(元/kg)", None, 4,
                   internal=True, width=16),
            Column("price.profit_amount", "加工利润(元/kg)", None, 4,
                   internal=True, width=14),
            Column("price.quote_excl_vat", "不含税售价(元/kg)", None, 4,
                   internal=True, width=16),
            Column("price.output_vat_rate_used", "销项税率", None, 4,
                   internal=True, width=10),
            Column("price.output_vat", "销项税额(元/kg)", None, 4,
                   internal=True, width=14),
            Column("price.quote_incl_vat", "含税售价(元/kg)", None, 4,
                   internal=True, width=15),
        ],

        params=[
            ["原料进货成本", "客户每单填写", "元/kg",
             "按**重量**计价（表格的成本公式：除勾花网外都按重量）"],
            ["宽度偏置", WIDTH_BIAS_MM, "mm",
             "表格公式里的 (W×1000 + 80)，经验常数，原样照搬"],
            ["拧花系数", TWIST_PER_ROW, "—",
             "表格公式里的 (N−2) × 140 × Dt²/(S×10)，鹿网特有，原样照搬"],
            ["占用空间扣减比例", "0.04（= 装柜系数 0.96）", "比例",
             "取值来源：智能表格 21 行的装柜系数实测值 0.96"],
            ["表面处理档位", "由客户自行添加", "—",
             "本产品**不预置**任何档位（用户裁决）"],
        ],

        notes=[
            "1. 单件重量(kg) = 0.00617 × L × [2·De² + Di²(N−2) "
            "+ (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]。"
            "由表格原式 0.01234 × L × (De² + Di²(N−2)/2 "
            "+ (W×1000+80)Dw²/(S×10)/2 + (N−2)×140×Dt²/(S×10)/2) 整理而来，"
            "逐项等价（0.01234 = 2 × 0.00617）。",
            "2. **本产品没有真实数据可核对**：智能表格 21 行里没有鹿网记录，"
            "所以只能对齐**公式本身**（测试里把表格公式原样抄一份逐点比对），"
            "无法像牛栏网 / 勾花网那样用表里记录验证。",
            "3. 计价**按重量**：表格的成本公式为 "
            "IF(产品 = \"勾花网\", L × W × 元/㎡, 元/kg × 单件重量)，"
            "鹿网属后者。勾花网是唯一的按面积产品。",
            "4. 表面处理档位由客户自行添加：产品定义里不预置任何档位，"
            "客户在「定价数据」里加档位后即可报价。",
            "5. 体积分两个口径：单件净体积按实际圆柱体 = π/4 × 卷径² × 宽度；"
            "单件长方体体积按外接方柱 = 卷径² × 宽度。"
            "总实际占用体积 = 长方体体积 × 件数 × 装柜系数 0.96。",
        ],
    )


def order_specs(totals=(30000, 50000)) -> list[OrderSpec]:
    """鹿网常用订单量方案（总长度，米）。"""
    out = []
    for t in totals:
        label = f"{t // 10000}万米" if t % 10000 == 0 else f"{t}米"
        out.append(
            OrderSpec(
                name=f"o{t}",
                total=t,
                unit="m",
                label=label,
                label_en=f"{t:,} m",
            )
        )
    return out
