"""牛栏网产品模型（cattle fence / field fence）。

牛栏网相关的**全部特有计算逻辑**集中在这里，引擎与报价政策都不含牛栏网知识。

产品特征：
- 拧编型，横丝间距上疏下密；横丝间距不参与重量与计价
- 丝径有三种方案，方案一选定则边丝径/内横丝径/竖丝径/卷长/卷径**同时确定**，
  因此用「变体包」而不是独立规格轴
- 每卷重量由工艺公式算出，不是查表

核心公式（客户给定口径）：
    整卷净重(kg) = 0.00617 × L × [2·d边² + (n−2)·d横² + d竖² × (w + (n−1)×50) / s]
        L = 卷长(m)，n = 横丝(径丝)根数，d边/d横/d竖 = 边丝/内横丝/竖丝直径(mm)
        w = 网高(mm)，s = 竖丝间距(mm)，(n−1)×50 = 铰接结每道缠绕余量(mm)
    边丝重量(kg) = 0.01234 × L × d边²
    波弯款在无波款基础上每 100 米增加 3kg

数据来源：客户（河北慷逊公司）提供的报价口径与技术参数。
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

# ── 固定参数 ────────────────────────────────────────────────────────────────
HORIZONTAL_WIRE_COUNT = 10  # 横丝（径丝）根数 n
WAVE_ADD_PER_100M = 3  # 波弯款每 100 米增重 kg
ROLL_LEN_SHORT = 50  # 全丝 2.5 用 50 米卷
ROLL_LEN_LONG = 100
ROLL_DIA_SHORT = 0.25  # 50 米卷卷径 m
ROLL_DIA_LONG = 0.30  # 100 米卷卷径 m

# 牛栏网常用 HS 编码（热镀锌机织钢丝网）
HS_CODES = ["7314410000"]


@register("field_fence")
def build_spec() -> ProductSpec:
    return ProductSpec(
        key="field_fence",
        name="牛栏网",
        name_en="Field Fence",
        category_code="niulanwang",
        cost_field="raw_price",
        cost_basis="pretax",
        cost_unit="CNY/kg",
        hs_codes=list(HS_CODES),

        constants={
            "n": HORIZONTAL_WIRE_COUNT,
            "product_name": "牛栏网",
            "product_name_en": "Field Fence",
            "surface_treatment": "热镀锌",
            "surface_treatment_en": "Hot-dip galvanized",
            "packing": "无包装",
            "packing_en": "No packing",
            "wave_add_per_100m": WAVE_ADD_PER_100M,
            # 用字符串以在 Decimal 下保住精度（π/4 决定圆柱体积）
            "pi": "3.14159265358979323846",
        },

        # 独立规格轴
        axes=[
            Axis("height_m", (1.2, 1.5), "网高(m)", "Net Height (m)"),
            Axis("mesh_mm", (100, 150), "竖丝间距(mm)", "Vertical Wire Spacing (mm)"),
        ],

        # 关联属性：一选全变
        variants=[
            VariantGroup(
                "wire",
                (
                    # code 与 DB 迁移里的 value_code 一致（spec_attribute_values.value_code），
                    # 这样「产品定义 ↔ 数据库 ↔ 表格导入」共用同一套标识，不会各写各的
                    {"code": "all_wire_20", "name": "全丝2.0", "de": 2.0, "dm": 2.0, "dv": 2.0,
                     "roll_len_m": ROLL_LEN_LONG, "roll_dia_m": ROLL_DIA_LONG,
                     "name_en": "All wires 2.0"},
                    {"code": "all_wire_25", "name": "全丝2.5", "de": 2.5, "dm": 2.5, "dv": 2.5,
                     "roll_len_m": ROLL_LEN_SHORT, "roll_dia_m": ROLL_DIA_SHORT,
                     "name_en": "All wires 2.5"},
                    {"code": "edge25_inner20", "name": "边丝2.5+内丝2.0", "de": 2.5, "dm": 2.0,
                     "dv": 2.0,
                     "roll_len_m": ROLL_LEN_LONG, "roll_dia_m": ROLL_DIA_LONG,
                     "name_en": "Edge 2.5 + inner 2.0"},
                ),
                "丝径方案", "Wire Diameter Option",
            ),
            VariantGroup(
                "coating",
                (
                    {"code": "zinc_40", "name": "普锌40g/㎡", "raw_price": 4.4,
                     "zinc_g_m2": 40, "name_en": "Economical 40 g/m²"},
                    {"code": "zinc_200", "name": "重镀锌≥200g/㎡", "raw_price": 5.6,
                     "zinc_g_m2": 200, "name_en": "Heavier hot-dip ≥200 g/m²"},
                ),
                "镀锌量", "Zinc Coating",
            ),
            VariantGroup(
                "wave",
                (
                    {"code": "no_wave", "name": "无波款", "wave_factor": 0,
                     "name_en": "Without wave bend"},
                    {"code": "wave_bend", "name": "波弯款", "wave_factor": 1,
                     "name_en": "With wave bend"},
                ),
                "工艺", "Wave Bend",
            ),
        ],

        # 派生公式：按顺序求值，decimals 处逐级落定
        # note 写的是业务口径 —— 报价工位要把「怎么算」一并展示给业务确认
        derived=[
            FormulaSpec("height_mm", "height_m * 1000", None, False,
                        "网高(mm)", "Net Height (mm)", "mm",
                        "统一到毫米参与重量公式，避免量纲混用。"),
            FormulaSpec("mesh_cm", "mesh_mm / 10", None, False,
                        "竖丝间距(cm)", "Vertical Wire Spacing (cm)", "cm",
                        "对外按厘米表述（10cm / 15cm），内部按毫米计算。"),
            FormulaSpec("wire_count", "n", None, False,
                        "横丝数(根)", "No. of Horizontal Wires", "根",
                        "牛栏网固定 10 根横丝（径丝），即重量公式中的 n。"),
            FormulaSpec("roll_dia_cm", "roll_dia_m * 100", None, False,
                        "卷径(cm)", "Roll Diameter (cm)", "cm",
                        "100 米卷 30cm、50 米卷 25cm，随丝径方案联动。"),
            FormulaSpec(
                "weight_base_kg",
                "0.00617 * roll_len_m * (2*de**2 + (n-2)*dm**2"
                " + dv**2 * (height_mm + (n-1)*50) / mesh_mm)",
                None, False,
                "单卷基础净重(kg)", "Base Net Weight per Roll (kg)", "kg",
                "整卷净重(kg) = 0.00617 × L × [2·d边² + (n−2)·d横² "
                "+ d竖² × (w + (n−1)×50) / s]；L=卷长(m)，n=横丝根数，"
                "w=网高(mm)，s=竖丝间距(mm)，(n−1)×50 为每个铰接结的缠绕余量(mm)。"
                "此处的 0.00617 是钢丝截面积→重量的换算系数（含钢密度与圆周率）。",
            ),
            FormulaSpec("edge_weight_kg", "0.01234 * roll_len_m * de**2", 4, False,
                        "单卷边丝重(kg)", "Edge Wire Weight per Roll (kg)", "kg",
                        "边丝重量(kg) = 0.01234 × L × d边²（两侧边丝合计，"
                        "故系数是 0.00617 的两倍）。"),
            FormulaSpec("wave_add_kg",
                        "wave_factor * wave_add_per_100m * roll_len_m / 100",
                        None, False,
                        "波弯增重(kg)", "Wave Bend Extra Weight (kg)", "kg",
                        "波弯款按每 100 米增重 3kg 折算："
                        "增重 = wave_factor × 3 × 卷长 ÷ 100。"
                        "无波款 wave_factor=0 故增重为 0；"
                        "100 米卷 +3kg，50 米卷只 +1.5kg。",
                        ),
            FormulaSpec("weight_per_piece_kg", "weight_base_kg + wave_add_kg", 4, False,
                        "单卷净重(kg)", "Net Weight per Roll (kg)", "kg",
                        "单卷净重 = 基础净重 + 波弯增重。"
                        "此处按 4 位小数落定，下游总重由落定值乘卷数，"
                        "以保证表上「单卷重 × 卷数 = 总重」能对上。"),
            FormulaSpec("volume_per_piece_m3", "pi / 4 * roll_dia_m**2 * height_m", 4, False,
                        "单卷净体积(m³)", "Net Volume per Roll (m³)", "m³",
                        "按**实际圆柱体**计：单卷净体积 = π/4 × 卷径² × 网高，"
                        "即 π × (卷径/2)² × 网高。这是钢材本身的占用体积。"),
            FormulaSpec("volume_box_per_piece_m3", "roll_dia_m**2 * height_m", 4, False,
                        "单卷长方体体积(m³)", "Box Volume per Roll (m³)", "m³",
                        "按**外接长方体**计：单卷长方体体积 = 卷径² × 网高"
                        "（把卷看作以卷径为边长的方柱）。堆码/报运价用这个口径。"),
        ],

        space_deduction=SpaceDeduction(
            mode="median", range=(2, 3),
            note="实际占用体积 = 长方体累计总体积 − 2~3 m³（取中位数 2.5 m³）。"
                 "扣减的由来是卷与卷之间并非完美网格堆叠，边界余量堆不到满箱；"
                 "每单只扣一次，不随卷数放大。",
        ),

        piece_metrics=[
            # 启用贸易术语时，单卷价取主术语（含税）；否则取 EXW 价链输出。
            # 这样"客户看到的价"与"内部价链"各归其位，且总价始终 = 单卷价 × 卷数。
            FormulaSpec(
                "price_per_piece",
                "main_price_incl if terms_enabled else unit_price * weight_per_piece_kg",
                2, False,
                "单卷售价(元/卷)", "Price per Roll (CNY)", "元/卷",
                "单卷售价 = 单价(元/kg) × 单卷净重。"
                "启用贸易术语时取主术语（含税）单件价，否则取 EXW 价链输出。",
            ),
            FormulaSpec("price_per_meter", "price_per_piece / roll_len_m", 4, False,
                        "单价(元/米)", "Unit Price (CNY/m)", "元/米",
                        "每米价 = 单卷售价 ÷ 卷长。与单卷价同源，"
                        "因此「每米价 × 总米数」与「单卷价 × 卷数」必然相等。"),
            FormulaSpec("price_per_piece_fx", "price_per_piece / fx_rate", 4, False,
                        "单卷美元售价(USD/卷)", "Price per Roll (USD/roll)", "USD/卷",
                        "外币价由**已展示的人民币单卷价**除以汇率得到，"
                        "保证客户拿表上数字复算一致。"),
        ],

        order_metrics=[
            FormulaSpec("pieces", "total / roll_len_m", 0, True,
                        "卷数", "Rolls", "卷",
                        "卷数 = 订单总长度 ÷ 每卷长度。"
                        "全丝2.5 每卷 50 米、其余每卷 100 米，故卷数随丝径方案变化。"),
            FormulaSpec("total_net_weight_kg", "pieces * weight_per_piece_kg", 4, False,
                        "总净重(kg)", "Total Net Weight (kg)", "kg",
                        "总净重 = 单卷净重（落定值）× 卷数。"),
            FormulaSpec("volume_box_m3", "pieces * volume_box_per_piece_m3", 4, False,
                        "长方体总体积(m³)", "Total Box Volume (m³)", "m³",
                        "长方体总体积 = 单卷**外接长方体**体积（落定值）× 卷数，"
                        "即全部卷按方柱直接累加、**尚未扣减**的体积。"),
            FormulaSpec("volume_effective_m3", "volume_box_m3 - space_deduction", 4, False,
                        "实际占用体积(m³)", "Effective Occupied Volume (m³)", "m³",
                        "实际占用体积 = 长方体总体积 − 空间扣减（本项目取中位数 2.5 m³）。"
                        "这是对外报运价/报关用的体积，与「长方体总体积」是两个口径，"
                        "不要把未扣减的总体积报给货代。",
                        ),
            FormulaSpec("total_price", "pieces * price_per_piece", 2, False,
                        "总售价(元)", "Total Price (CNY)", "元",
                        "总售价 = 单卷售价 × 卷数，严格满足「单价 × 数量 = 总价」。"),
            FormulaSpec("total_price_fx", "pieces * price_per_piece_fx", 4, False,
                        "总美元售价(USD)", "Total Price (USD)", "USD",
                        "总美元售价 = 单卷美元售价 × 卷数。"),
        ],

        invariants=[
            Invariant("总价 = 单件价 × 件数",
                      "total_price == round(pieces * price_per_piece, 2)"),
            Invariant("总价 = 每米价 × 总米数",
                      "total_price == round(price_per_meter * total, 2)"),
            Invariant("总重 = 单卷重 × 卷数",
                      "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)"),
            Invariant("长方体总体积 = 单卷长方体体积 × 卷数",
                      "volume_box_m3 == round(pieces * volume_box_per_piece_m3, 4)"),
            Invariant("单卷净体积 = π/4 × 卷径² × 网高（圆柱体）",
                      "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * height_m, 4)"),
            Invariant("单卷长方体体积 = 卷径² × 网高（外接方柱）",
                      "volume_box_per_piece_m3 == round(roll_dia_m**2 * height_m, 4)"),
            Invariant("实际占用 = 总体积 − 扣减",
                      "volume_effective_m3 == round(volume_box_m3 - space_deduction, 4)"),
            Invariant("总外币价 = 单卷外币价 × 卷数",
                      "total_price_fx == round(pieces * price_per_piece_fx, 4)"),
            Invariant("单卷外币价 = 人民币价 ÷ 汇率",
                      "price_per_piece_fx == round(price_per_piece / fx_rate, 4)"),
            Invariant("零税率时销项税额为 0",
                      "output_vat_rate_used != 0 or output_vat == 0"),
            Invariant("含税售价 = 不含税售价 + 销项税额",
                      "quote_incl_vat == round(quote_excl_vat + output_vat, 4)"),
            Invariant("进项税额 = 含税采购价 − 税前成本",
                      "input_vat == round(cost_incl - cost_pretax, 4)"),
            Invariant("可退进项增值税税额 = 进项税额 × 可退税比例",
                      "refundable_input_vat == round(input_vat * refund_ratio_used, 4)"),
            Invariant("不可退进项税额 = 进项税额 − 可退进项增值税税额",
                      "non_refundable_input_vat == round(input_vat - refundable_input_vat, 4)"),
            Invariant("让利额 = 可退进项增值税税额 × 让利比例",
                      "give_amount == round(refundable_input_vat * give_ratio, 4)"),
            Invariant("自留可退税额 = 可退进项增值税税额 − 让利额",
                      "retained_refundable == round(refundable_input_vat - give_amount, 4)"),
            Invariant("印花税 = 加工利润 × 印花税率",
                      "stamp_base != 'profit' or stamp_duty == round(profit_amount * stamp_rate, 4)"),
            Invariant("应缴增值税 = max(0, 销项税额 − 可退进项增值税税额)",
                      "vat_payable == round(max(0, output_vat - refundable_input_vat), 4)"),
            Invariant("可退/留抵 = max(0, 可退进项增值税税额 − 销项税额)",
                      "vat_carryforward == round(max(0, refundable_input_vat - output_vat), 4)"),
            Invariant(
                "不含税售价 = 成本 + 利润 + 不可退进项税额 + 自留可退税额 + 印花税",
                "quote_excl_vat == round(cost_pretax + profit_amount"
                " + non_refundable_input_vat + retained_refundable + stamp_duty, 4)",
            ),
        ],

        columns=[
            Column("index", "序号", "No.", 0, width=6),
            Column("spec.product_name", "产品", "Product", width=10),
            Column("spec.height_m", "网高(m)", "Net Height (m)", width=10),
            Column("derived.mesh_cm", "竖丝间距(cm)", "Vertical Wire Spacing (cm)", width=14),
            Column("derived.wire_count", "横丝数(根)", "No. of Horizontal Wires", width=12),
            Column("spec.wire", "丝径方案", "Wire Diameter Option", width=18),
            Column("spec.de", "边丝径(mm)", "Edge Wire Dia. (mm)", width=12),
            Column("spec.dm", "内横丝径(mm)", "Inner Horizontal Wire Dia. (mm)", width=15),
            Column("spec.dv", "竖丝径(mm)", "Vertical Wire Dia. (mm)", width=12),
            Column("spec.wave", "工艺", "Wave Bend", width=10),
            Column("spec.surface_treatment", "表面处理", "Surface Treatment", width=10),
            Column("spec.coating", "镀锌量", "Zinc Coating", width=18),
            Column("spec.packing", "包装", "Packing", width=10),
            Column("spec.roll_len_m", "卷长(m/卷)", "Roll Length (m/roll)", width=12),
            Column("derived.roll_dia_cm", "卷径(cm)", "Roll Diameter (cm)", width=11),
            Column("derived.edge_weight_kg", "单卷边丝重(kg)",
                   "Edge Wire Weight per Roll (kg)", 4, width=15),
            Column("derived.weight_per_piece_kg", "单卷净重(kg)",
                   "Net Weight per Roll (kg)", 4, width=14),
            Column("derived.volume_per_piece_m3", "单卷净体积(m³)",
                   "Net Volume per Roll (m³)", 4, width=15),
            Column("derived.volume_box_per_piece_m3", "单卷长方体体积(m³)",
                   "Box Volume per Roll (m³)", 4, width=16),
            # 单卷售价 / 总价由引擎按「主术语 × 订单」注入（见 engine 的术语注入规则）
            Column("piece.price_per_piece", "单卷售价(元/卷)", "Price per Roll (CNY)", 2, width=14),
            Column("piece.price_per_meter", "单价(元/米)", "Unit Price (CNY/m)", 4, width=12),
            Column("piece.price_per_piece_fx", "单卷美元售价(USD/卷)",
                   "Price per Roll (USD/roll)", 4, width=16),
            # 内部列：成本与税链推导，客户视图自动剔除
            Column("price.cost_pretax", "税前成本(元/kg)", None, 4, internal=True, width=14),
            Column("price.cost_incl", "含税采购价(元/kg)", None, 4, internal=True, width=16),
            Column("price.profit_amount", "加工利润(元/kg)", None, 4, internal=True, width=14),
            Column("price.pretax_quote", "税前报价(元/kg)", None, 4, internal=True, width=14),
            Column("price.base_quote", "基础报价(元/kg)", None, 4, internal=True, width=14),
            Column("price.input_vat", "进项税额(元/kg)", None, 4, internal=True, width=14),
            Column("price.refund_ratio_used", "可退税比例", None, 6, internal=True, width=12),
            Column("price.refundable_input_vat", "可退进项增值税税额(元/kg)",
                   None, 4, internal=True, width=20),
            Column("price.non_refundable_input_vat", "不可退进项税额(元/kg)",
                   None, 4, internal=True, width=18),
            Column("price.give_amount", "让利额(元/kg)", None, 4, internal=True, width=13),
            Column("price.retained_refundable", "自留可退税额(元/kg)",
                   None, 4, internal=True, width=17),
            Column("price.stamp_duty", "印花税(元/kg)", None, 4, internal=True, width=13),
            Column("price.quote_excl_vat", "不含税售价(元/kg)", None, 4, internal=True, width=16),
            Column("price.output_vat_rate_used", "销项税率", None, 4, internal=True, width=10),
            Column("price.output_vat", "销项税额(元/kg)", None, 4, internal=True, width=14),
            Column("price.quote_incl_vat", "含税售价(元/kg)", None, 4, internal=True, width=15),
            Column("price.vat_payable", "应缴增值税(元/kg)", None, 4, internal=True, width=15),
            Column("price.refund_receivable", "可退/留抵税额(元/kg)",
                   None, 4, internal=True, width=17),
        ],

        params=[
            ["原材料税前成本", "4.4（普锌）/ 5.6（重镀锌）", "元/kg",
             "客户给定口径：已含 0.1 元/kg 加工利润，故税前成本为 4.4 / 5.6"],
            ["加工利润", 0.1, "元/kg", "100 元/t，全表仅计一次"],
            ["进项票税点", 0.10, "比例", "丝厂开票 10 个点；含税采购价 = 税前成本 ÷ 0.9"],
            ["印花税率", 0.05, "比例", "按加工利润计征（该值来自税务档案，可覆盖）"],
            ["横丝（径丝）根数", HORIZONTAL_WIRE_COUNT, "根", "重量公式中的 n"],
            ["波弯款增重", WAVE_ADD_PER_100M, "kg/100m", "100 米卷 +3kg、50 米卷 +1.5kg"],
            ["占用空间扣减", 2.5, "m³",
             "每卷按**长方体**累计后扣减 2~3 m³，取中位数 2.5；每单只扣一次"],
            ["卷径", "30（100米卷）/ 25（50米卷）", "cm",
             "随丝径方案联动的默认值；可用 variant_overrides 覆盖"],
        ],

        notes=[
            "1. 整卷净重(kg) = 0.00617 × L × [2·d边² + (n−2)·d横² + d竖² × "
            "(w + (n−1)×50) / s]；L=卷长(m)，n=横丝根数，w=网高(mm)，"
            "s=竖丝间距(mm)，(n−1)×50 为铰接结每道缠绕余量(mm)。",
            "2. 边丝重量(kg) = 0.01234 × L × d边²（两侧边丝合计）。",
            "3. 波弯款在无波款基础上每 100 米增加 3kg。",
            "4. 体积分两个口径：**单卷净体积**按实际圆柱体计 = π/4 × 卷径² × 网高；"
            "**单卷长方体体积**按外接方柱计 = 卷径² × 网高。"
            "总实际占用体积 = 长方体体积 × 卷数 − 2.5m³（每单只扣一次），"
            "这是对外报运价/报关用的口径。",
            "5. 卷径随丝径方案联动（100 米卷 30cm、50 米卷 25cm），"
            "如需按实际装箱重设，用 variant_overrides 覆盖，不必改产品定义。",
            "5. 销项增值税为价外税：税额 = 不含税售价 × 销项税率"
            "（基数是售价，不是成本）。出口零税率时税额为 0。",
            "6. 退税退的是进项增值税额；可退进项增值税税额 = 进项税额 × "
            "(出口退税率 ÷ 征税率)，差额为不可退进项税额，属实际成本。",
            "7. 单卷售价 = 单价 × 单卷净重；总售价 = 单卷售价 × 卷数；"
            "严格满足 单价 × 数量 = 总价。",
            "8. 表面处理均为热镀锌，包装均为无包装，网孔分布均为拧编型上疏下密"
            "（横丝间距上疏下密，不参与重量与计价）。",
        ],
    )


def order_specs(totals=(30000, 50000)) -> list[OrderSpec]:
    """牛栏网常用订单量方案。"""
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
