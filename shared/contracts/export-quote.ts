/**
 * 出口报价契约（EXW / FCA / FOB / CFR / CIF）
 *
 * Single source of truth: backend `app/api/export_quote.py`（前缀 /api/v1/export-quote）
 * 对应的计算内核在 `backend/orchestrator/app/services/export_quote/`。
 *
 * 两条铁律在这里体现：
 *  1. `view=customer` 的响应**不含**任何成本/利润/税额列 —— 前端即便直接渲染
 *     客户视图也不会泄露成本利润率；内部视图需要管理员权限。
 *  2. 报价有效期默认 7 天，后端回显 `valid_until`，前端直接展示。
 */
import { z } from 'zod';

// ── 通用 ───────────────────────────────────────────────────────────────────

/** 视图单元格：数值为 number，文本为 string，缺失为 null。 */
export const CellSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

/** 一张报价表的投影（内部/客户共用结构，列集合不同）。 */
export const QuoteTableSchema = z.object({
  view: z.string(),
  header: z.array(z.string()),
  rows: z.array(z.array(CellSchema)),
  /**
   * 每一列的**显示位数**，与 header 等长；null 表示这一列不做定长显示。
   *
   * 为什么位数要后端给：它是业务口径（金额两位、丝径一位），写在产品定义里；
   * 界面自己猜就成了第二份真源，两边一改就分叉。
   * 注意：数值本身后端已经按位数四舍五入过，这里是**呈现**要求 ——
   * 301 要显示成 301.00，而不是把 301 改数值。
   */
  decimals: z.array(z.number().nullable()).default([]),
  horizontal_header: z.array(z.string()).default([]),
  vertical_header: z.array(z.string()).default([]),
  vertical_data: z.array(z.array(CellSchema)).default([]),
});
export type QuoteTable = z.infer<typeof QuoteTableSchema>;

export const OrderMetaSchema = z.object({
  name: z.string(),
  label: z.string(),
  label_en: z.string().default(''),
  total: z.number(),
  unit: z.string().default('m'),
});
export type OrderMeta = z.infer<typeof OrderMetaSchema>;

export const MainTermSummarySchema = z.object({
  label: z.string(),
  total: z.number(),
  unit: z.string(),
  min_price_incl: z.number(),
  max_price_incl: z.number(),
  min_total: z.number(),
  max_total: z.number(),
  min_price_fx: z.number(),
  max_price_fx: z.number(),
});
export type MainTermSummary = z.infer<typeof MainTermSummarySchema>;

// ── 请求 ───────────────────────────────────────────────────────────────────

export const ExportOrderInSchema = z.object({
  name: z.string().optional(),
  total: z.number().positive(),
  unit: z.string().default('m'),
  label: z.string().optional(),
  label_en: z.string().optional(),
});
export type ExportOrderIn = z.infer<typeof ExportOrderInSchema>;

/**
 * 报价政策覆盖项。全部可选 —— 未给的字段从**税务档案**取法定默认值，
 * 这样国家调整税率时只需新增一份档案，前端与引擎都不用改。
 */
export const ExportPolicyInSchema = z.object({
  /** 进项票税点，如 0.10（供应商属性，与产品无关） */
  input_vat_rate: z.number().min(0).max(1).optional(),
  /** 销项税率；出口零税率填 0。政策变化时改为 0.13 等即可 */
  output_vat_rate: z.number().min(0).max(1).optional(),
  output_vat_mode: z.enum(['additive', 'inclusive']).optional(),
  profit_mode: z.enum(['fixed', 'ratio', 'margin_on_price']).optional(),
  profit_value: z.number().optional(),
  /**
   * 综合税费系数（margin_on_price 售价加成模式使用，默认 0.03）。
   * 含义：除销项增值税外的印花税、土地税、个人所得税等杂税总和，
   * 相对销项计征。售价公式：不含税售价 = 税前成本 ÷ (1 − 利润率 − 综合税费系数)
   */
  misc_fee_rate: z.number().min(0).max(1).optional(),
  /** 让出可退进项增值税额的比例（0.8 = 让利 80%，自留 20% 对冲风险） */
  give_ratio: z.number().min(0).max(1).optional(),
  /** 可退税比例；'auto' = 出口退税率 ÷ 进项票税点 */
  refund_ratio: z.union([z.number().min(0).max(1), z.literal('auto')]).optional(),
  /** 出口退税率（refund_ratio='auto' 时使用） */
  rebate_rate: z.number().min(0).max(1).optional(),
  stamp_rate: z.number().min(0).max(1).optional(),
  /** 印花税计税基数；默认按加工利润 */
  stamp_base: z.enum(['profit', 'cost', 'base_quote']).optional(),
  extras: z.array(z.record(z.unknown())).optional(),
});
export type ExportPolicyIn = z.infer<typeof ExportPolicyInSchema>;

