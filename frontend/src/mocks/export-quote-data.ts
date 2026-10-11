/** 
 * 出口报价 mock 数据（task-11 · M1 最小集 · P0）
 *
 * ## 为什么这个文件不在 `mocks/data/` 下（**别挪回去**）
 *
 * `.gitignore:53` 是一条**裸的 `data/`**，在 git 里它匹配**任意层级**的 `data` 目录
 * ⇒ `frontend/src/mocks/data/` 下的**新文件会被静默忽略**，`git status` 里根本看不到，
 * 提交时无声漏掉、而 import 会在别人机器上崩。
 * （`mocks/data/factory.ts` 之所以没事，只是因为它在 .gitignore 加这条之前就已被跟踪 ——
 * git 只忽略**未跟踪**文件。）
 * 本任务的写入范围只有 `frontend/src/mocks/**`，改 `.gitignore` 不在范围内，
 * 因此**放在被忽略目录之外**。建议另开一项把 `.gitignore:53` 从 `data/` 收窄成 `/data/`。
 *
 * ## 这些数据从哪来（**不是手编的**）
 *
 * | 数据 | 真源 |
 * |---|---|
 * | `MOCK_EXPORT_PRODUCTS` | `backend/orchestrator/app/services/export_quote/products/` 注册表，字段照 `app/api/export_quote.py:196-218` 的响应构造 |
 * | `MOCK_EXPORT_FORMULAS` | 上面每个产品经 `services/export_quote/formulas.py:245 describe_product(spec, with_columns=True)` 的真实输出 |
 * | `MOCK_EXPORT_RATE_SETS` | `rate_sets/CN-2026-09.json` + `app/api/export_quote.py:437-455` 的字段映射 |
 * | `MOCK_EXPORT_TERMS_TEMPLATE` | `services/export_quote/terms_template.py:42-112`（逐字，含 5 个费用项与 EXW→FOB→CFR→CIF 阶梯） |
 *
 * 生成方式：2026-10-11 用只读脚本调后端自己的注册表/描述函数导出（脚本在仓库外），
 * 因此**字段名与数值都来自后端真源**，不是照着文档猜的。
 *
 * 两处**刻意删掉的字段**（后端多回、但前端契约 `@contracts/export-quote` 未声明，
 * 也没有任何页面读它们）：`/products` 的 `metric_count` / `invariant_count`
 * （见 `app/api/export_quote.py:213-215`）。契约里没有的类型写进 TS 会报多余属性，
 * 且页面不读 —— 需要时应先加进 `shared/contracts/export-quote.ts`。
 *
 * ## ⚠️ 两处**真实的契约错位**（用后端真源生成 ⇒ 被 `tsc` 暴露出来）
 *
 * 本文件刻意**不做美化**去迁就类型，而是如实保留后端形状 + 显式 `as unknown as` 收窄，
 * 并在下面标出。两者都**不是 mock 的问题**，是契约本身的问题；修它要先改
 * `shared/contracts/export-quote.ts`（本任务只允许写 `frontend/src/mocks/**`，故未改）。
 *
 * 1. **`ExportProduct.params`**：契约写 `z.record(z.unknown())`（**对象**，
 *    `shared/contracts/export-quote.ts:229`），但后端实际回的是
 *    **二维数组** `[[参数, 取值, 单位, 说明], …]`（`models.py:215` 的字段注释 + 真实输出）。
 *    同一份契约里的 `ProductFormulasResponse.params` 反而是**数组**
 *    （`:581`），两处同名不同类型的字段。
 * 2. **`ProductFormulasResponse.pricing_key[].ui_unit` / `ui_scale`**：契约用
 *    zod `.default('')` / `.default(1)` 声明（`:486-487`）——zod 的 `.default()` 是
 *    "输入可选、**输出必填**"，于是 TS 类型要求这两个键，而后端 `describe_product`
 *    **不产出**它们。全前端对这份契约只用 `import type`（唯一的 `.parse()` 在
 *    `lib/form/__tests__/contracts-export-quote.test.ts:369`，且那份 fixture
 *    **根本没有 `pricing_key`**）⇒ 类型在撒谎，运行时是 `undefined`。
 *
 * 以上两条建议单开一项改契约；本文件的测试会**钉住真实形状**，避免有人靠改 mock 掩盖。
 */
import type {
  ExportProduct,
  ExportRateSet,
  ExportTermsTemplate,
  ProductFormulasResponse,
} from "@contracts/export-quote";


export const MOCK_EXPORT_PRODUCTS = [
  {
    "key": "chain_link",
    "name": "勾花网",
    "name_en": "Chain Link Fence",
    "category_code": "gouhuawang",
    "combo_count": 0,
    "spec_summary": "coating(0)",
    "hs_codes": [
      "7314490000"
    ],
    "cost_basis": "pretax",
    "cost_unit": "CNY/㎡",
    "params": [
      [
        "原料进货成本",
        "客户每单填写",
        "元/㎡",
        "**按面积**计价的单位价（表格口径）。每天变动，由客户在报价时填"
      ],
      [
        "重量经验系数",
        "1.28",
        "—",
        "表格公式 `d² × 1.28 ÷ S × W × L` 里的系数，逐字照搬"
      ],
      [
        "占用空间扣减比例",
        "0.04（= 装柜系数 0.96）",
        "比例",
        "取值来源：智能表格 21 行的装柜系数实测值 0.96"
      ],
      [
        "表面处理档位",
        "由客户自行添加",
        "—",
        "本产品**不预置**任何档位（用户裁决）。客户在「定价数据」里加档位后即可报价"
      ]
    ]
  },
  {
    "key": "deer_net",
    "name": "鹿网",
    "name_en": "Deer Net",
    "category_code": "luwang",
    "combo_count": 0,
    "spec_summary": "coating(0)",
    "hs_codes": [
      "7314410000"
    ],
    "cost_basis": "pretax",
    "cost_unit": "CNY/kg",
    "params": [
      [
        "原料进货成本",
        "客户每单填写",
        "元/kg",
        "按**重量**计价（表格的成本公式：除勾花网外都按重量）"
      ],
      [
        "宽度偏置",
        80,
        "mm",
        "表格公式里的 (W×1000 + 80)，经验常数，原样照搬"
      ],
      [
        "拧花系数",
        140,
        "—",
        "表格公式里的 (N−2) × 140 × Dt²/(S×10)，鹿网特有，原样照搬"
      ],
      [
        "占用空间扣减比例",
        "0.04（= 装柜系数 0.96）",
        "比例",
        "取值来源：智能表格 21 行的装柜系数实测值 0.96"
      ],
      [
        "表面处理档位",
        "由客户自行添加",
        "—",
        "本产品**不预置**任何档位（用户裁决）"
      ]
    ]
  },
  {
    "key": "field_fence",
    "name": "牛栏网",
    "name_en": "Field Fence",
    "category_code": "niulanwang",
    "combo_count": 10,
    "spec_summary": "coating(5) × wave(2)",
    "hs_codes": [
      "7314410000"
    ],
    "cost_basis": "pretax",
    "cost_unit": "CNY/kg",
    "params": [
      [
        "原材料税前成本",
        "4.4（普锌）/ 5.6（重镀锌）",
        "元/kg",
        "客户给定口径：已含 0.1 元/kg 加工利润，故税前成本为 4.4 / 5.6"
      ],
      [
        "加工利润",
        0.1,
        "元/kg",
        "100 元/t，全表仅计一次"
      ],
      [
        "进项票税点",
        0.1,
        "比例",
        "丝厂开票 10 个点；含税采购价 = 税前成本 ÷ 0.9"
      ],
      [
        "印花税率",
        0.05,
        "比例",
        "按加工利润计征（该值来自税务档案，可覆盖）"
      ],
      [
        "横丝（径丝）根数",
        "默认 10（可改）",
        "根",
        "重量公式中的 n。现在是**自由数值参数**，客户可填任意值"
      ],
      [
        "波弯款增重",
        3,
        "kg/100m",
        "100 米卷 +3kg、50 米卷 +1.5kg"
      ],
      [
        "占用空间扣减比例",
        "0.04（= 装柜系数 0.96）",
        "比例",
        "实际占用 = 长方体总体积 × (1 − 0.04)。按**比例**而非固定 m³ —— 固定值在小单上会算出负体积（实测 < 2314 米时为负）。取值来源：智能表格「明细表」21 行的装柜系数实测值 0.96；与工厂经验一致（满柜约 68 m³ × 4% = 2.72 m³，落在「2~3 m³」内）"
      ],
      [
        "卷径 / 卷长",
        "默认 30cm / 100m（可改）",
        "cm / m",
        "**自由数值参数**，客户按实际装箱填；不再与丝径方案联动"
      ]
    ]
  }
] as unknown as ExportProduct[]; // 见文件头「契约错位 #1」（params 后端是数组）

