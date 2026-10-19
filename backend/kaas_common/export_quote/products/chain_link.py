"""勾花网产品模型（chain link fence）。

公式全部取自企微智能表格「客户询盘跟进表 → 明细表」的**公式字段**，
并用表里 3 行真实数据逐位核对过（28.8 / 34.56 / 69.12 kg）。

核心公式：
    单件重量(kg)   = d² × 1.28 ÷ S × W × L
        d = 丝径/线径(mm)，S = 网孔/刺尖间距(cm)，W = 宽度(m)，L = 单件长度(m)
    单件成本(CNY)  = L × W × 原材料进货成本(元/㎡)   ← **按面积，不按重量**
    单件售价(CNY)  = 单件成本 ÷ (1 − 利润率 − 综合税费系数)   ← 价链的 margin_on_price

与牛栏网的两处差别（都是表格口径，不是特例代码）：

1. **成本按面积**。`cost_unit = "CNY/㎡"`，件价 = 单位价 × **单件面积**。
   价链本身与单位无关 —— `price.breakdown(cost_pretax)` 只要求成本与 `cost_unit`
   同单位，把「单位价」折算成「件价」是产品的事（牛栏网乘重量，本产品乘面积）。
   所以**不需要为按面积计价改价链**。
2. **不预置表面处理档位**（2026-10-11 用户裁决：档位由客户自行添加）。
   变体包声明为空，客户在「定价数据」里加到档位后即可报价
   （`load_option_extensions` + `extend_product` 会并入）。
   在客户还没建档位之前不能报价 —— 这时应当明确报错，而不是静默出空行。
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

# 勾花网常用 HS 编码（镀锌钢丝机织网）
HS_CODES = ["7314490000"]

# 体积扣减：与牛栏网同口径（智能表格实测装柜系数 0.96）
STOWAGE_DEDUCTION_RATIO = "0.04"


@register("chain_link")
def build_spec() -> ProductSpec:
    return ProductSpec(
        key="chain_link",
        name="勾花网",
        name_en="Chain Link Fence",
        category_code="gouhuawang",
        cost_field="raw_price",
        cost_basis="pretax",
        # **按面积**计价：单位是 元/㎡，表里「原材料进货成本 元(kg/㎡)」用的就是这个
        cost_unit="CNY/㎡",
        hs_codes=list(HS_CODES),

        # 定价键：单价随「丝径 × 表面处理」变。
        # 丝径是自由数值 → 查价键用客户实际填入的值，无需枚举
        # （`extend_product` 对 free 维度显式跳过）。
        pricing_key=[
            {"field": "d", "label": "丝径/线径", "unit": "mm"},
            {"field": "coating_code", "label": "表面处理"},
        ],

        constants={
            "product_name": "勾花网",
            "product_name_en": "Chain Link Fence",
            "packing": "无包装",
            "packing_en": "No packing",
            # 表格公式里的经验系数：单件重量 = d² × 1.28 ÷ S × W × L
            "wire_factor": "1.28",
            "pi": "3.14159265358979323846",
        },

        # 尺寸类一律自由数值；表面处理由客户自建（故不在此预置档位）
        axes=[],

        numeric_inputs=[
            NumericInput("d", "丝径/线径(mm)", "Wire Dia. (mm)",
                         unit="mm", default=2.5, min_value=0.3, max_value=8,
                         decimals=2, note="重量公式里的 d（表格「丝径/线径」）。"),
            NumericInput("mesh_cm", "网孔/刺尖间距(cm)", "Mesh Opening (cm)",
                         unit="cm", default=5, min_value=0.5, max_value=50,
                         decimals=2, note="重量公式里的 S（表格「网孔/刺尖间距」）。"),
            NumericInput("width_m", "宽度(m)", "Width (m)",
                         unit="m", default=1.8, min_value=0.1, max_value=6,
                         decimals=3, note="重量公式里的 W；体积口径也按它算。"),
            NumericInput("len_m", "单件长度(m)", "Length per Piece (m)",
                         unit="m", default=10, min_value=0.1, max_value=100,
                         decimals=3, note="重量公式里的 L；也是每件的米数。"),
            NumericInput("roll_dia_m", "卷径", "Roll Diameter",
                         unit="m", ui_unit="公分", ui_scale=100,
                         default=0.30, min_value=0.05, max_value=2,
                         note="决定体积（π/4 × 卷径² × 宽度），是对外报运价/报关的口径。"),
        ],

        # **空变体包**：档位由客户在定价数据里自建（用户裁决）。
        # 声明出来是为了让 `extend_product` 有地方追加客户的档位，
        # 也让规格接口能明确告诉界面「这一维还没有可选值」。
        variants=[
            VariantGroup("coating", (), "表面处理", "Surface Treatment"),
        ],

        derived=[
            FormulaSpec("area_per_piece_m2", "len_m * width_m", 4, False,
                        "单件面积(㎡)", "Area per Piece (m²)", "㎡",
                        "单件面积 = 单件长度 × 宽度。**成本按面积算**（表格口径），"
                        "所以它是勾花网的关键中间量，不是副产品。"),
            FormulaSpec("weight_per_piece_kg",
                        "d**2 * wire_factor / mesh_cm * width_m * len_m",
                        4, False,
                        "单件重量(kg)", "Weight per Piece (kg)", "kg",
                        "单件重量 = d² × 1.28 ÷ S × W × L（表格公式逐字照搬）。"
                        "d=丝径(mm)、S=网孔间距(cm)、W=宽度(m)、L=单件长度(m)。"
                        "1.28 是表格里的经验系数。"),
            FormulaSpec("volume_per_piece_m3", "pi / 4 * roll_dia_m**2 * width_m",
                        4, False,
                        "单件净体积(m³)", "Net Volume per Piece (m³)", "m³",
                        "按**实际圆柱体**计：π/4 × 卷径² × 宽度（钢材本身占的体积）。"),
            FormulaSpec("volume_box_per_piece_m3", "roll_dia_m**2 * width_m",
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
            # 与牛栏网唯一的实质差别：**乘面积**而不是乘重量
            FormulaSpec(
                "price_per_piece",
                "main_price_incl if terms_enabled else unit_price * area_per_piece_m2",
                2, False,
                "单件售价(元/件)", "Price per Piece (CNY)", "元/件",
                "单件售价 = 单位价(元/㎡) × **单件面积**。"
                "勾花网的成本与售价都按面积计（表格口径），不是按重量。"
                "启用贸易术语时取主术语（含税）单件价。",
            ),
            FormulaSpec("price_per_m2", "price_per_piece / area_per_piece_m2", 4, False,
                        "单价(元/㎡)", "Unit Price (CNY/m²)", "元/㎡",
                        "每平方米价 = 单件售价 ÷ 单件面积，与单件价同源。"),
            FormulaSpec("price_per_piece_fx", "price_per_piece / fx_rate", 4, False,
                        "单件美元售价(USD/件)", "Price per Piece (USD)", "USD/件",
                        "外币价由**已展示的人民币件价**除以汇率得到，"
                        "保证客户拿表上数字复算一致。"),
        ],

        order_metrics=[
            FormulaSpec("pieces", "total / len_m", 0, True,
                        "件数", "Pieces", "件",
                        "件数 = 订单总长度 ÷ 单件长度。"),
            FormulaSpec("total_net_weight_kg", "pieces * weight_per_piece_kg", 4, False,
                        "总净重(kg)", "Total Net Weight (kg)", "kg",
                        "总净重 = 单件净重（落定值）× 件数。"),
            FormulaSpec("total_area_m2", "pieces * area_per_piece_m2", 4, False,
                        "总面积(㎡)", "Total Area (m²)", "㎡",
                        "总面积 = 单件面积 × 件数。"),
            FormulaSpec("volume_box_m3", "pieces * volume_box_per_piece_m3", 4, False,
                        "长方体总体积(m³)", "Total Box Volume (m³)", "m³",
                        "长方体总体积 = 单件**外接长方体**体积（落定值）× 件数，"
                        "尚未扣减。"),
            FormulaSpec("volume_effective_m3",
                        "volume_box_m3 * (1 - space_deduction_ratio) - space_deduction",
                        4, False,
                        "实际占用体积(m³)", "Effective Occupied Volume (m³)", "m³",
                        "实际占用体积 = 长方体总体积 × (1 − 扣减比例)。"
                        "按比例而非固定扣减 —— 固定值在小单上会算出负体积。"
                        "这是对外报运价/报关的口径。"),
            FormulaSpec("total_price", "pieces * price_per_piece", 2, False,
                        "总售价(元)", "Total Price (CNY)", "元",
                        "总售价 = 单件售价 × 件数，严格满足「单价 × 数量 = 总价」。"),
            FormulaSpec("total_price_fx", "pieces * price_per_piece_fx", 4, False,
                        "总美元售价(USD)", "Total Price (USD)", "USD",
                        "总美元售价 = 单件美元售价 × 件数。"),
        ],

        invariants=[
            Invariant("总价 = 单件价 × 件数",
                      "total_price == round(pieces * price_per_piece, 2)"),
            Invariant("单件重量 = d² × 1.28 ÷ S × W × L",
                      "weight_per_piece_kg == round(d**2 * wire_factor / mesh_cm"
                      " * width_m * len_m, 4)"),
            Invariant("单件面积 = 单件长度 × 宽度",
                      "area_per_piece_m2 == round(len_m * width_m, 4)"),
            Invariant("总重 = 单件重 × 件数",
                      "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)"),
            Invariant("总面积 = 单件面积 × 件数",
                      "total_area_m2 == round(pieces * area_per_piece_m2, 4)"),
            Invariant("实际占用 = 总体积 × (1 − 扣减比例)",
                      "volume_effective_m3 == round(volume_box_m3"
                      " * (1 - space_deduction_ratio) - space_deduction, 4)"),
            Invariant("单件净体积 = π/4 × 卷径² × 宽度（圆柱体）",
                      "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * width_m, 4)"),
            Invariant("单件长方体体积 = 卷径² × 宽度（外接方柱）",
                      "volume_box_per_piece_m3 == round(roll_dia_m**2 * width_m, 4)"),
            Invariant("零税率时销项税额为 0",
                      "output_vat_rate_used != 0 or output_vat == 0"),
        ],

        columns=[
            Column("index", "序号", "No.", 0, width=6),
            Column("spec.product_name", "产品", "Product", width=10),
            Column("spec.d", "丝径/线径(mm)", "Wire Dia. (mm)", 1, width=14),
            Column("spec.mesh_cm", "网孔/刺尖间距(cm)", "Mesh Opening (cm)", 2, width=16),
            Column("spec.width_m", "宽度(m)", "Width (m)", 3, width=10),
            Column("spec.len_m", "单件长度(m)", "Length per Piece (m)", 3, width=14),
            Column("spec.roll_dia_m", "卷径(m)", "Roll Diameter (m)", 3, width=12),
            Column("spec.coating", "表面处理", "Surface Treatment", width=18),
            Column("derived.area_per_piece_m2", "单件面积(㎡)", "Area per Piece (m²)",
                   4, width=14),
            Column("derived.weight_per_piece_kg", "单件重量(kg)",
                   "Weight per Piece (kg)", 4, width=14),
            Column("derived.volume_per_piece_m3", "单件净体积(m³)",
                   "Net Volume per Piece (m³)", 4, width=15),
            Column("derived.volume_box_per_piece_m3", "单件长方体体积(m³)",
                   "Box Volume per Piece (m³)", 4, width=16),
            Column("piece.price_per_piece", "单件售价(元/件)",
                   "Price per Piece (CNY)", 2, width=14),
            Column("piece.price_per_m2", "单价(元/㎡)", "Unit Price (CNY/m²)",
                   4, width=12),
            Column("piece.price_per_piece_fx", "单件美元售价(USD/件)",
                   "Price per Piece (USD)", 4, width=16),
            Column("price.cost_pretax", "税前成本(元/㎡)", None, 4,
                   internal=True, width=14),
            Column("price.cost_incl", "含税采购价(元/㎡)", None, 4,
                   internal=True, width=16),
            Column("price.profit_amount", "加工利润(元/㎡)", None, 4,
                   internal=True, width=14),
            Column("price.quote_excl_vat", "不含税售价(元/㎡)", None, 4,
                   internal=True, width=16),
            Column("price.output_vat_rate_used", "销项税率", None, 4,
                   internal=True, width=10),
            Column("price.output_vat", "销项税额(元/㎡)", None, 4,
                   internal=True, width=14),
            Column("price.quote_incl_vat", "含税售价(元/㎡)", None, 4,
                   internal=True, width=15),
        ],

        params=[
            ["原料进货成本", "客户每单填写", "元/㎡",
             "**按面积**计价的单位价（表格口径）。每天变动，由客户在报价时填"],
            ["重量经验系数", "1.28", "—",
             "表格公式 `d² × 1.28 ÷ S × W × L` 里的系数，逐字照搬"],
            ["占用空间扣减比例", "0.04（= 装柜系数 0.96）", "比例",
             "取值来源：智能表格 21 行的装柜系数实测值 0.96"],
            ["表面处理档位", "由客户自行添加", "—",
             "本产品**不预置**任何档位（用户裁决）。客户在「定价数据」里加档位后即可报价"],
        ],

        notes=[
            "1. 单件重量(kg) = d² × 1.28 ÷ S × W × L；"
            "d=丝径/线径(mm)，S=网孔/刺尖间距(cm)，W=宽度(m)，L=单件长度(m)。"
            "该公式取自智能表格的公式字段，并用表里 3 行真实数据核对过"
            "（28.8 / 34.56 / 69.12 kg）。",
            "2. **成本与售价都按面积**：单件成本 = 单件长度 × 宽度 × 单位价(元/㎡)，"
            "单件售价 = 单件成本 ÷ (1 − 利润率 − 综合税费系数)。"
            "这与牛栏网（按重量）是两种口径，不要混用。",
            "3. 表面处理档位**由客户自行添加**：产品定义里不预置任何档位，"
            "客户在「定价数据」里加到档位后，该档位会并入规格空间，"
            "规格接口与算价接口共用同一份，不会出现「能选不能算」。",
            "4. 体积分两个口径：单件净体积按实际圆柱体 = π/4 × 卷径² × 宽度；"
            "单件长方体体积按外接方柱 = 卷径² × 宽度。"
            "总实际占用体积 = 长方体体积 × 件数 × 装柜系数 0.96。",
        ],
    )


def order_specs(totals=(500, 1000, 2000)) -> list[OrderSpec]:
    """勾花网常用订单量方案（总长度，米）。"""
    out = []
    for t in totals:
        label = f"{t}米"
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