/**
 * 出口费用结构（贸易术语阶梯）。
 *
 * 结构与金额分离：结构由**平台声明一次**（有哪些费用项、怎么计价、每档累加哪些），
 * 报价时只需填金额。
 *
 * 重要：这个形状**就是**报价请求里 `terms` 的形状 —— 界面拿到模板后原样回传、
 * 只把每个费用项的 value 填成数字，不做任何结构转换，也不把结构写死在前端。
 */
export const ExportTermsFeeSchema = z.object({
  name: z.string().default(''),
  name_en: z.string().default(''),
  /** per_piece | per_shipment | per_weight_kg | per_weight_ton | ratio_of_subtotal | insurance_of_cif */
  mode: z.string(),
  /** 界面提示：这一项该填什么单位 */
  unit_hint: z.string().default(''),
  note: z.string().default(''),
  value: z.number().nullable().default(null),
});
export type ExportTermsFee = z.infer<typeof ExportTermsFeeSchema>;

export const ExportTermsRungSchema = z.object({
  code: z.string(),
  label: z.string().default(''),
  label_en: z.string().default(''),
  /** 本档**新增**的费用项（阶梯逐档累加，不是全量清单） */
  items: z.array(z.string()).default([]),
});
export type ExportTermsRung = z.infer<typeof ExportTermsRungSchema>;

export const ExportTermsTemplateSchema = z.object({
  base: z.string().default('EXW'),
  /** 对外报价用哪个术语（默认 CIF） */
  quote_as: z.string().default('CIF'),
  weight_field: z.string().default(''),
  /** 费用项表：键名必须叫 items，写错名字会被引擎拒绝（避免静默退化成 EXW） */
  items: z.record(ExportTermsFeeSchema),
  ladder: z.array(ExportTermsRungSchema).default([]),
});
export type ExportTermsTemplate = z.infer<typeof ExportTermsTemplateSchema>;

export const ExportQuoteRequestSchema = z.object({
  /** 产品模型 key，如 field_fence（牛栏网） */
  product_key: z.string().min(1),
  /** 税务档案编号；留空则按报价日取当期生效的一份 */
  rate_set_code: z.string().optional(),
  fx_rate: z.number().positive(),
  fx_source: z.string().default(''),
  orders: z.array(ExportOrderInSchema).min(1, '至少需要一个订单量方案'),
  policy: ExportPolicyInSchema.optional(),
  /** 贸易术语阶梯；用户自己填金额，引擎不给默认运费 */
  terms: z.record(z.unknown()).nullable().optional(),
  /** 当期价格输入（运费、保险费率等），供 terms 里的 source 取值 */
  price_inputs: z.record(z.unknown()).nullable().optional(),
  /** 本单选用的包装（产品 packaging[].id）；缺省 = 默认包装/最早创建的包装 */
  packaging_id: z.string().nullable().optional(),
  variant_overrides: z.record(z.unknown()).nullable().optional(),
  constants_override: z.record(z.unknown()).nullable().optional(),
  /**
   * 显式规格行：只算给的那些，不再展开全部组合。
   * 用于「客户只问若干具体组合」与「按上传的表格逐行报价」。
   */
  spec_rows: z.array(z.record(z.unknown())).nullable().optional(),
  /** 报价有效期（天），默认 7 */
  validity_days: z.number().int().min(1).max(365).default(7),
  quote_date: z.string().optional(),
  with_verification: z.boolean().default(false),
  currency: z.string().default('CNY'),
  quote_currency: z.string().default('USD'),
});
export type ExportQuoteRequest = z.infer<typeof ExportQuoteRequestSchema>;

