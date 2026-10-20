/**
 * 单证编辑「金额摘要条」的纯函数（A5-W3）
 *
 * 为什么单独一个文件、而不是在组件里现算
 * --------------------------------------
 * 摘要条必须与**渲染**同口径：双币种换算、舍入、定金/尾款、应付总额都在
 * `render.ts::computeFxBreakdown` 里（A6-1 已与后端对齐）。这里**只 import 复用它**，
 * 一行公式都不重写 —— 两份公式必然漂移，而漂移的后果是"编辑页看到 2826.49、
 * 打出来 2826.78"（审单直接退单）。
 *
 * 容差同理：金额差异的容差与内核 `kaas_common.trade_doc.facts.amount_tolerance`
 * **同口径**（`max(5 美分等值, |金额| × 0.1%)`），前端唯一实现是
 * `lib/trade-doc/hardening.ts` 的 `receiptTolerance`（收款核销也用同一把尺子），
 * 这里直接复用，不定义第二个阈值。
 *
 * 只读原则：本模块只**读** payload 推导金额，不产出任何可回写的字段 ——
 * 金额的真源是单据 payload（后端单一来源推导，A7 闸门兜底）。
 */
import { amountInWords, computeFxBreakdown } from "./render";
import { receiptTolerance } from "./hardening";

/** 上游快照（`raw_payload.sources`）——冻结的订单/报价摘要 */
export interface UpstreamSnapshot {
  order?: Record<string, unknown>;
  quote?: Record<string, unknown>;
}

export interface UpstreamAmount {
  label: "order" | "quote";
  total: number;
  currency: string;
}

/** 与上游的差额（同币种才比；跨币种无汇率时给 null，不硬比） */
export interface AmountDiff {
  amount: number;
  currency: string;
  tolerance: number;
  /** 差额超出容差 ⇒ 界面红标（同口径：max(5 美分等值, 0.1%)） */
  overTolerance: boolean;
}

export interface AmountWords {
  /** 金额大写（英文，报关/信用证审单用）；金额非法时为空串 */
  text: string;
  amount: number | null;
  currency: string;
}

export interface AmountSummary {
  docType: string;
  /** 是否双币种（PI/CI 且有 fx_rate>0）；false ⇒ 只显示单币种摘要 */
  hasFx: boolean;
  lineCount: number;
  /** 行合计（CNY）——双币种时 = Σ 行本币金额；非双币种为 null */
  lineCny: number | null;
  /** 行合计（USD）——双币种时 = Σ 行外币金额；非双币种为 null */
  lineUsd: number | null;
  /** 货物总值（可能被显式 `total_goods_value_*` 覆盖，未必等于行合计） */
  goodsCny: number | null;
  goodsUsd: number | null;
  payableCny: number | null;
  payableUsd: number | null;
  words: AmountWords;
  upstream: UpstreamAmount | null;
  diff: AmountDiff | null;
  /** 单币种摘要（无 fx_rate / 非 PI-CI 时用）：金额 = 行合计，币种 = 单据币种 */
  single: { amount: number; currency: string } | null;
}

