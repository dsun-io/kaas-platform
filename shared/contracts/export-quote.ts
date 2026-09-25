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
  profit_mode: z.enum(['fixed', 'ratio']).optional(),
  profit_value: z.number().optional(),
  /** 让出可退进项增值税额的比例（0.8 = 让利 80%，自留 20% 对冲风险） */
  give_ratio: z.number().min(0).max(1).optional(),
  /** 可退税比例；'auto' = 出口退税率 ÷ 征税率 */
  refund_ratio: z.union([z.number().min(0).max(1), z.literal('auto')]).optional(),
  /** 出口退税率（refund_ratio='auto' 时使用） */
  rebate_rate: z.number().min(0).max(1).optional(),
  /** 征税率（refund_ratio='auto' 时使用） */
  levy_rate: z.number().min(0).max(1).optional(),
  stamp_rate: z.number().min(0).max(1).optional(),
  /** 印花税计税基数；默认按加工利润 */
  stamp_base: z.enum(['profit', 'cost', 'base_quote']).optional(),
  extras: z.array(z.record(z.unknown())).optional(),
});
export type ExportPolicyIn = z.infer<typeof ExportPolicyInSchema>;

export const ExportQuoteRequestSchema = z.object({
  /** 产品模型 key，如 field_fence（牛栏网）、welded_pipe（焊管） */
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
  levy_rate: z.number().nullable(),
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

export const ProductFormulasResponseSchema = z.object({
  product_key: z.string(),
  name: z.string(),
  name_en: z.string().default(''),
  category_code: z.string().default(''),
  hs_codes: z.array(z.string()).default([]),
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