// ── 响应 ───────────────────────────────────────────────────────────────────

export const QuoteMetaSchema = z.object({
  product_key: z.string(),
  product_name: z.string(),
  product_name_en: z.string().default(''),
  quote_date: z.string().nullable(),
  /** 报价有效期至 —— 后端按 quote_date + validity_days 计算 */
  valid_until: z.string().nullable(),
  validity_days: z.number().int(),
  fx_rate: z.string(),
  fx_source: z.string().default(''),
  currency: z.string(),
  quote_currency: z.string(),
  rate_set_code: z.string().default(''),
  term_codes: z.array(z.string()).default([]),
  quote_as: z.string().default(''),
  combo_count: z.number().int(),
  orders: z.array(OrderMetaSchema).default([]),
  main_term_summary: z.record(MainTermSummarySchema).default({}),
  /** 引擎提示（如退税率未核实），前端应展示给业务确认 */
  diagnostics: z.array(z.string()).default([]),
});
export type QuoteMeta = z.infer<typeof QuoteMetaSchema>;

export const ExportQuoteResponseSchema = z.object({
  meta: QuoteMetaSchema,
  view: z.enum(['customer', 'internal']),
  customer: QuoteTableSchema,
  customer_en: QuoteTableSchema,
  /** 仅 view='internal' 时返回 */
  internal: QuoteTableSchema.optional(),
  verification: z
    .object({
      ok: z.boolean(),
      checks: z.number().int(),
      passes: z.array(z.string()).default([]),
      errors: z.array(z.record(z.unknown())).default([]),
      warnings: z.array(z.record(z.unknown())).default([]),
    })
    .optional(),
});
export type ExportQuoteResponse = z.infer<typeof ExportQuoteResponseSchema>;

// ── 产品与税务档案 ─────────────────────────────────────────────────────────

export const ExportProductSchema = z.object({
  key: z.string(),
  name: z.string(),
  name_en: z.string().default(''),
  category_code: z.string().default(''),
  combo_count: z.number().int(),
  spec_summary: z.string().default(''),
  hs_codes: z.array(z.string()).default([]),
  cost_basis: z.string().default(''),
  cost_unit: z.string().default(''),
  params: z.record(z.unknown()).default({}),
});
export type ExportProduct = z.infer<typeof ExportProductSchema>;

export const ExportProductListSchema = z.object({
  products: z.array(ExportProductSchema),
  total: z.number().int(),
});

export const StampDutySchema = z.object({
  rate: z.number().nullable(),
  base: z.string().default('profit'),
});

export const ExportRateSetSchema = z.object({
  code: z.string(),
  name: z.string().default(''),
  country: z.string().default(''),
  effective_from: z.string().nullable(),
  effective_to: z.string().nullable(),
  output_rate_default: z.number().nullable().optional(),
  output_rate_export: z.number().nullable().optional(),
  stamp_duty: StampDutySchema,
  /** 印花税的读法，如「加工利润 × 5.00%」 */
  summary: z.string().default(''),
  rebate_hs_count: z.number().int().default(0),
  rebate_default: z.number().nullable().optional(),
  rebate_source: z.string().default(''),
  warnings: z.array(z.string()).default([]),
  source: z.string().default(''),
  notes: z.array(z.string()).default([]),
});
export type ExportRateSet = z.infer<typeof ExportRateSetSchema>;

export const ExportRateSetListSchema = z.object({
  rate_sets: z.array(ExportRateSetSchema),
  total: z.number().int(),
});

/**
 * 客户税率档案 —— 「这个客户填过的那套税率，下次一键套用」。
 *
 * 与 `ExportRateSet` 的区别（两者在界面上是同一个下拉里的两层）：
 *   · `ExportRateSet` = **法定**税率（国家政策，平台维护的 yaml）：销项税率、
 *     印花税率、按 HS 编码的出口退税率。很少变动。
 *   · 本结构 = **这个客户自己填的**：进项票税点、销项税率、出口退税率、
 *     印花税率 + 基数。每个客户（+每个产品）一套，可以有多份、各起名字。
 *
 * `rate_set_code` 是这份档案**当时绑定的法定档案**。因为两层放在同一个下拉里，
 * 选中客户档案时要连法定档案一起切过去；否则「客户档案 + 另一份法定档案」
 * 会算出一个谁都没确认过的组合，而金额看着完全正常。
 */
