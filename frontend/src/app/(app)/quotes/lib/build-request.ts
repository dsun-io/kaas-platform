/**
 * 组装一行算价请求（**唯一实现**：单产品与多产品工作台共用）。
 *
 * 为什么集中在这里：报价政策（税率 / 让利 / 利润）与贸易术语的映射一旦写两处，
 * 同一个工位就会算出两套口径的价 —— 而两边的金额都"看起来正常"，不会报错。
 * 单产品视图退役后，本文件是唯一的下发口径。
 */
import type {
  ExportQuoteRequest,
  ExportTermsTemplate,
  PieceInput,
} from "@contracts/export-quote";

import type { BuiltTerms } from "./terms-amortize";

/** 印花税计税基数（与后端 policy.stamp_base 取值一致）。 */
export type StampBase = "" | "profit" | "cost" | "base_quote";

/** 加工利润的两种给法：固定金额（元/kg）或按税前成本的百分比。 */
export type ProfitMode = "fixed" | "ratio";

/** 整单级共享参数：所有产品行共用（币种/汇率/日期/税率/术语）。 */
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
  stampRatePct: string;
  stampBase: StampBase;
  /** 整单默认的加工利润 */
  profitMode: ProfitMode;
  profitValue: string;
}

/** 百分比输入 → 比例值（10 → 0.1）。 */
function pct(text: string): number {
  return (Number(text) || 0) / 100;
}

/**
 * 单行请求。
 *
 * `profitOverride`（元/kg）是**逐行覆盖**：不同产品的加工利润常常不同
 * （供货厂、工序、竞争情况都不一样），整单默认只是"懒得逐行填"时的兜底，
 * 不是强制口径。留空 = 继承整单默认。
 */
export function buildLineRequest(args: {
  productKey: string;
  /** 该产品选定的规格行（引擎取值） */
  spec: Record<string, unknown>;
  /** 按件改写（引擎单位） */
  variantOverrides?: Record<string, Record<string, Record<string, number>>>;
  /** 总数（引擎单位，如米） */
  total: number;
  unit: string;
  /** 逐行覆盖的加工利润（元/kg，fixed 模式）；留空继承整单 */
  profitOverride?: string;
  /**
   * 本行的贸易术语（**每行一份**）——整批费用已按件数分摊，见 terms-amortize.ts。
   * 未传则不发生术语阶梯 → 只算 EXW（出厂价）。
   */
  terms?: BuiltTerms | null;
  shared: SharedQuoteParams;
}): ExportQuoteRequest {
  const { shared } = args;
  const override = (args.profitOverride ?? "").trim();
  const useOverride = override !== "" && Number(override) > 0;
  const profitMode: ProfitMode = useOverride ? "fixed" : shared.profitMode;
  const profitValue = useOverride ? Number(override) : Number(shared.profitValue) || 0;

  return {
    product_key: args.productKey,
    rate_set_code: shared.rateSetCode || undefined,
    fx_rate: Number(shared.fxRate) || 0,
    // 汇率由报价人按报价当日填写（后续可改为系统维护当期汇率、自动带入）
    fx_source: "manual",
    orders: [{ total: args.total, unit: args.unit }],
    spec_rows: [args.spec],
    variant_overrides: args.variantOverrides ?? null,
    with_verification: false,
    currency: "CNY",
    quote_currency: shared.quoteCurrency,
    validity_days: Number(shared.validityDays) || 7,
    // 报价日期决定按哪一天解析税务档案（政策换档后补历史单子要用它）；留空 = 今天
    quote_date: shared.quoteDate || undefined,
    // 贸易术语：整单一次填、按**件数比例**分摊给每一行后下发（见 terms-amortize.ts）。
    // 形状就是后端声明的 terms 结构（结构由平台给、界面原样回传），
    // 所以这里只做类型收敛，不做任何结构转换 —— 转换一份就会与后端声明漂移。
    terms: (args.terms ?? null) as Record<string, unknown> | null,
    // 政策覆盖项：**留空即取税务档案的法定值**，填了才覆盖（本单专用）。
    // 这样国家调税率只需新增一份档案，前端不动、代码不动。
    policy: {
      input_vat_rate: pct(shared.inputVatRatePct),
      give_ratio: pct(shared.giveRatioPct),
      // 销项税按业务实际填（出口 0、内销 13…）。刻意不做"选出口就自动 0"这类推导
      output_vat_rate: pct(shared.outputVatRatePct),
      // 出口退税率：**只在填了的时候下发**。留空时引擎按「未核实」处理并给提示，
      // 不能被一个默认 0 覆盖 —— 0 与"没填"是两件事：0 会把可退额直接压成 0。
      ...(shared.rebateRatePct !== ""
        ? { rebate_rate: pct(shared.rebateRatePct) }
        : {}),
      // 印花税同理：留空 = 用档案里的法定值，填了 = 本单覆盖
      ...(shared.stampRatePct !== ""
        ? { stamp_rate: pct(shared.stampRatePct) }
        : {}),
      ...(shared.stampBase ? { stamp_base: shared.stampBase } : {}),
      profit_mode: profitMode,
      profit_value: profitMode === "ratio" ? profitValue / 100 : profitValue,
    },
  };
}

/**
 * 按件参数的默认值：从**当前选中的变体选项**的属性里读。
 *
 * 界面只做"读产品定义 + 单位换算"，不拥有任何产品知识 ——
 * 换产品/改规格，默认值自动跟着变。
 */
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

/** 界面单位 ÷ 引擎单位的倍数（米 → 公分 = 100）。界面只换算，不懂业务单位。 */
export function pieceScale(pi: PieceInput): number {
  return pi.ui_scale && pi.ui_scale > 0 ? pi.ui_scale : 1;
}

/** 消除浮点噪声（0.3 × 100 会得到 30.000000000000004）。 */
export function scale6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * 把用户填的**整单**费用金额套到模板上（单产品路径用；多产品走 amortizeTerms）。
 */
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