/** 每个注册产品的真实 `describe_product(..., with_columns=True)` 输出。 */
export const MOCK_EXPORT_FORMULAS = {
  "chain_link": {
    "product_key": "chain_link",
    "name": "勾花网",
    "name_en": "Chain Link Fence",
    "category_code": "gouhuawang",
    "hs_codes": [
      "7314490000"
    ],
    "cost": {
      "field": "raw_price",
      "basis": "pretax",
      "unit": "CNY/㎡",
      "note": "税前成本：给的是「已含加工利润的含税价」时要用 incl_tax，引擎会按进项票税点还原为税前成本；给的是税前价则用 pretax。"
    },
    "space": {
      "axes": [],
      "variants": [
        {
          "name": "coating",
          "label": "表面处理",
          "label_en": "Surface Treatment",
          "kind": "variant",
          "options": []
        }
      ],
      "combo_count": 0,
      "summary": "coating(0)",
      "formula": "表面处理(0)"
    },
    "piece_inputs": [],
    "numeric_inputs": [
      {
        "key": "d",
        "label": "丝径/线径(mm)",
        "label_en": "Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.5",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "重量公式里的 d（表格「丝径/线径」）。"
      },
      {
        "key": "mesh_cm",
        "label": "网孔/刺尖间距(cm)",
        "label_en": "Mesh Opening (cm)",
        "unit": "cm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "5",
        "min_value": "0.5",
        "max_value": "50",
        "decimals": 2,
        "note": "重量公式里的 S（表格「网孔/刺尖间距」）。"
      },
      {
        "key": "width_m",
        "label": "宽度(m)",
        "label_en": "Width (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "1.8",
        "min_value": "0.1",
        "max_value": "6",
        "decimals": 3,
        "note": "重量公式里的 W；体积口径也按它算。"
      },
      {
        "key": "len_m",
        "label": "单件长度(m)",
        "label_en": "Length per Piece (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "10",
        "min_value": "0.1",
        "max_value": "100",
        "decimals": 3,
        "note": "重量公式里的 L；也是每件的米数。"
      },
      {
        "key": "roll_dia_m",
        "label": "卷径",
        "label_en": "Roll Diameter",
        "unit": "m",
        "ui_unit": "公分",
        "ui_scale": 100,
        "default": "0.3",
        "min_value": "0.05",
        "max_value": "2",
        "decimals": null,
        "note": "决定体积（π/4 × 卷径² × 宽度），是对外报运价/报关的口径。"
      }
    ],
    "pricing_key": [
      {
        "field": "d",
        "label": "丝径/线径",
        "unit": "mm",
        "kind": "numeric",
        "options": [],
        "ui_unit": "",
        "ui_scale": 1.0
      },
      {
        "field": "coating_code",
        "label": "表面处理",
        "unit": "",
        "kind": "variant",
        "options": []
      }
    ],
    "calculations": {
      "derived": [
        {
          "code": "area_per_piece_m2",
          "stage": "derived",
          "label": "单件面积(㎡)",
          "label_en": "Area per Piece (m²)",
          "unit": "㎡",
          "expr": "len_m * width_m",
          "decimals": 4,
          "integer": false,
          "note": "单件面积 = 单件长度 × 宽度。**成本按面积算**（表格口径），所以它是勾花网的关键中间量，不是副产品。"
        },
        {
          "code": "weight_per_piece_kg",
          "stage": "derived",
          "label": "单件重量(kg)",
          "label_en": "Weight per Piece (kg)",
          "unit": "kg",
          "expr": "d**2 * wire_factor / mesh_cm * width_m * len_m",
          "decimals": 4,
          "integer": false,
          "note": "单件重量 = d² × 1.28 ÷ S × W × L（表格公式逐字照搬）。d=丝径(mm)、S=网孔间距(cm)、W=宽度(m)、L=单件长度(m)。1.28 是表格里的经验系数。"
        },
        {
          "code": "volume_per_piece_m3",
          "stage": "derived",
          "label": "单件净体积(m³)",
          "label_en": "Net Volume per Piece (m³)",
          "unit": "m³",
          "expr": "pi / 4 * roll_dia_m**2 * width_m",
          "decimals": 4,
          "integer": false,
          "note": "按**实际圆柱体**计：π/4 × 卷径² × 宽度（钢材本身占的体积）。"
        },
        {
          "code": "volume_box_per_piece_m3",
          "stage": "derived",
          "label": "单件长方体体积(m³)",
          "label_en": "Box Volume per Piece (m³)",
          "unit": "m³",
          "expr": "roll_dia_m**2 * width_m",
          "decimals": 4,
          "integer": false,
          "note": "按**外接长方体**计：卷径² × 宽度。堆码/报运价用这个口径。"
        }
      ],
      "piece": [
        {
          "code": "price_per_piece",
          "stage": "piece",
          "label": "单件售价(元/件)",
          "label_en": "Price per Piece (CNY)",
          "unit": "元/件",
          "expr": "main_price_incl if terms_enabled else unit_price * area_per_piece_m2",
          "decimals": 2,
          "integer": false,
          "note": "单件售价 = 单位价(元/㎡) × **单件面积**。勾花网的成本与售价都按面积计（表格口径），不是按重量。启用贸易术语时取主术语（含税）单件价。"
        },
        {
          "code": "price_per_m2",
          "stage": "piece",
          "label": "单价(元/㎡)",
          "label_en": "Unit Price (CNY/m²)",
          "unit": "元/㎡",
          "expr": "price_per_piece / area_per_piece_m2",
          "decimals": 4,
          "integer": false,
          "note": "每平方米价 = 单件售价 ÷ 单件面积，与单件价同源。"
        },
        {
          "code": "price_per_piece_fx",
          "stage": "piece",
          "label": "单件美元售价(USD/件)",
          "label_en": "Price per Piece (USD)",
          "unit": "USD/件",
          "expr": "price_per_piece / fx_rate",
          "decimals": 4,
          "integer": false,
          "note": "外币价由**已展示的人民币件价**除以汇率得到，保证客户拿表上数字复算一致。"
        }
      ],
      "order": [
        {
          "code": "pieces",
          "stage": "order",
          "label": "件数",
          "label_en": "Pieces",
          "unit": "件",
          "expr": "total / len_m",
          "decimals": 0,
          "integer": true,
          "note": "件数 = 订单总长度 ÷ 单件长度。"
        },
        {
          "code": "total_net_weight_kg",
          "stage": "order",
          "label": "总净重(kg)",
          "label_en": "Total Net Weight (kg)",
          "unit": "kg",
          "expr": "pieces * weight_per_piece_kg",
          "decimals": 4,
          "integer": false,
          "note": "总净重 = 单件净重（落定值）× 件数。"
        },
        {
          "code": "total_area_m2",
          "stage": "order",
          "label": "总面积(㎡)",
          "label_en": "Total Area (m²)",
          "unit": "㎡",
          "expr": "pieces * area_per_piece_m2",
          "decimals": 4,
          "integer": false,
          "note": "总面积 = 单件面积 × 件数。"
        },
        {
          "code": "volume_box_m3",
          "stage": "order",
          "label": "长方体总体积(m³)",
          "label_en": "Total Box Volume (m³)",
          "unit": "m³",
          "expr": "pieces * volume_box_per_piece_m3",
          "decimals": 4,
          "integer": false,
          "note": "长方体总体积 = 单件**外接长方体**体积（落定值）× 件数，尚未扣减。"
        },
        {
          "code": "volume_effective_m3",
          "stage": "order",
          "label": "实际占用体积(m³)",
          "label_en": "Effective Occupied Volume (m³)",
          "unit": "m³",
          "expr": "volume_box_m3 * (1 - space_deduction_ratio) - space_deduction",
          "decimals": 4,
          "integer": false,
          "note": "实际占用体积 = 长方体总体积 × (1 − 扣减比例)。按比例而非固定扣减 —— 固定值在小单上会算出负体积。这是对外报运价/报关的口径。"
        },
        {
          "code": "total_price",
          "stage": "order",
          "label": "总售价(元)",
          "label_en": "Total Price (CNY)",
          "unit": "元",
          "expr": "pieces * price_per_piece",
          "decimals": 2,
          "integer": false,
          "note": "总售价 = 单件售价 × 件数，严格满足「单价 × 数量 = 总价」。"
        },
        {
          "code": "total_price_fx",
          "stage": "order",
          "label": "总美元售价(USD)",
          "label_en": "Total Price (USD)",
          "unit": "USD",
          "expr": "pieces * price_per_piece_fx",
          "decimals": 4,
          "integer": false,
          "note": "总美元售价 = 单件美元售价 × 件数。"
        }
      ]
    },
    "space_deduction": {
      "mode": "ratio",
      "value": "0.04",
      "range": null,
      "expr": "",
      "note": "实际占用体积 = 长方体累计总体积 × (1 − 扣减比例)，即 × 装柜系数 0.96。取值来源：智能表格「明细表」21 行的装柜系数实测值 0.96。按比例而非固定 m³ —— 固定值不随数量缩放，小单会算出负体积。"
    },
    "invariants": [
      {
        "label": "总价 = 单件价 × 件数",
        "expr": "total_price == round(pieces * price_per_piece, 2)",
        "severity": "error"
      },
      {
        "label": "单件重量 = d² × 1.28 ÷ S × W × L",
        "expr": "weight_per_piece_kg == round(d**2 * wire_factor / mesh_cm * width_m * len_m, 4)",
        "severity": "error"
      },
      {
        "label": "单件面积 = 单件长度 × 宽度",
        "expr": "area_per_piece_m2 == round(len_m * width_m, 4)",
        "severity": "error"
      },
      {
        "label": "总重 = 单件重 × 件数",
        "expr": "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)",
        "severity": "error"
      },
      {
        "label": "总面积 = 单件面积 × 件数",
        "expr": "total_area_m2 == round(pieces * area_per_piece_m2, 4)",
        "severity": "error"
      },
      {
        "label": "实际占用 = 总体积 × (1 − 扣减比例)",
        "expr": "volume_effective_m3 == round(volume_box_m3 * (1 - space_deduction_ratio) - space_deduction, 4)",
        "severity": "error"
      },
      {
        "label": "单件净体积 = π/4 × 卷径² × 宽度（圆柱体）",
        "expr": "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * width_m, 4)",
        "severity": "error"
      },
      {
        "label": "单件长方体体积 = 卷径² × 宽度（外接方柱）",
        "expr": "volume_box_per_piece_m3 == round(roll_dia_m**2 * width_m, 4)",
        "severity": "error"
      },
      {
        "label": "零税率时销项税额为 0",
        "expr": "output_vat_rate_used != 0 or output_vat == 0",
        "severity": "error"
      }
    ],
    "params": [
      {
        "name": "原料进货成本",
        "value": "客户每单填写",
        "unit": "元/㎡",
        "note": "**按面积**计价的单位价（表格口径）。每天变动，由客户在报价时填"
      },
      {
        "name": "重量经验系数",
        "value": "1.28",
        "unit": "—",
        "note": "表格公式 `d² × 1.28 ÷ S × W × L` 里的系数，逐字照搬"
      },
      {
        "name": "占用空间扣减比例",
        "value": "0.04（= 装柜系数 0.96）",
        "unit": "比例",
        "note": "取值来源：智能表格 21 行的装柜系数实测值 0.96"
      },
      {
        "name": "表面处理档位",
        "value": "由客户自行添加",
        "unit": "—",
        "note": "本产品**不预置**任何档位（用户裁决）。客户在「定价数据」里加档位后即可报价"
      }
    ],
    "notes": [
      "1. 单件重量(kg) = d² × 1.28 ÷ S × W × L；d=丝径/线径(mm)，S=网孔/刺尖间距(cm)，W=宽度(m)，L=单件长度(m)。该公式取自智能表格的公式字段，并用表里 3 行真实数据核对过（28.8 / 34.56 / 69.12 kg）。",
      "2. **成本与售价都按面积**：单件成本 = 单件长度 × 宽度 × 单位价(元/㎡)，单件售价 = 单件成本 ÷ (1 − 利润率 − 综合税费系数)。这与牛栏网（按重量）是两种口径，不要混用。",
      "3. 表面处理档位**由客户自行添加**：产品定义里不预置任何档位，客户在「定价数据」里加到档位后，该档位会并入规格空间，规格接口与算价接口共用同一份，不会出现「能选不能算」。",
      "4. 体积分两个口径：单件净体积按实际圆柱体 = π/4 × 卷径² × 宽度；单件长方体体积按外接方柱 = 卷径² × 宽度。总实际占用体积 = 长方体体积 × 件数 × 装柜系数 0.96。"
    ],
    "constants": {
      "product_name": "勾花网",
      "product_name_en": "Chain Link Fence",
      "packing": "无包装",
      "packing_en": "No packing",
      "wire_factor": "1.28",
      "pi": "3.14159265358979323846"
    },
    "columns": [
      {
        "key": "index",
        "label": "序号",
        "label_en": "No.",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.product_name",
        "label": "产品",
        "label_en": "Product",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.d",
        "label": "丝径/线径(mm)",
        "label_en": "Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.mesh_cm",
        "label": "网孔/刺尖间距(cm)",
        "label_en": "Mesh Opening (cm)",
        "decimals": 2,
        "internal": false
      },
      {
        "key": "spec.width_m",
        "label": "宽度(m)",
        "label_en": "Width (m)",
        "decimals": 3,
        "internal": false
      },
      {
        "key": "spec.len_m",
        "label": "单件长度(m)",
        "label_en": "Length per Piece (m)",
        "decimals": 3,
        "internal": false
      },
      {
        "key": "spec.roll_dia_m",
        "label": "卷径(m)",
        "label_en": "Roll Diameter (m)",
        "decimals": 3,
        "internal": false
      },
      {
        "key": "spec.coating",
        "label": "表面处理",
        "label_en": "Surface Treatment",
        "decimals": null,
        "internal": false
      },
      {
        "key": "derived.area_per_piece_m2",
        "label": "单件面积(㎡)",
        "label_en": "Area per Piece (m²)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.weight_per_piece_kg",
        "label": "单件重量(kg)",
        "label_en": "Weight per Piece (kg)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_per_piece_m3",
        "label": "单件净体积(m³)",
        "label_en": "Net Volume per Piece (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_box_per_piece_m3",
        "label": "单件长方体体积(m³)",
        "label_en": "Box Volume per Piece (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece",
        "label": "单件售价(元/件)",
        "label_en": "Price per Piece (CNY)",
        "decimals": 2,
        "internal": false
      },
      {
        "key": "piece.price_per_m2",
        "label": "单价(元/㎡)",
        "label_en": "Unit Price (CNY/m²)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece_fx",
        "label": "单件美元售价(USD/件)",
        "label_en": "Price per Piece (USD)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "price.cost_pretax",
        "label": "税前成本(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.cost_incl",
        "label": "含税采购价(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.profit_amount",
        "label": "加工利润(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_excl_vat",
        "label": "不含税售价(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat_rate_used",
        "label": "销项税率",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat",
        "label": "销项税额(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_incl_vat",
        "label": "含税售价(元/㎡)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      }
    ]
  },
  "deer_net": {
    "product_key": "deer_net",
    "name": "鹿网",
    "name_en": "Deer Net",
    "category_code": "luwang",
    "hs_codes": [
      "7314410000"
    ],
    "cost": {
      "field": "raw_price",
      "basis": "pretax",
      "unit": "CNY/kg",
      "note": "税前成本：给的是「已含加工利润的含税价」时要用 incl_tax，引擎会按进项票税点还原为税前成本；给的是税前价则用 pretax。"
    },
    "space": {
      "axes": [],
      "variants": [
        {
          "name": "coating",
          "label": "表面处理",
          "label_en": "Surface Treatment",
          "kind": "variant",
          "options": []
        }
      ],
      "combo_count": 0,
      "summary": "coating(0)",
      "formula": "表面处理(0)"
    },
    "piece_inputs": [],
    "numeric_inputs": [
      {
        "key": "de",
        "label": "边丝直径(mm)",
        "label_en": "Edge Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.5",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "重量公式里的 De。"
      },
      {
        "key": "di",
        "label": "内经丝直径(mm)",
        "label_en": "Inner Warp Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.5",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "重量公式里的 Di。"
      },
      {
        "key": "dw",
        "label": "内纬丝直径(mm)",
        "label_en": "Inner Weft Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.5",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "重量公式里的 Dw。"
      },
      {
        "key": "dt",
        "label": "拧花丝径(mm)",
        "label_en": "Twisted Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.0",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "重量公式里的 Dt —— 鹿网特有（拧花）。"
      },
      {
        "key": "n",
        "label": "横丝根数",
        "label_en": "No. of Horizontal Wires",
        "unit": "根",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "10",
        "min_value": "2",
        "max_value": "100",
        "decimals": null,
        "note": "重量公式里的 N。"
      },
      {
        "key": "height_m",
        "label": "宽度(m)",
        "label_en": "Width (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "1.5",
        "min_value": "0.3",
        "max_value": "6",
        "decimals": 2,
        "note": "重量公式里的 W；体积口径也按它算。"
      },
      {
        "key": "mesh_mm",
        "label": "网孔/刺尖间距(mm)",
        "label_en": "Mesh Opening (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "150",
        "min_value": "10",
        "max_value": "1000",
        "decimals": null,
        "note": "重量公式里的 S×10（表里按 cm 填，内部按 mm 算）。"
      },
      {
        "key": "roll_len_m",
        "label": "单件长度(m)",
        "label_en": "Length per Piece (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "100",
        "min_value": "1",
        "max_value": "1000",
        "decimals": null,
        "note": "重量公式里的 L，也是每件的米数。"
      },
      {
        "key": "roll_dia_m",
        "label": "卷径",
        "label_en": "Roll Diameter",
        "unit": "m",
        "ui_unit": "公分",
        "ui_scale": 100,
        "default": "0.3",
        "min_value": "0.05",
        "max_value": "2",
        "decimals": null,
        "note": "决定体积（π/4 × 卷径² × 宽度），报运价/报关口径。"
      }
    ],
    "pricing_key": [
      {
        "field": "de",
        "label": "边丝直径",
        "unit": "mm",
        "kind": "numeric",
        "options": [],
        "ui_unit": "",
        "ui_scale": 1.0
      },
      {
        "field": "coating_code",
        "label": "表面处理",
        "unit": "",
        "kind": "variant",
        "options": []
      }
    ],
    "calculations": {
      "derived": [
        {
          "code": "width_mm",
          "stage": "derived",
          "label": "宽度(mm)",
          "label_en": "Width (mm)",
          "unit": "mm",
          "expr": "height_m * 1000",
          "decimals": null,
          "integer": false,
          "note": "统一到毫米参与重量公式，避免量纲混用。"
        },
        {
          "code": "weight_base_kg",
          "stage": "derived",
          "label": "单件基础净重(kg)",
          "label_en": "Base Net Weight per Piece (kg)",
          "unit": "kg",
          "expr": "0.00617 * roll_len_m * (2*de**2 + di**2*(n-2) + (width_mm + width_bias_mm) * dw**2 / mesh_mm + (n-2) * twist_per_row * dt**2 / mesh_mm)",
          "decimals": null,
          "integer": false,
          "note": "单件重量 = 0.00617 × L × [2·De² + Di²(N−2) + (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]。由表格原式 0.01234 × L × (De² + Di²(N−2)/2 + (W×1000+80)Dw²/(S×10)/2 + (N−2)×140×Dt²/(S×10)/2) 整理而来（0.01234 = 2×0.00617），逐项等价。80 与 140 是表格里的经验常数，原样照搬。"
        },
        {
          "code": "weight_per_piece_kg",
          "stage": "derived",
          "label": "单件净重(kg)",
          "label_en": "Net Weight per Piece (kg)",
          "unit": "kg",
          "expr": "weight_base_kg",
          "decimals": 4,
          "integer": false,
          "note": "按 4 位小数落定后供下游乘件数，以保证表上「单件重 × 件数 = 总重」能对上。"
        },
        {
          "code": "volume_per_piece_m3",
          "stage": "derived",
          "label": "单件净体积(m³)",
          "label_en": "Net Volume per Piece (m³)",
          "unit": "m³",
          "expr": "pi / 4 * roll_dia_m**2 * height_m",
          "decimals": 4,
          "integer": false,
          "note": "按**实际圆柱体**计：π/4 × 卷径² × 宽度。"
        },
        {
          "code": "volume_box_per_piece_m3",
          "stage": "derived",
          "label": "单件长方体体积(m³)",
          "label_en": "Box Volume per Piece (m³)",
          "unit": "m³",
          "expr": "roll_dia_m**2 * height_m",
          "decimals": 4,
          "integer": false,
          "note": "按**外接长方体**计：卷径² × 宽度。堆码/报运价用这个口径。"
        }
      ],
      "piece": [
        {
          "code": "price_per_piece",
          "stage": "piece",
          "label": "单件售价(元/件)",
          "label_en": "Price per Piece (CNY)",
          "unit": "元/件",
          "expr": "main_price_incl if terms_enabled else unit_price * weight_per_piece_kg",
          "decimals": 2,
          "integer": false,
          "note": "单件售价 = 单价(元/kg) × 单件净重。表格的成本公式为 IF(产品=\"勾花网\", L×W×元/㎡, 元/kg×单件重量)，鹿网属后者，**按重量**。"
        },
        {
          "code": "price_per_meter",
          "stage": "piece",
          "label": "单价(元/米)",
          "label_en": "Unit Price (CNY/m)",
          "unit": "元/米",
          "expr": "price_per_piece / roll_len_m",
          "decimals": 4,
          "integer": false,
          "note": "每米价 = 单件售价 ÷ 单件长度。"
        },
        {
          "code": "price_per_piece_fx",
          "stage": "piece",
          "label": "单件美元售价(USD/件)",
          "label_en": "Price per Piece (USD)",
          "unit": "USD/件",
          "expr": "price_per_piece / fx_rate",
          "decimals": 4,
          "integer": false,
          "note": "外币价由已展示的人民币件价除以汇率得到。"
        }
      ],
      "order": [
        {
          "code": "pieces",
          "stage": "order",
          "label": "件数",
          "label_en": "Pieces",
          "unit": "件",
          "expr": "total / roll_len_m",
          "decimals": 0,
          "integer": true,
          "note": "件数 = 订单总长度 ÷ 单件长度。"
        },
        {
          "code": "total_net_weight_kg",
          "stage": "order",
          "label": "总净重(kg)",
          "label_en": "Total Net Weight (kg)",
          "unit": "kg",
          "expr": "pieces * weight_per_piece_kg",
          "decimals": 4,
          "integer": false,
          "note": "总净重 = 单件净重（落定值）× 件数。"
        },
        {
          "code": "volume_box_m3",
          "stage": "order",
          "label": "长方体总体积(m³)",
          "label_en": "Total Box Volume (m³)",
          "unit": "m³",
          "expr": "pieces * volume_box_per_piece_m3",
          "decimals": 4,
          "integer": false,
          "note": "长方体总体积 = 单件外接长方体体积（落定值）× 件数。"
        },
        {
          "code": "volume_effective_m3",
          "stage": "order",
          "label": "实际占用体积(m³)",
          "label_en": "Effective Occupied Volume (m³)",
          "unit": "m³",
          "expr": "volume_box_m3 * (1 - space_deduction_ratio) - space_deduction",
          "decimals": 4,
          "integer": false,
          "note": "实际占用体积 = 长方体总体积 × (1 − 扣减比例)。按比例而非固定扣减 —— 固定值在小单上会算出负体积。"
        },
        {
          "code": "total_price",
          "stage": "order",
          "label": "总售价(元)",
          "label_en": "Total Price (CNY)",
          "unit": "元",
          "expr": "pieces * price_per_piece",
          "decimals": 2,
          "integer": false,
          "note": "总售价 = 单件售价 × 件数。"
        },
        {
          "code": "total_price_fx",
          "stage": "order",
          "label": "总美元售价(USD)",
          "label_en": "Total Price (USD)",
          "unit": "USD",
          "expr": "pieces * price_per_piece_fx",
          "decimals": 4,
          "integer": false,
          "note": "总美元售价 = 单件美元售价 × 件数。"
        }
      ]
    },
    "space_deduction": {
      "mode": "ratio",
      "value": "0.04",
      "range": null,
      "expr": "",
      "note": "实际占用体积 = 长方体累计总体积 × (1 − 扣减比例)，即 × 装柜系数 0.96。取值来源：智能表格「明细表」21 行的装柜系数实测值 0.96。按比例而非固定 m³ —— 固定值不随数量缩放，小单会算出负体积。"
    },
    "invariants": [
      {
        "label": "总价 = 单件价 × 件数",
        "expr": "total_price == round(pieces * price_per_piece, 2)",
        "severity": "error"
      },
      {
        "label": "单件重量 = 0.00617 × L × [2·De² + Di²(N−2) + (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]",
        "expr": "weight_base_kg == 0.00617 * roll_len_m * (2*de**2 + di**2*(n-2) + (width_mm + width_bias_mm) * dw**2 / mesh_mm + (n-2) * twist_per_row * dt**2 / mesh_mm)",
        "severity": "error"
      },
      {
        "label": "总重 = 单件重 × 件数",
        "expr": "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)",
        "severity": "error"
      },
      {
        "label": "实际占用 = 总体积 × (1 − 扣减比例)",
        "expr": "volume_effective_m3 == round(volume_box_m3 * (1 - space_deduction_ratio) - space_deduction, 4)",
        "severity": "error"
      },
      {
        "label": "单件净体积 = π/4 × 卷径² × 宽度（圆柱体）",
        "expr": "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * height_m, 4)",
        "severity": "error"
      },
      {
        "label": "单件长方体体积 = 卷径² × 宽度（外接方柱）",
        "expr": "volume_box_per_piece_m3 == round(roll_dia_m**2 * height_m, 4)",
        "severity": "error"
      },
      {
        "label": "零税率时销项税额为 0",
        "expr": "output_vat_rate_used != 0 or output_vat == 0",
        "severity": "error"
      }
    ],
    "params": [
      {
        "name": "原料进货成本",
        "value": "客户每单填写",
        "unit": "元/kg",
        "note": "按**重量**计价（表格的成本公式：除勾花网外都按重量）"
      },
      {
        "name": "宽度偏置",
        "value": 80,
        "unit": "mm",
        "note": "表格公式里的 (W×1000 + 80)，经验常数，原样照搬"
      },
      {
        "name": "拧花系数",
        "value": 140,
        "unit": "—",
        "note": "表格公式里的 (N−2) × 140 × Dt²/(S×10)，鹿网特有，原样照搬"
      },
      {
        "name": "占用空间扣减比例",
        "value": "0.04（= 装柜系数 0.96）",
        "unit": "比例",
        "note": "取值来源：智能表格 21 行的装柜系数实测值 0.96"
      },
      {
        "name": "表面处理档位",
        "value": "由客户自行添加",
        "unit": "—",
        "note": "本产品**不预置**任何档位（用户裁决）"
      }
    ],
    "notes": [
      "1. 单件重量(kg) = 0.00617 × L × [2·De² + Di²(N−2) + (W×1000+80)·Dw²/(S×10) + (N−2)·140·Dt²/(S×10)]。由表格原式 0.01234 × L × (De² + Di²(N−2)/2 + (W×1000+80)Dw²/(S×10)/2 + (N−2)×140×Dt²/(S×10)/2) 整理而来，逐项等价（0.01234 = 2 × 0.00617）。",
      "2. **本产品没有真实数据可核对**：智能表格 21 行里没有鹿网记录，所以只能对齐**公式本身**（测试里把表格公式原样抄一份逐点比对），无法像牛栏网 / 勾花网那样用表里记录验证。",
      "3. 计价**按重量**：表格的成本公式为 IF(产品 = \"勾花网\", L × W × 元/㎡, 元/kg × 单件重量)，鹿网属后者。勾花网是唯一的按面积产品。",
      "4. 表面处理档位由客户自行添加：产品定义里不预置任何档位，客户在「定价数据」里加档位后即可报价。",
      "5. 体积分两个口径：单件净体积按实际圆柱体 = π/4 × 卷径² × 宽度；单件长方体体积按外接方柱 = 卷径² × 宽度。总实际占用体积 = 长方体体积 × 件数 × 装柜系数 0.96。"
    ],
    "constants": {
      "product_name": "鹿网",
      "product_name_en": "Deer Net",
      "packing": "无包装",
      "packing_en": "No packing",
      "width_bias_mm": 80,
      "twist_per_row": 140,
      "pi": "3.14159265358979323846"
    },
    "columns": [
      {
        "key": "index",
        "label": "序号",
        "label_en": "No.",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.product_name",
        "label": "产品",
        "label_en": "Product",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.de",
        "label": "边丝直径(mm)",
        "label_en": "Edge Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.di",
        "label": "内经丝直径(mm)",
        "label_en": "Inner Warp Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.dw",
        "label": "内纬丝直径(mm)",
        "label_en": "Inner Weft Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.dt",
        "label": "拧花丝径(mm)",
        "label_en": "Twisted Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "derived.width_mm",
        "label": "宽度(mm)",
        "label_en": "Width (mm)",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.n",
        "label": "横丝根数",
        "label_en": "No. of Horizontal Wires",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.mesh_mm",
        "label": "网孔/刺尖间距(mm)",
        "label_en": "Mesh Opening (mm)",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.coating",
        "label": "表面处理",
        "label_en": "Surface Treatment",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.roll_len_m",
        "label": "单件长度(m)",
        "label_en": "Length per Piece (m)",
        "decimals": 3,
        "internal": false
      },
      {
        "key": "spec.roll_dia_m",
        "label": "卷径(m)",
        "label_en": "Roll Diameter (m)",
        "decimals": 3,
        "internal": false
      },
      {
        "key": "derived.weight_per_piece_kg",
        "label": "单件净重(kg)",
        "label_en": "Net Weight per Piece (kg)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_per_piece_m3",
        "label": "单件净体积(m³)",
        "label_en": "Net Volume per Piece (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_box_per_piece_m3",
        "label": "单件长方体体积(m³)",
        "label_en": "Box Volume per Piece (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece",
        "label": "单件售价(元/件)",
        "label_en": "Price per Piece (CNY)",
        "decimals": 2,
        "internal": false
      },
      {
        "key": "piece.price_per_meter",
        "label": "单价(元/米)",
        "label_en": "Unit Price (CNY/m)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece_fx",
        "label": "单件美元售价(USD/件)",
        "label_en": "Price per Piece (USD)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "price.cost_pretax",
        "label": "税前成本(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.cost_incl",
        "label": "含税采购价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.profit_amount",
        "label": "加工利润(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_excl_vat",
        "label": "不含税售价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat_rate_used",
        "label": "销项税率",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat",
        "label": "销项税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_incl_vat",
        "label": "含税售价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      }
    ]
  },
  "field_fence": {
    "product_key": "field_fence",
    "name": "牛栏网",
    "name_en": "Field Fence",
    "category_code": "niulanwang",
    "hs_codes": [
      "7314410000"
    ],
    "cost": {
      "field": "raw_price",
      "basis": "pretax",
      "unit": "CNY/kg",
      "note": "税前成本：给的是「已含加工利润的含税价」时要用 incl_tax，引擎会按进项票税点还原为税前成本；给的是税前价则用 pretax。"
    },
    "space": {
      "axes": [],
      "variants": [
        {
          "name": "coating",
          "label": "表面处理",
          "label_en": "Surface Treatment",
          "kind": "variant",
          "options": [
            {
              "value": "热镀锌 40g/㎡",
              "label_en": "Hot-dip galvanized 40 g/m²",
              "attributes": {
                "code": "zinc_40",
                "raw_price": 4.4,
                "zinc_g_m2": 40
              }
            },
            {
              "value": "热镀锌 200g/㎡",
              "label_en": "Hot-dip galvanized 200 g/m²",
              "attributes": {
                "code": "zinc_200",
                "raw_price": 5.6,
                "zinc_g_m2": 200
              }
            },
            {
              "value": "热镀锌 260g/㎡",
              "label_en": "Hot-dip galvanized 260 g/m²",
              "attributes": {
                "code": "zinc_260",
                "raw_price": 5.9,
                "zinc_g_m2": 260
              }
            },
            {
              "value": "电镀锌",
              "label_en": "Electro-galvanized",
              "attributes": {
                "code": "elec_galv",
                "raw_price": 4.8,
                "zinc_g_m2": 0
              }
            },
            {
              "value": "PVC涂塑(黑色)",
              "label_en": "PVC coated (black)",
              "attributes": {
                "code": "pvc_black",
                "raw_price": 6.4,
                "zinc_g_m2": 0
              }
            }
          ]
        },
        {
          "name": "wave",
          "label": "工艺",
          "label_en": "Wave Bend",
          "kind": "variant",
          "options": [
            {
              "value": "无波款",
              "label_en": "Without wave bend",
              "attributes": {
                "code": "no_wave",
                "wave_factor": 0
              }
            },
            {
              "value": "波弯款",
              "label_en": "With wave bend",
              "attributes": {
                "code": "wave_bend",
                "wave_factor": 1
              }
            }
          ]
        }
      ],
      "combo_count": 10,
      "summary": "coating(5) × wave(2)",
      "formula": "表面处理(5) × 工艺(2)"
    },
    "piece_inputs": [],
    "numeric_inputs": [
      {
        "key": "de",
        "label": "边丝径(mm)",
        "label_en": "Edge Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.0",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "两侧边丝直径，重量公式里的 d边。"
      },
      {
        "key": "dm",
        "label": "内横丝径(mm)",
        "label_en": "Inner Horizontal Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.0",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "内横丝（径丝）直径，重量公式里的 d横。"
      },
      {
        "key": "dv",
        "label": "竖丝径(mm)",
        "label_en": "Vertical Wire Dia. (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "2.0",
        "min_value": "0.3",
        "max_value": "8",
        "decimals": 2,
        "note": "竖丝直径，重量公式里的 d竖。"
      },
      {
        "key": "height_m",
        "label": "网高(m)",
        "label_en": "Net Height (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "1.2",
        "min_value": "0.3",
        "max_value": "3",
        "decimals": 2,
        "note": "网高；体积口径按它算。"
      },
      {
        "key": "mesh_mm",
        "label": "竖丝间距(mm)",
        "label_en": "Vertical Wire Spacing (mm)",
        "unit": "mm",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "100",
        "min_value": "10",
        "max_value": "1000",
        "decimals": null,
        "note": "对外按厘米表述（10cm/15cm），内部按毫米参与公式。"
      },
      {
        "key": "n",
        "label": "横丝根数",
        "label_en": "No. of Horizontal Wires",
        "unit": "根",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "10",
        "min_value": "2",
        "max_value": "100",
        "decimals": null,
        "note": "重量公式里的 n。默认 10 根。"
      },
      {
        "key": "roll_len_m",
        "label": "卷长(m)",
        "label_en": "Roll Length (m)",
        "unit": "m",
        "ui_unit": "",
        "ui_scale": 1.0,
        "default": "100",
        "min_value": "1",
        "max_value": "1000",
        "decimals": null,
        "note": "每卷多少米，直接进重量公式。"
      },
      {
        "key": "roll_dia_m",
        "label": "卷径",
        "label_en": "Roll Diameter",
        "unit": "m",
        "ui_unit": "公分",
        "ui_scale": 100,
        "default": "0.3",
        "min_value": "0.05",
        "max_value": "2",
        "decimals": null,
        "note": "决定体积（π/4 × 卷径² × 网高），是对外报运价/报关的口径。"
      }
    ],
    "pricing_key": [
      {
        "field": "de",
        "label": "边丝径",
        "unit": "mm",
        "kind": "numeric",
        "options": [],
        "ui_unit": "",
        "ui_scale": 1.0
      },
      {
        "field": "coating_code",
        "label": "镀锌量",
        "unit": "",
        "kind": "variant",
        "options": [
          {
            "value": "zinc_40",
            "label": "热镀锌 40g/㎡"
          },
          {
            "value": "zinc_200",
            "label": "热镀锌 200g/㎡"
          },
          {
            "value": "zinc_260",
            "label": "热镀锌 260g/㎡"
          },
          {
            "value": "elec_galv",
            "label": "电镀锌"
          },
          {
            "value": "pvc_black",
            "label": "PVC涂塑(黑色)"
          }
        ]
      }
    ],
    "calculations": {
      "derived": [
        {
          "code": "height_mm",
          "stage": "derived",
          "label": "网高(mm)",
          "label_en": "Net Height (mm)",
          "unit": "mm",
          "expr": "height_m * 1000",
          "decimals": null,
          "integer": false,
          "note": "统一到毫米参与重量公式，避免量纲混用。"
        },
        {
          "code": "mesh_cm",
          "stage": "derived",
          "label": "竖丝间距(cm)",
          "label_en": "Vertical Wire Spacing (cm)",
          "unit": "cm",
          "expr": "mesh_mm / 10",
          "decimals": null,
          "integer": false,
          "note": "对外按厘米表述（10cm / 15cm），内部按毫米计算。"
        },
        {
          "code": "wire_count",
          "stage": "derived",
          "label": "横丝数(根)",
          "label_en": "No. of Horizontal Wires",
          "unit": "根",
          "expr": "n",
          "decimals": null,
          "integer": false,
          "note": "牛栏网固定 10 根横丝（径丝），即重量公式中的 n。"
        },
        {
          "code": "roll_dia_cm",
          "stage": "derived",
          "label": "卷径(cm)",
          "label_en": "Roll Diameter (cm)",
          "unit": "cm",
          "expr": "roll_dia_m * 100",
          "decimals": null,
          "integer": false,
          "note": "100 米卷 30cm、50 米卷 25cm，随丝径方案联动。"
        },
        {
          "code": "weight_base_kg",
          "stage": "derived",
          "label": "单卷基础净重(kg)",
          "label_en": "Base Net Weight per Roll (kg)",
          "unit": "kg",
          "expr": "0.00617 * roll_len_m * (2*de**2 + (n-2)*dm**2 + dv**2 * (height_mm + (n-1)*50) / mesh_mm)",
          "decimals": null,
          "integer": false,
          "note": "整卷净重(kg) = 0.00617 × L × [2·d边² + (n−2)·d横² + d竖² × (w + (n−1)×50) / s]；L=卷长(m)，n=横丝根数，w=网高(mm)，s=竖丝间距(mm)，(n−1)×50 为每个铰接结的缠绕余量(mm)。此处的 0.00617 是钢丝截面积→重量的换算系数（含钢密度与圆周率）。"
        },
        {
          "code": "edge_weight_kg",
          "stage": "derived",
          "label": "单卷边丝重(kg)",
          "label_en": "Edge Wire Weight per Roll (kg)",
          "unit": "kg",
          "expr": "0.01234 * roll_len_m * de**2",
          "decimals": 4,
          "integer": false,
          "note": "边丝重量(kg) = 0.01234 × L × d边²（两侧边丝合计，故系数是 0.00617 的两倍）。"
        },
        {
          "code": "wave_add_kg",
          "stage": "derived",
          "label": "波弯增重(kg)",
          "label_en": "Wave Bend Extra Weight (kg)",
          "unit": "kg",
          "expr": "wave_factor * wave_add_per_100m * roll_len_m / 100",
          "decimals": null,
          "integer": false,
          "note": "波弯款按每 100 米增重 3kg 折算：增重 = wave_factor × 3 × 卷长 ÷ 100。无波款 wave_factor=0 故增重为 0；100 米卷 +3kg，50 米卷只 +1.5kg。"
        },
        {
          "code": "weight_per_piece_kg",
          "stage": "derived",
          "label": "单卷净重(kg)",
          "label_en": "Net Weight per Roll (kg)",
          "unit": "kg",
          "expr": "weight_base_kg + wave_add_kg",
          "decimals": 4,
          "integer": false,
          "note": "单卷净重 = 基础净重 + 波弯增重。此处按 4 位小数落定，下游总重由落定值乘卷数，以保证表上「单卷重 × 卷数 = 总重」能对上。"
        },
        {
          "code": "volume_per_piece_m3",
          "stage": "derived",
          "label": "单卷净体积(m³)",
          "label_en": "Net Volume per Roll (m³)",
          "unit": "m³",
          "expr": "pi / 4 * roll_dia_m**2 * height_m",
          "decimals": 4,
          "integer": false,
          "note": "按**实际圆柱体**计：单卷净体积 = π/4 × 卷径² × 网高，即 π × (卷径/2)² × 网高。这是钢材本身的占用体积。"
        },
        {
          "code": "volume_box_per_piece_m3",
          "stage": "derived",
          "label": "单卷长方体体积(m³)",
          "label_en": "Box Volume per Roll (m³)",
          "unit": "m³",
          "expr": "roll_dia_m**2 * height_m",
          "decimals": 4,
          "integer": false,
          "note": "按**外接长方体**计：单卷长方体体积 = 卷径² × 网高（把卷看作以卷径为边长的方柱）。堆码/报运价用这个口径。"
        }
      ],
      "piece": [
        {
          "code": "price_per_piece",
          "stage": "piece",
          "label": "单卷售价(元/卷)",
          "label_en": "Price per Roll (CNY)",
          "unit": "元/卷",
          "expr": "main_price_incl if terms_enabled else unit_price * weight_per_piece_kg",
          "decimals": 2,
          "integer": false,
          "note": "单卷售价 = 单价(元/kg) × 单卷净重。启用贸易术语时取主术语（含税）单件价，否则取 EXW 价链输出。"
        },
        {
          "code": "price_per_meter",
          "stage": "piece",
          "label": "单价(元/米)",
          "label_en": "Unit Price (CNY/m)",
          "unit": "元/米",
          "expr": "price_per_piece / roll_len_m",
          "decimals": 4,
          "integer": false,
          "note": "每米价 = 单卷售价 ÷ 卷长。与单卷价同源，因此「每米价 × 总米数」与「单卷价 × 卷数」必然相等。"
        },
        {
          "code": "price_per_piece_fx",
          "stage": "piece",
          "label": "单卷美元售价(USD/卷)",
          "label_en": "Price per Roll (USD/roll)",
          "unit": "USD/卷",
          "expr": "price_per_piece / fx_rate",
          "decimals": 4,
          "integer": false,
          "note": "外币价由**已展示的人民币单卷价**除以汇率得到，保证客户拿表上数字复算一致。"
        }
      ],
      "order": [
        {
          "code": "pieces",
          "stage": "order",
          "label": "卷数",
          "label_en": "Rolls",
          "unit": "卷",
          "expr": "total / roll_len_m",
          "decimals": 0,
          "integer": true,
          "note": "卷数 = 订单总长度 ÷ 每卷长度。全丝2.5 每卷 50 米、其余每卷 100 米，故卷数随丝径方案变化。"
        },
        {
          "code": "total_net_weight_kg",
          "stage": "order",
          "label": "总净重(kg)",
          "label_en": "Total Net Weight (kg)",
          "unit": "kg",
          "expr": "pieces * weight_per_piece_kg",
          "decimals": 4,
          "integer": false,
          "note": "总净重 = 单卷净重（落定值）× 卷数。"
        },
        {
          "code": "volume_box_m3",
          "stage": "order",
          "label": "长方体总体积(m³)",
          "label_en": "Total Box Volume (m³)",
          "unit": "m³",
          "expr": "pieces * volume_box_per_piece_m3",
          "decimals": 4,
          "integer": false,
          "note": "长方体总体积 = 单卷**外接长方体**体积（落定值）× 卷数，即全部卷按方柱直接累加、**尚未扣减**的体积。"
        },
        {
          "code": "volume_effective_m3",
          "stage": "order",
          "label": "实际占用体积(m³)",
          "label_en": "Effective Occupied Volume (m³)",
          "unit": "m³",
          "expr": "volume_box_m3 * (1 - space_deduction_ratio) - space_deduction",
          "decimals": 4,
          "integer": false,
          "note": "实际占用体积 = 长方体总体积 × (1 − 扣减比例) − 固定扣减。本项目只按比例扣 4%（装柜系数 0.96），固定扣减为 0。这是对外报运价/报关用的体积，与「长方体总体积」是两个口径，不要把未扣减的总体积报给货代。"
        },
        {
          "code": "total_price",
          "stage": "order",
          "label": "总售价(元)",
          "label_en": "Total Price (CNY)",
          "unit": "元",
          "expr": "pieces * price_per_piece",
          "decimals": 2,
          "integer": false,
          "note": "总售价 = 单卷售价 × 卷数，严格满足「单价 × 数量 = 总价」。"
        },
        {
          "code": "total_price_fx",
          "stage": "order",
          "label": "总美元售价(USD)",
          "label_en": "Total Price (USD)",
          "unit": "USD",
          "expr": "pieces * price_per_piece_fx",
          "decimals": 4,
          "integer": false,
          "note": "总美元售价 = 单卷美元售价 × 卷数。"
        }
      ]
    },
    "space_deduction": {
      "mode": "ratio",
      "value": "0.04",
      "range": null,
      "expr": "",
      "note": "实际占用体积 = 长方体累计总体积 × (1 − 扣减比例)，即 × 装柜系数 0.96。扣减的由来是卷与卷之间并非完美网格堆叠，边界余量堆不到满箱。**按比例而非固定 m³**：固定值不随数量缩放，小单会算出负体积。取值来源：**企微智能表格「客户询盘跟进表 → 明细表」实测值** —— 21 行数据里「装柜系数」全部为 0.96（即扣减 4%）。与工厂经验也对得上：满柜（约 630 卷、长方体约 68 m³）按 4% 扣 2.72 m³，正落在「满柜减 2~3 m³」区间内。"
    },
    "invariants": [
      {
        "label": "总价 = 单件价 × 件数",
        "expr": "total_price == round(pieces * price_per_piece, 2)",
        "severity": "error"
      },
      {
        "label": "总价 = 每米价 × 总米数",
        "expr": "total_price == round(price_per_meter * total, 2)",
        "severity": "error"
      },
      {
        "label": "总重 = 单卷重 × 卷数",
        "expr": "total_net_weight_kg == round(pieces * weight_per_piece_kg, 4)",
        "severity": "error"
      },
      {
        "label": "长方体总体积 = 单卷长方体体积 × 卷数",
        "expr": "volume_box_m3 == round(pieces * volume_box_per_piece_m3, 4)",
        "severity": "error"
      },
      {
        "label": "单卷净体积 = π/4 × 卷径² × 网高（圆柱体）",
        "expr": "volume_per_piece_m3 == round(pi / 4 * roll_dia_m**2 * height_m, 4)",
        "severity": "error"
      },
      {
        "label": "单卷长方体体积 = 卷径² × 网高（外接方柱）",
        "expr": "volume_box_per_piece_m3 == round(roll_dia_m**2 * height_m, 4)",
        "severity": "error"
      },
      {
        "label": "实际占用 = 总体积 × 装柜系数",
        "expr": "volume_effective_m3 == round(volume_box_m3 * (1 - space_deduction_ratio) - space_deduction, 4)",
        "severity": "error"
      },
      {
        "label": "总外币价 = 单卷外币价 × 卷数",
        "expr": "total_price_fx == round(pieces * price_per_piece_fx, 4)",
        "severity": "error"
      },
      {
        "label": "单卷外币价 = 人民币价 ÷ 汇率",
        "expr": "price_per_piece_fx == round(price_per_piece / fx_rate, 4)",
        "severity": "error"
      },
      {
        "label": "零税率时销项税额为 0",
        "expr": "output_vat_rate_used != 0 or output_vat == 0",
        "severity": "error"
      },
      {
        "label": "含税售价 = 不含税售价 + 销项税额",
        "expr": "quote_incl_vat == round(quote_excl_vat + output_vat, 4)",
        "severity": "error"
      },
      {
        "label": "进项税额 = 含税采购价 − 税前成本",
        "expr": "input_vat == round(cost_incl - cost_pretax, 4)",
        "severity": "error"
      },
      {
        "label": "可退进项增值税税额 = 进项税额 × 可退税比例",
        "expr": "refundable_input_vat == round(input_vat * refund_ratio_used, 4)",
        "severity": "error"
      },
      {
        "label": "不可退进项税额 = 进项税额 − 可退进项增值税税额",
        "expr": "non_refundable_input_vat == round(input_vat - refundable_input_vat, 4)",
        "severity": "error"
      },
      {
        "label": "让利额 = 可退进项增值税税额 × 让利比例",
        "expr": "give_amount == round(refundable_input_vat * give_ratio, 4)",
        "severity": "error"
      },
      {
        "label": "自留可退税额 = 可退进项增值税税额 − 让利额",
        "expr": "retained_refundable == round(refundable_input_vat - give_amount, 4)",
        "severity": "error"
      },
      {
        "label": "印花税 = 加工利润 × 印花税率",
        "expr": "stamp_base != 'profit' or stamp_duty == round(profit_amount * stamp_rate, 4)",
        "severity": "error"
      },
      {
        "label": "应缴增值税 = max(0, 销项税额 − 可退进项增值税税额)",
        "expr": "vat_payable == round(max(0, output_vat - refundable_input_vat), 4)",
        "severity": "error"
      },
      {
        "label": "可退/留抵 = max(0, 可退进项增值税税额 − 销项税额)",
        "expr": "vat_carryforward == round(max(0, refundable_input_vat - output_vat), 4)",
        "severity": "error"
      },
      {
        "label": "不含税售价 = 成本 + 利润 + 不可退进项税额 + 自留可退税额 + 印花税",
        "expr": "quote_excl_vat == round(cost_pretax + profit_amount + non_refundable_input_vat + retained_refundable + stamp_duty, 4)",
        "severity": "error"
      }
    ],
    "params": [
      {
        "name": "原材料税前成本",
        "value": "4.4（普锌）/ 5.6（重镀锌）",
        "unit": "元/kg",
        "note": "客户给定口径：已含 0.1 元/kg 加工利润，故税前成本为 4.4 / 5.6"
      },
      {
        "name": "加工利润",
        "value": 0.1,
        "unit": "元/kg",
        "note": "100 元/t，全表仅计一次"
      },
      {
        "name": "进项票税点",
        "value": 0.1,
        "unit": "比例",
        "note": "丝厂开票 10 个点；含税采购价 = 税前成本 ÷ 0.9"
      },
      {
        "name": "印花税率",
        "value": 0.05,
        "unit": "比例",
        "note": "按加工利润计征（该值来自税务档案，可覆盖）"
      },
      {
        "name": "横丝（径丝）根数",
        "value": "默认 10（可改）",
        "unit": "根",
        "note": "重量公式中的 n。现在是**自由数值参数**，客户可填任意值"
      },
      {
        "name": "波弯款增重",
        "value": 3,
        "unit": "kg/100m",
        "note": "100 米卷 +3kg、50 米卷 +1.5kg"
      },
      {
        "name": "占用空间扣减比例",
        "value": "0.04（= 装柜系数 0.96）",
        "unit": "比例",
        "note": "实际占用 = 长方体总体积 × (1 − 0.04)。按**比例**而非固定 m³ —— 固定值在小单上会算出负体积（实测 < 2314 米时为负）。取值来源：智能表格「明细表」21 行的装柜系数实测值 0.96；与工厂经验一致（满柜约 68 m³ × 4% = 2.72 m³，落在「2~3 m³」内）"
      },
      {
        "name": "卷径 / 卷长",
        "value": "默认 30cm / 100m（可改）",
        "unit": "cm / m",
        "note": "**自由数值参数**，客户按实际装箱填；不再与丝径方案联动"
      }
    ],
    "notes": [
      "1. 整卷净重(kg) = 0.00617 × L × [2·d边² + (n−2)·d横² + d竖² × (w + (n−1)×50) / s]；L=卷长(m)，n=横丝根数，w=网高(mm)，s=竖丝间距(mm)，(n−1)×50 为铰接结每道缠绕余量(mm)。",
      "2. 边丝重量(kg) = 0.01234 × L × d边²（两侧边丝合计）。",
      "3. 波弯款在无波款基础上每 100 米增加 3kg。",
      "4. 体积分两个口径：**单卷净体积**按实际圆柱体计 = π/4 × 卷径² × 网高；**单卷长方体体积**按外接方柱计 = 卷径² × 网高。总实际占用体积 = 长方体体积 × 卷数 × 装柜系数 0.96（= 1 − 4%），这是对外报运价/报关用的口径。按比例而不是固定扣减：发得越少扣得越少，也不会出现负体积。",
      "5. 卷径与卷长是**自由数值**（默认 30cm / 100m），客户按实际装箱填，不再与丝径方案联动 —— 丝径同样是自由值，不是「方案」。",
      "5. 销项增值税为价外税：税额 = 不含税售价 × 销项税率（基数是售价，不是成本）。出口零税率时税额为 0。",
      "6. 退税退的是进项增值税额；可退进项增值税税额 = 进项税额 × (出口退税率 ÷ 征税率)，差额为不可退进项税额，属实际成本。",
      "7. 单卷售价 = 单价 × 单卷净重；总售价 = 单卷售价 × 卷数；严格满足 单价 × 数量 = 总价。",
      "8. 表面处理均为热镀锌，包装均为无包装，网孔分布均为拧编型上疏下密（横丝间距上疏下密，不参与重量与计价）。"
    ],
    "constants": {
      "product_name": "牛栏网",
      "product_name_en": "Field Fence",
      "surface_treatment": "热镀锌",
      "surface_treatment_en": "Hot-dip galvanized",
      "packing": "无包装",
      "packing_en": "No packing",
      "wave_add_per_100m": 3,
      "pi": "3.14159265358979323846"
    },
    "columns": [
      {
        "key": "index",
        "label": "序号",
        "label_en": "No.",
        "decimals": 0,
        "internal": false
      },
      {
        "key": "spec.product_name",
        "label": "产品",
        "label_en": "Product",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.height_m",
        "label": "网高(m)",
        "label_en": "Net Height (m)",
        "decimals": null,
        "internal": false
      },
      {
        "key": "derived.mesh_cm",
        "label": "竖丝间距(cm)",
        "label_en": "Vertical Wire Spacing (cm)",
        "decimals": null,
        "internal": false
      },
      {
        "key": "derived.wire_count",
        "label": "横丝数(根)",
        "label_en": "No. of Horizontal Wires",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.de",
        "label": "边丝径(mm)",
        "label_en": "Edge Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.dm",
        "label": "内横丝径(mm)",
        "label_en": "Inner Horizontal Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.dv",
        "label": "竖丝径(mm)",
        "label_en": "Vertical Wire Dia. (mm)",
        "decimals": 1,
        "internal": false
      },
      {
        "key": "spec.wave",
        "label": "工艺",
        "label_en": "Wave Bend",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.coating",
        "label": "表面处理",
        "label_en": "Surface Treatment",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.packing",
        "label": "包装",
        "label_en": "Packing",
        "decimals": null,
        "internal": false
      },
      {
        "key": "spec.roll_len_m",
        "label": "卷长(m/卷)",
        "label_en": "Roll Length (m/roll)",
        "decimals": null,
        "internal": false
      },
      {
        "key": "derived.roll_dia_cm",
        "label": "卷径(cm)",
        "label_en": "Roll Diameter (cm)",
        "decimals": null,
        "internal": false
      },
      {
        "key": "derived.edge_weight_kg",
        "label": "单卷边丝重(kg)",
        "label_en": "Edge Wire Weight per Roll (kg)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.weight_per_piece_kg",
        "label": "单卷净重(kg)",
        "label_en": "Net Weight per Roll (kg)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_per_piece_m3",
        "label": "单卷净体积(m³)",
        "label_en": "Net Volume per Roll (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "derived.volume_box_per_piece_m3",
        "label": "单卷长方体体积(m³)",
        "label_en": "Box Volume per Roll (m³)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece",
        "label": "单卷售价(元/卷)",
        "label_en": "Price per Roll (CNY)",
        "decimals": 2,
        "internal": false
      },
      {
        "key": "piece.price_per_meter",
        "label": "单价(元/米)",
        "label_en": "Unit Price (CNY/m)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "piece.price_per_piece_fx",
        "label": "单卷美元售价(USD/卷)",
        "label_en": "Price per Roll (USD/roll)",
        "decimals": 4,
        "internal": false
      },
      {
        "key": "price.cost_pretax",
        "label": "税前成本(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.cost_incl",
        "label": "含税采购价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.profit_amount",
        "label": "加工利润(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.pretax_quote",
        "label": "税前报价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.base_quote",
        "label": "基础报价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.input_vat",
        "label": "进项税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.refund_ratio_used",
        "label": "可退税比例",
        "label_en": null,
        "decimals": 6,
        "internal": true
      },
      {
        "key": "price.refundable_input_vat",
        "label": "可退进项增值税税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.non_refundable_input_vat",
        "label": "不可退进项税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.give_amount",
        "label": "让利额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.retained_refundable",
        "label": "自留可退税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.stamp_duty",
        "label": "印花税(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_excl_vat",
        "label": "不含税售价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat_rate_used",
        "label": "销项税率",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.output_vat",
        "label": "销项税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.quote_incl_vat",
        "label": "含税售价(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.vat_payable",
        "label": "应缴增值税(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      },
      {
        "key": "price.refund_receivable",
        "label": "可退/留抵税额(元/kg)",
        "label_en": null,
        "decimals": 4,
        "internal": true
      }
    ]
  },
} as unknown as Record<string, ProductFormulasResponse>;
// 见文件头「契约错位 #2」（pricing_key[].ui_unit/ui_scale 后端不产出）

/**
 * 法定税务档案（`GET /export-quote/rate-sets`）。
 *
 * 页面只读 `code` / `name`（`quote-workbench-view.tsx:616-619`），其余字段按契约给全。
 * `summary` 与 `warnings` 后端是算出来的（`RateSet.summary` / `.warnings()`），
 * 静态档案里没有 ⇒ 给契约默认值，**没有编内容**。
 */
export const MOCK_EXPORT_RATE_SETS: ExportRateSet[] = [
  {
    "code": "CN-2026-09",
    "name": "中国大陆 · 2026年9月",
    "country": "CN",
    "effective_from": "2026-09-01",
    "effective_to": null,
    "output_rate_default": 0.13,
    "output_rate_export": 0.0,
    "stamp_duty": {
      "rate": 0.05,
      "base": "profit"
    },
    "summary": "",
    "rebate_hs_count": 2,
    "rebate_default": null,
    "rebate_source": "待填写：以 HS 编码在税务总局退税率文库核实",
    "warnings": [],
    "source": "税率以财政部/税务总局及海关总署最新公告为准，本档案为业务基线，调整前请核对公告",
    "notes": [
      "报价单引用本档案编号，政策变化时新增一份档案而非修改本文件。",
      "出口退税率未核实前，报价政策里的可退税比例请显式填写，不要使用 auto 模式。"
    ]
  }
];

/**
 * 平台默认出口费用结构（`GET /export-quote/terms/template`）。
 *
 * **逐字镜像** `backend/orchestrator/app/services/export_quote/terms_template.py:42-112`
 *（含 `terms-amortize.ts:79-83` 要读的 `base` / `quote_as` / `weight_field` / `ladder`）。
 * 金额一律 `null` —— 结构与金额分离是后端刻意的设计（同文件 docstring）。
 */
export const MOCK_EXPORT_TERMS_TEMPLATE: ExportTermsTemplate = {
  "base": "EXW",
  "quote_as": "CIF",
  "weight_field": "weight_per_piece_kg",
  "items": {
    "inland_freight": {
      "name": "内陆运费（厂 → 港）",
      "name_en": "Inland freight (factory → port)",
      "mode": "per_shipment",
      "unit_hint": "元 / 整批",
      "note": "整批一次，引擎会按订单件数摊到单卷。",
      "value": null
    },
    "port_charges": {
      "name": "港杂费",
      "name_en": "Port charges",
      "mode": "per_shipment",
      "unit_hint": "元 / 整批",
      "note": "码头操作、装箱、堆存、单证等。",
      "value": null
    },
    "customs_fee": {
      "name": "报关费",
      "name_en": "Customs clearance fee",
      "mode": "per_shipment",
      "unit_hint": "元 / 整批",
      "note": "报关行、查验、单证费等。",
      "value": null
    },
    "ocean_freight": {
      "name": "海运费",
      "name_en": "Ocean freight",
      "mode": "per_weight_ton",
      "unit_hint": "元 / 吨",
      "note": "按计费吨填。若船公司按整箱报，把箱费折成吨单价即可。",
      "value": null
    },
    "insurance": {
      "name": "保险费",
      "name_en": "Insurance",
      "mode": "insurance_of_cif",
      "unit_hint": "费率（0.003 = 3‰）",
      "note": "按 CIF 加成投保：保险费 = CIF × 投保加成(110%) × 费率。",
      "value": null
    }
  },
  "ladder": [
    {
      "code": "EXW",
      "label": "出厂价",
      "label_en": "EXW",
      "items": []
    },
    {
      "code": "FOB",
      "label": "离岸价（装运港船上交货）",
      "label_en": "FOB",
      "items": [
        "inland_freight",
        "port_charges",
        "customs_fee"
      ]
    },
    {
      "code": "CFR",
      "label": "成本加运费",
      "label_en": "CFR",
      "items": [
        "ocean_freight"
      ]
    },
    {
      "code": "CIF",
      "label": "到岸价（含运费与保险）",
      "label_en": "CIF",
      "items": [
        "insurance"
      ]
    }
  ]
};