export const QuoteProfileTaxSchema = z
  .object({
    /** 进项票税点（供应商属性），如 0.1 */
    input_vat_rate: z.number().optional(),
    /** 销项税率；出口零税率填 0 */
    output_vat_rate: z.number().optional(),
    /** 出口退税率（按 HS 编码核实） */
    rebate_rate: z.number().optional(),
    /** 综合税费系数（除销项增值税外的杂税总和，相对销项计征；售价加成模式使用） */
    misc_fee_rate: z.number().optional(),
    /** 印花税率 */
    stamp_rate: z.number().optional(),
    /** 印花税计税基数 */
    stamp_base: z.enum(['profit', 'cost', 'base_quote']).optional(),
  })
  // 刻意不丢弃未知键：Zod 的 .object() 默认会**静默删掉**没声明的键，
  // 那正是「后端存了、界面取不到」这类看不见的失败的成因。
  // 写入侧由后端白名单把关（未知键直接 422），所以这里的宽松不会放进垃圾数据 ——
  // 反而能保证「后端加了新税率项但前端还没接」时暴露出来，而不是悄悄丢掉。
  .passthrough();
export type QuoteProfileTax = z.infer<typeof QuoteProfileTaxSchema>;

export const QuoteProfileSchema = z.object({
  id: z.number().int(),
  customer_id: z.string(),
  /** 引擎的产品 key（如 field_fence），与报价请求里用的是同一个 */
  product_key: z.string(),
  /** 产品显示名，仅用于展示 */
  product_name: z.string().default(''),
  /** 自定义名称，用户保存时自己起 */
  profile_name: z.string(),
  /** 当时绑定的法定税务档案编号 */
  rate_set_code: z.string(),
  tax_overrides: QuoteProfileTaxSchema.default({}),
  source: z.string().default('manual'),
  created_at: z.string().nullable().default(null),
  updated_at: z.string().nullable().default(null),
});
export type QuoteProfile = z.infer<typeof QuoteProfileSchema>;

export const QuoteProfileListSchema = z.object({
  scope: z.string().default('own'),
  product_key: z.string(),
  /**
   * 按创建时间**倒序**（新的在前）。界面「默认选择最新创建的」直接取第一条，
   * 不要在前端再排一次 —— 排序规则两处实现就会两处不一致。
   */
  profiles: z.array(QuoteProfileSchema).default([]),
});
export type QuoteProfileList = z.infer<typeof QuoteProfileListSchema>;

export const SaveQuoteProfileSchema = z.object({
  product_key: z.string().min(1),
  profile_name: z.string().min(1, '请给这份档案起个名字'),
  rate_set_code: z.string().min(1),
  tax_overrides: QuoteProfileTaxSchema,
});
export type SaveQuoteProfile = z.infer<typeof SaveQuoteProfileSchema>;

export const RebateRateLookupRequestSchema = z.object({
  hs_code: z.string().min(4, '请输入 HS 编码'),
  rate_set_code: z.string().optional(),
});
export type RebateRateLookupRequest = z.infer<typeof RebateRateLookupRequestSchema>;

/**
 * 退税率查询结果。
 *
 * `found=false` 是**正常响应**而非错误：国家没有免鉴权的公开退税率接口，
 * 查不到时后端刻意不猜（猜错会让整张报价单系统性偏低），
 * 而是回 `message` + `hint` 让人工核实后填入。
 */
export const RebateRateLookupResponseSchema = z.object({
  found: z.boolean(),
  hs_code: z.string(),
  rate_set_code: z.string().optional(),
  rebate_rate: z.number().nullable().optional(),
  source: z.string().optional(),
  cached: z.boolean().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
});
export type RebateRateLookupResponse = z.infer<typeof RebateRateLookupResponseSchema>;