/** 与后端 `PROTECTED_CUSTOM_FIELDS` 同义：金额/行项不接受 custom 覆盖 */
const PROTECTED_CUSTOM_KEYS = new Set(["items", "total_amount"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

/** 两位小数（只用于展示层的求和/比较，换算公式一律用 computeFxBreakdown） */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * 把「正在编辑的 custom」叠到装配后的渲染数据上（不落库，仅供摘要条即时预览）。
 *
 * 语义与后端 `payload_shared.build_render_data` 的 custom 合并一致：
 * **受保护字段（items / total_amount）跳过** —— 界面上它们本来也是只读的，
 * 这里再挡一次，避免摘要条出现"手填金额"的假来源。
 */
export function effectivePayload(
  base: Record<string, unknown> | null | undefined,
  custom: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(custom ?? {})) {
    if (PROTECTED_CUSTOM_KEYS.has(key)) continue;
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** 从 `sources` 取上游金额（订单优先，退化到报价；与 `_domain_docs` 同序） */
export function upstreamAmountOf(
  sources: UpstreamSnapshot | null | undefined,
  fallbackCurrency = "USD",
): UpstreamAmount | null {
  const order = asRecord(sources?.order);
  const quote = asRecord(sources?.quote);
  for (const [label, snapshot] of [
    ["order", order],
    ["quote", quote],
  ] as const) {
    if (!snapshot) continue;
    const total = numeric(snapshot.total_amount);
    if (total === null) continue;
    const currency = String(snapshot.currency ?? fallbackCurrency ?? "USD")
      .trim()
      .toUpperCase() || "USD";
    return { label, total, currency };
  }
  return null;
}

function itemRows(data: Record<string, unknown>): Record<string, unknown>[] {
  const raw = Array.isArray(data.items) ? data.items : [];
  return raw
    .map((row) => asRecord(row))
    .filter((row): row is Record<string, unknown> => row !== null);
}

/** 非双币种时：行合计 = Σ round2(qty × unit_price)（单据币种） */
function singleCurrencyLineTotal(data: Record<string, unknown>): number {
  let sum = 0;
  for (const row of itemRows(data)) {
    const qty = numeric(row.qty) ?? 0;
    const price = numeric(row.unit_price) ?? 0;
    sum += round2(qty * price);
  }
  return round2(sum);
}

/**
 * 金额摘要（只读）。
 *
 * @param input.docType 单证类型（决定是否双币种：只有 pi/ci 且 fx_rate>0 才走双币种）
 * @param input.data    装配后的渲染数据（含 items/currency/与 custom 的合并结果）
 * @param input.sources 上游快照（`raw_payload.sources`）；有则显示「与订单差额」
 */
export function summarizeAmounts(input: {
  docType: string;
  data: Record<string, unknown> | null | undefined;
  sources?: UpstreamSnapshot | null;
}): AmountSummary {
  const data = input.data ?? {};
  const docType = input.docType;
  const breakdown = computeFxBreakdown(docType, data);
  const rows = itemRows(data);
  const docCurrency = String(data.currency ?? "USD").trim().toUpperCase() || "USD";

  if (!breakdown) {
    const lineTotal = singleCurrencyLineTotal(data);
    const upstream = upstreamAmountOf(input.sources, docCurrency);
    const singleDiff =
      upstream && upstream.currency === docCurrency
        ? buildDiff(upstream.total, lineTotal, docCurrency)
        : null;
    return {
      docType,
      hasFx: false,
      lineCount: rows.length,
      lineCny: null,
      lineUsd: null,
      goodsCny: null,
      goodsUsd: null,
      payableCny: null,
      payableUsd: null,
      words: {
        text: amountInWords(lineTotal, docCurrency),
        amount: lineTotal,
        currency: docCurrency,
      },
      upstream,
      diff: singleDiff,
      single: { amount: lineTotal, currency: docCurrency },
    };
  }

  // 行合计 = 逐行金额之和（行金额在 computeFxBreakdown 里已按 2 位舍入）
  let lineCny = 0;
  let lineUsd = 0;
  for (const line of breakdown.lines) {
    lineCny += line.amountCny;
    lineUsd += line.amountUsd;
  }

  const upstream = upstreamAmountOf(input.sources, docCurrency);
  let diff: AmountDiff | null = null;
  if (upstream && breakdown.payableUsd !== null) {
    if (upstream.currency === "USD") {
      diff = buildDiff(upstream.total, breakdown.payableUsd, "USD");
    } else if (
      upstream.currency === docCurrency &&
      breakdown.payableCny !== null
    ) {
      diff = buildDiff(upstream.total, breakdown.payableCny, docCurrency);
    }
    // 币种既不是 USD 也不是单据币种：没有对应汇率可比 ⇒ 不硬比（界面上只显示上游金额）
  }

  const wordsAmount = breakdown.payableUsd ?? breakdown.goodsUsd;
  return {
    docType,
    hasFx: true,
    lineCount: breakdown.lines.length,
    lineCny: round2(lineCny),
    lineUsd: round2(lineUsd),
    goodsCny: breakdown.goodsCny,
    goodsUsd: breakdown.goodsUsd,
    payableCny: breakdown.payableCny,
    payableUsd: breakdown.payableUsd,
    words: {
      text:
        wordsAmount === null ? "" : amountInWords(wordsAmount, "USD"),
      amount: wordsAmount,
      currency: "USD",
    },
    upstream,
    diff,
    single: null,
  };
}

/** 差额 + 容差（容差口径 = 内核 amount_tolerance / 收款核销的同一把尺子） */
function buildDiff(
  upstreamTotal: number,
  current: number,
  currency: string,
): AmountDiff {
  const amount = round2(current - upstreamTotal);
  const tolerance = receiptTolerance(
    currency,
    Math.max(Math.abs(upstreamTotal), Math.abs(current)),
  );
  return {
    amount,
    currency,
    tolerance: round2(tolerance),
    overTolerance: Math.abs(amount) > tolerance + 1e-9,
  };
}
