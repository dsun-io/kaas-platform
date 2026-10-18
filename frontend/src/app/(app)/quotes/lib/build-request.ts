/**
 * 组装一行算价请求（**唯一实现**：多产品工作台共用）。
 *
 * 2026-10-18 口径（用户确认）：
 *  - 利润只有**利润率**，走引擎的 `margin_on_price`；
 *  - 杂税 = 单一「杂税率（%）」= 引擎 `misc_fee_rate`（不再有印花税率/计税基数）；
 *  - 贸易条款由界面直选（默认 EXW），`terms.quote_as` 必须等于所选条款；
 *  - 包装按行选（缺省 = 产品默认包装），`packaging_id` 随请求下发；
 *  - 汇率语义 = **1 报价币 = ? CNY**（引擎 `price_per_piece / fx_rate`）。
 */
import type {
  ExportQuoteRequest,
  ExportTermsTemplate,
  PieceInput,
} from "@contracts/export-quote";

import type { BuiltTerms } from "./terms-amortize";

/** 加工利润只保留「利润率」一种口径（售价毛利）。 */
export type ProfitMode = "margin_on_price";

/** 整单级共享参数：所有产品行共用。 */
export interface SharedQuoteParams {
  rateSetCode: string;
  fxRate: string;
  quoteCurrency: string;
  quoteDate: string;
  validityDays: string;
  /** 一律按百分比填写（10 = 10%），下发时除以 100 */
  inputVatRatePct: string;
  giveRatioPct: string;
  outputVatRatePct: string;
  rebateRatePct: string;
  /** 杂税率（%）：综合税费系数，默认 3 */
  miscTaxPct: string;
  /** 整单默认利润率（%） */
  profitPct: string;
}

/** 百分比输入 → 比例值（10 → 0.1）。 */
function pct(text: string): number {
  return (Number(text) || 0) / 100;
}

/**
 * 单行请求。
 *
 * `profitPctOverride`（%）是逐行覆盖：不同产品毛利不同；留空 = 继承整单默认。
 */
export function buildLineRequest(args: {
  productKey: string;
  spec: Record<string, unknown>;
  variantOverrides?: Record<string, Record<string, Record<string, number>>>;
  /** 没有可选变体档位时，把成本字段作为常量覆盖传给引擎 */
  constantsOverrides?: Record<string, unknown>;
  total: number;
  unit: string;
  /** 逐行覆盖的利润率（%）；留空继承整单 */
  profitPctOverride?: string;
  terms?: BuiltTerms | null;
  /** 本行包装（产品 packaging[].id）；空 = 默认包装 */
  packagingId?: string;
  shared: SharedQuoteParams;
}): ExportQuoteRequest {
  const { shared } = args;
  const override = (args.profitPctOverride ?? "").trim();
  const useOverride = override !== "";
  const profitPct = useOverride ? Number(override) : Number(shared.profitPct) || 0;

  return {
    product_key: args.productKey,
    rate_set_code: shared.rateSetCode || undefined,
    fx_rate: Number(shared.fxRate) || 0,
    fx_source: "manual",
    orders: [{ total: args.total, unit: args.unit }],
    spec_rows: [args.spec],
    variant_overrides: args.variantOverrides ?? null,
    constants_override: args.constantsOverrides ?? null,
    with_verification: false,
    currency: "CNY",
    quote_currency: shared.quoteCurrency,
    validity_days: Number(shared.validityDays) || 30,
    quote_date: shared.quoteDate || undefined,
    terms: (args.terms ?? null) as Record<string, unknown> | null,
    packaging_id: args.packagingId || null,
    policy: {
      input_vat_rate: pct(shared.inputVatRatePct),
      give_ratio: pct(shared.giveRatioPct),
      output_vat_rate: pct(shared.outputVatRatePct),
      ...(shared.rebateRatePct !== ""
        ? { rebate_rate: pct(shared.rebateRatePct) }
        : {}),
      // 杂税 = 综合税费系数（用户口径：3% 就是这项要填的值）
      misc_fee_rate: pct(shared.miscTaxPct),
      profit_mode: "margin_on_price",
      profit_value: profitPct / 100,
    },
  };
}

/** 按件参数的默认值：从当前选中变体选项的属性里读。 */
export function pieceDefault(
  axesAndVariants: Array<{
    name: string;
    options: Array<{ value?: unknown; attributes?: Record<string, unknown> }>;
  }>,
  spec: Record<string, unknown>,
  variant: string,
  key: string,
): string {
  const group = axesAndVariants.find((g) => g.name === variant);
  if (!group) return "";
  const selected = spec[variant];
  const option = group.options.find(
    (o) => String(o.value) === String(selected),
  );
  const raw = option?.attributes?.[key];
  return raw === undefined || raw === null ? "" : String(raw);
}

/** 界面单位 ÷ 引擎单位的倍数（米 → 公分 = 100）。 */
export function pieceScale(pi: PieceInput): number {
  return pi.ui_scale && pi.ui_scale > 0 ? pi.ui_scale : 1;
}

/** 消除浮点噪声（0.3 × 100 会得到 30.000000000000004）。 */
export function scale6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** 把用户填的整单费用金额套到模板上（保留给单产品路径/测试）。 */
export function plainTerms(
  template: ExportTermsTemplate,
  amounts: Record<string, number>,
): BuiltTerms {
  const items: Record<string, unknown> = {};
  for (const [key, fee] of Object.entries(template.items ?? {})) {
    items[key] = { ...fee, value: Number(amounts[key]) || 0 };
  }
  return {
    base: template.base,
    quote_as: template.quote_as,
    weight_field: template.weight_field,
    items,
    ladder: template.ladder,
  };
}