export const ExportVerifyResponseSchema = z.object({
  ok: z.boolean(),
  checks: z.number().int(),
  passes: z.array(z.string()).default([]),
  errors: z.array(z.record(z.unknown())).default([]),
  warnings: z.array(z.record(z.unknown())).default([]),
});
export type ExportVerifyResponse = z.infer<typeof ExportVerifyResponseSchema>;

// ── 规格空间与计算逻辑（业务可读）──────────────────────────────────────────

/** 一条计算量：表达式 + 单位 + 落定小数位 + **业务口径说明**。 */

// ── 规格空间与计算逻辑（业务可读）──────────────────────────────────────────

/** 一条计算量：表达式 + 单位 + 落定小数位 + **业务口径说明**。 */
export const MetricFormulaSchema = z.object({
  code: z.string(),
  stage: z.enum(['derived', 'piece', 'order']),
  label: z.string(),
  label_en: z.string().default(''),
  unit: z.string(),
  expr: z.string(),
  decimals: z.number().int().nullable(),
  integer: z.boolean().default(false),
  /** 怎么算、为什么这么算 —— 报价工位要展示给业务确认 */
  note: z.string(),
});
export type MetricFormula = z.infer<typeof MetricFormulaSchema>;

export const SpaceOptionSchema = z.object({
  value: z.unknown(),
  /**
   * 给人看的写法（如丝径 2.0、镀锌「普锌40g/㎡」）。
   * 与 value 分开是必须的：value 过一遍 JSON 会把 2.0 变成 2，
   * 而业务要看到的是 2.0 —— 界面显示 label、提交 value。
   */
  label: z.string().optional(),
  label_en: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
});

export const SpaceAxisSchema = z.object({
  name: z.string(),
  label: z.string(),
  label_en: z.string().default(''),
  kind: z.enum(['axis', 'variant']),
  options: z.array(SpaceOptionSchema),
});

export const SpaceDeductionSchema = z.object({
  mode: z.string(),
  value: z.unknown().nullable().optional(),
  range: z.array(z.number()).nullable(),
  expr: z.string().default(''),
  note: z.string(),
});

/**
 * 数量区可按件改写的规格参数声明。
 *
 * 只给**映射关系**：`key` 是变体属性名，`variant` 是它所属的变体组。
 * 界面据此从「当前选中项」的属性里取默认值，改动回写成 variant_overrides ——
 * 属性名与取值始终留在产品数据里，界面不写死任何产品知识。
 */
export const PieceInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  label_en: z.string().default(''),
  /** 引擎内部单位（公式里用的那个，如 m） */
  unit: z.string().default(''),
  /** 界面呈现与输入用的单位（如 公分）；留空则同 unit */
  ui_unit: z.string().default(''),
  /** 界面值 = 引擎值 × ui_scale（m→cm 填 100）。界面只负责换算，不拥有业务单位知识。 */
  ui_scale: z.number().default(1),
  variant: z.string().default(''),
  note: z.string().default(''),
  /** 本项是「每件的数量」→ 界面的总数 = 本项 × 件数 */
  unit_quantity: z.boolean().default(false),
});
export type PieceInput = z.infer<typeof PieceInputSchema>;

/**
 * 自由数值规格参数：取值是**连续量**（丝径 / 网高 / 间距 / 卷长 / 卷径 …）。
 *
 * 界面据此渲染**输入框**而不是下拉 —— 客户给 2.3mm 就是 2.3mm，不枚举。
 * 引擎只按 min/max 挡明显填错的，取值自由度保留；重量与价格由公式折算。
 * `default` / `min_value` / `max_value` 都是**字符串**（后端从 Decimal 转来，
 * 避免浮点尾差），界面按需解析。
 */
export const NumericInputSchema = z.object({
  key: z.string(),
  label: z.string(),
  label_en: z.string().default(''),
  /** 引擎内部单位（公式里用的那个） */
  unit: z.string().default(''),
  /** 界面呈现与输入用的单位（如 公分）；留空则同 unit */
  ui_unit: z.string().default(''),
  /** 界面值 = 引擎值 × ui_scale（m→cm 填 100） */
  ui_scale: z.number().default(1),
  default: z.string().nullable().default(null),
  min_value: z.string().nullable().default(null),
  max_value: z.string().nullable().default(null),
  decimals: z.number().int().nullable().default(null),
  note: z.string().default(''),
});
export type NumericInput = z.infer<typeof NumericInputSchema>;

// ── 定价数据（按产品定价键的客户成本表）────────────────────────────────────

/** 定价键的一个维度：取值 + 给人的显示名，全部来自产品定义。 */
export const PricingKeyDimSchema = z.object({
  field: z.string(),
  label: z.string(),
  unit: z.string().default(''),
  /**
   * `numeric` = 自由数值维度：**没有可选值清单**（连续量枚举不出来），
   * 界面渲染输入框而不是下拉。注意不能整维丢掉 —— 丢了界面少一列，
   * 而查价键仍带着这一维，就变成「存进去了但查不到」。
   */
  kind: z.enum(['axis', 'variant', 'numeric']).default('axis'),
  ui_unit: z.string().default(''),
  ui_scale: z.number().default(1),
  options: z.array(z.object({
    value: z.union([z.string(), z.number()]),
    label: z.string(),
  })),
});
export type PricingKeyDim = z.infer<typeof PricingKeyDimSchema>;

/** 定价矩阵的一格 = 一个定价键组合（客户配过的有 item_id，没配的为空）。 */
export const PricingCellSchema = z.object({
  key: z.string(),
  values: z.record(z.union([z.string(), z.number()])),
  labels: z.array(z.string()),
  amount: z.number().nullable(),
  unit: z.string().default(''),
  item_id: z.number().nullable().default(null),
  effective_from: z.string().nullable().default(null),
  /** manual = 客户自己配的；product_default = 尚未配置，用产品定义的兜底成本 */
  source: z.string().default(''),
  notes: z.string().nullable().default(null),
  configured: z.boolean(),
});
export type PricingCell = z.infer<typeof PricingCellSchema>;

export const PricingMatrixSchema = z.object({
  product_key: z.string(),
  product_name: z.string(),
  cost_unit: z.string().default(''),
  scope: z.enum(['own', 'all']),
  dims: z.array(PricingKeyDimSchema),
  rows: z.array(PricingCellSchema),
  /** scope=all 时才有：租户下每个客户的配置情况 */
  customers: z.array(z.object({
    customer_id: z.string(),
    rows: z.array(PricingCellSchema),
    configured_count: z.number().int(),
  })).optional(),
});
export type PricingMatrix = z.infer<typeof PricingMatrixSchema>;

export const SavePricingCellSchema = z.object({
  product_key: z.string(),
  values: z.record(z.union([z.string(), z.number()])),
  /** 客户自加档位的显示名（如「镀锌60g/㎡」）；已有档位不必给 */
  labels: z.record(z.string()).optional(),
  amount: z.number().positive(),
  unit: z.string().default(''),
  effective_from: z.string().optional(),
  notes: z.string().optional(),
});
export type SavePricingCell = z.infer<typeof SavePricingCellSchema>;

export const PackagingRangeSchema = z.object({
  /** 按哪个规格字段分档（如 height_m） */
  field: z.string(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  /** 元 / 卷 */
  amount: z.number(),
});
export type PackagingRange = z.infer<typeof PackagingRangeSchema>;

/** 产品包装方案（需求 20）：每个产品可用一种；默认包装自动应用。 */
export const PackagingOptionSchema = z.object({
  id: z.string(),
  name: z.string().default(''),
  method: z.string().default(''),
  is_default: z.boolean().default(false),
  /** 未设默认时按最早创建取默认（ISO 时间串） */
  created_at: z.string().nullable().optional(),
  mode: z.literal('per_piece').default('per_piece'),
  /** 元 / 卷（无区间命中时兜底） */
  amount: z.number().default(0),
  ranges: z.array(PackagingRangeSchema).default([]),
});
export type PackagingOption = z.infer<typeof PackagingOptionSchema>;

export const ProductFormulasResponseSchema = z.object({
  product_key: z.string(),
  name: z.string(),
  name_en: z.string().default(''),
  category_code: z.string().default(''),
  hs_codes: z.array(z.string()).default([]),
  /** 产品级默认利润/杂税（报价页首次打开时带入；本单可覆盖） */
  profit_mode: z.string().default('margin_on_price'),
  profit_value: z.number().default(0.06),
  misc_fee_rate: z.number().default(0.03),
  /** 包装方案：界面据此渲染包装选择/默认标识，并随报价下发 packaging_id */
  packaging: z.array(PackagingOptionSchema).default([]),
  cost: z.object({
    field: z.string(),
    basis: z.enum(['pretax', 'incl_tax']),
    unit: z.string().default(''),
    note: z.string(),
  }),
  space: z.object({
    axes: z.array(SpaceAxisSchema),
    variants: z.array(SpaceAxisSchema),
    combo_count: z.number().int(),
    summary: z.string(),
    formula: z.string(),
  }),
  /** 数量区可按件改写的规格参数（默认随变体联动，可覆盖） */
  piece_inputs: z.array(PieceInputSchema).default([]),
  /**
   * 自由数值规格参数（界面渲染输入框）。
   * **不参与 `space.combo_count`** —— 连续量没有"组合数"。
   */
  numeric_inputs: z.array(NumericInputSchema).default([]),
  /**
   * 定价键：决定「去定价数据里查哪一行」的维度组合（如牛栏网 = 边丝径 × 镀锌量）。
   * 维度与取值全部来自产品定义 —— 定价数据页据此画矩阵，前端不写死产品知识。
   */
  pricing_key: z.array(PricingKeyDimSchema).default([]),
  calculations: z.object({
    derived: z.array(MetricFormulaSchema),
    piece: z.array(MetricFormulaSchema),
    order: z.array(MetricFormulaSchema),
  }),
  space_deduction: SpaceDeductionSchema,
  invariants: z.array(z.object({
    label: z.string(),
    expr: z.string(),
    severity: z.string(),
  })),
  params: z.array(z.record(z.unknown())),
  notes: z.array(z.string()),
  constants: z.record(z.unknown()).default({}),
  columns: z.array(z.record(z.unknown())).optional(),
});
export type ProductFormulasResponse = z.infer<typeof ProductFormulasResponseSchema>;

/** 逐步代入：给规格取值，返回可核对的计算过程。 */
export const ExplainRequestSchema = z.object({
  spec: z.record(z.unknown()).default({}),
  total: z.number().positive().optional(),
  constants: z.record(z.unknown()).nullable().optional(),
  metrics: z.array(z.string()).nullable().optional(),
});
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;

export const ExplainStepSchema = z.object({
  code: z.string(),
  label: z.string(),
  stage: z.enum(['derived', 'piece', 'order']),
  expr: z.string(),
  unit: z.string(),
  decimals: z.number().int().nullable().optional(),
  note: z.string(),
  value: z.string().nullable(),
  error: z.string().optional(),
});
export type ExplainStep = z.infer<typeof ExplainStepSchema>;

export const ExplainResponseSchema = z.object({
  product_key: z.string(),
  product_name: z.string(),
  spec: z.record(z.unknown()),
  total: z.number().nullable().optional(),
  space_deduction: z.string(),
  steps: z.array(ExplainStepSchema),
  /** 价格类量不在本接口计算，此处列出被略过的 code */
  price_metrics_omitted: z.array(z.string()).optional(),
  price_hint: z.string().optional(),
});
export type ExplainResponse = z.infer<typeof ExplainResponseSchema>;

// ── 表格批量导入 ───────────────────────────────────────────────────────────

/** 一处导入问题：第几行 / 哪一列 / 什么值 / 期望什么。 */
export const ImportIssueSchema = z.object({
  /** 数据行号，从 1 开始（不含表头）；0 表示整表级问题 */
  row: z.number().int(),
  column: z.string(),
  value: z.string().nullable(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});
export type ImportIssue = z.infer<typeof ImportIssueSchema>;

/**
 * 预览结果：先看清解析成什么，再决定要不要算。
 *
 * `mapping` 说明「哪个表头落到了哪个字段」，用户据此确认自己列名对不对；
 * `ignored_columns` 是没参与计算的列（比如备注列），不算错误。
 */
export const ImportPreviewResponseSchema = z.object({
  product_key: z.string(),
  product_name: z.string(),
  source_name: z.string().default(''),
  total_data_rows: z.number().int(),
  usable_rows: z.number().int(),
  error_count: z.number().int(),
  warning_count: z.number().int(),
  mapping: z.record(z.string()),
  ignored_columns: z.array(z.string()).default([]),
  issues: z.array(ImportIssueSchema).default([]),
  /** 归一化后的规格行，可直接回传给「显式规格行」计算 */
  rows: z.array(z.record(z.unknown())).default([]),
  /** 该产品期望的表头（下载模板用同一套列名） */
  expected_columns: z.array(z.string()).default([]),
});
export type ImportPreviewResponse = z.infer<typeof ImportPreviewResponseSchema>;

/** 批量计算时附带的导入摘要。 */
export const ImportSummarySchema = z.object({
  source_name: z.string().default(''),
  total_data_rows: z.number().int(),
  usable_rows: z.number().int(),
  skipped_rows: z.number().int(),
  mapping: z.record(z.string()),
  ignored_columns: z.array(z.string()).default([]),
  issues: z.array(ImportIssueSchema).default([]),
});
export type ImportSummary = z.infer<typeof ImportSummarySchema>;

/** 显式规格行的回报：提交了几行、算了几行、跳过几行。 */
export const SpecRowsReportSchema = z.object({
  submitted: z.number().int(),
  computed: z.number().int(),
  skipped: z.number().int(),
});
export type SpecRowsReport = z.infer<typeof SpecRowsReportSchema>;

/** 批量计算响应 = 普通报价响应 + 导入摘要 + 行数回报。 */
export const ImportCalculateResponseSchema = ExportQuoteResponseSchema.extend({
  import: ImportSummarySchema.optional(),
  spec_rows: SpecRowsReportSchema.optional(),
});
export type ImportCalculateResponse = z.infer<typeof ImportCalculateResponseSchema>;

/**
 * 模板里的一列。
 *
 * 模板不是手写的一套表头，而是从产品声明反推出来的 ——
 * 与解析器共用同一处列名识别，所以「模板表头 = 导出表头 = 上传时认得的表头」。
 */
export const ImportTemplateColumnSchema = z.object({
  /** 写进模板的表头（与导出的报价表一致） */
  header: z.string(),
  /** variant = 关联属性包（一选全变）；scalar = 单值参数（含规格轴与可覆盖项） */
  kind: z.enum(['variant', 'scalar']),
  /** 落到引擎里的字段名（wire / height_m / roll_dia_m…） */
  target: z.string(),
  required: z.boolean(),
  /** 列名括号里的计量单位 */
  unit: z.string().default(''),
  /** 可选值（已按表头单位换算，如 100mm 的竖丝间距显示为 10 cm） */
  options: z.array(z.string()).default([]),
  note: z.string().default(''),
});
export type ImportTemplateColumn = z.infer<typeof ImportTemplateColumnSchema>;

/** 模板说明：页面据此讲清「该填哪些列」，并拼出下载链接。 */
export const ImportTemplateInfoSchema = z.object({
  product_key: z.string(),
  product_name: z.string(),
  columns: z.array(ImportTemplateColumnSchema),
  headers: z.array(z.string()),
  required_headers: z.array(z.string()),
  max_rows: z.number().int(),
  max_mb: z.number(),
  sheets: z.array(z.string()).default([]),
  /** 解析器实际读取的工作表名（其余工作表不会参与计算） */
  data_sheet: z.string(),
  download: z.record(z.string()),
  notes: z.array(z.string()).default([]),
});
export type ImportTemplateInfo = z.infer<typeof ImportTemplateInfoSchema>;

/** 模板可下载的格式。xlsx 给人填（带下拉与说明），csv 给脚本生成。 */
export const IMPORT_TEMPLATE_FORMATS = ['xlsx', 'csv'] as const;
export type ImportTemplateFormat = (typeof IMPORT_TEMPLATE_FORMATS)[number];

