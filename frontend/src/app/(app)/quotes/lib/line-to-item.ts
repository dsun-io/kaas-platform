/**
 * 算价结果 → 报价单行项（进而是单证的行项）。**纯函数，可单测。**
 *
 * 为什么要单独一个模块：
 *  1. "哪一列是单卷外币价"必须由**产品定义**回答（`formulas.columns` 的 `key`），
 *     而不是前端按表头中文名去猜 —— 猜法一旦漂移，落库的单价就会错列，
 *     而金额看起来仍然"像个数"，不会报错。
 *  2. 汇总口径与单证 TOTAL 行的口径必须**同源**：两边都是"逐行求和"，
 *     行小计都取 `卷数 × 单卷外币价`（精确相乘，不预先舍入）。
 *     口径写在两处就会两处不一致，所以集中在本文件，并配单测卡住。
 *
 * 数量口径（D3，用户 2026-09-27 决定，依据见 docs/MULTI_PRODUCT_QUOTE_PLAN.md §10）：
 *   `Quantity = 卷数`、`Unit = ROLLS`、`Unit Price = 单卷外币价`，
 *   每卷多少米写进 `Specification`（并另给总米数用于汇总展示）。
 *   不把"按米"当主口径：引擎只有人民币/米列，外币反算的 4 位舍入会破坏
 *   `单价 × 数量 = 总价`，而那正是审单最容易抓的不符点。
 */
import type {
  ExportProduct,
  ExportQuoteResponse,
  ProductFormulasResponse,
  QuoteTable,
} from "@contracts/export-quote";
import type { QuoteOrderItemIn } from "@contracts/quote-order";
import { QTY_UNIT_ROLLS } from "@contracts/quote-order";
import {
  buildSpecification,
  type SpecValues,
} from "@/lib/trade-doc/spec-to-text";

export type QuoteView = "customer" | "internal";

/** 行小计保留 2 位的**显示**口径；参与计算的原始值不做预舍入（见文件头说明）。 */
export const AMOUNT_DECIMALS = 2;

/** 引擎列键（写在这里是为了让"取哪一列"可被 grep 到并被单测覆盖）。 */
export const COL = {
  /** 单卷外币价（报价币种/卷，4 位） */
  unitPriceFx: "piece.price_per_piece_fx",
  /** 单卷净重（kg） */
  netWeightPerPiece: "derived.weight_per_piece_kg",
  /** 单卷长方体体积（m³）—— 对外报运价/报关的体积口径 */
  boxVolumePerPiece: "derived.volume_box_per_piece_m3",
  /** 单卷净体积（m³，圆柱体） */
  netVolumePerPiece: "derived.volume_per_piece_m3",
} as const;

interface FormulaColumn {
  key?: unknown;
  label?: unknown;
  label_en?: unknown;
  internal?: unknown;
}

/**
 * 结果表里的列顺序 == 产品定义列顺序（客户视图 = 剔除 internal 列后的顺序）。
 * 因此"列键 → 下标"必须用同一份产品定义算出来，不能用表头文字匹配。
 */
export function visibleColumnKeys(
  formulas: ProductFormulasResponse,
  view: QuoteView,
): string[] {
  const cols = (formulas.columns ?? []) as FormulaColumn[];
  const list = view === "internal" ? cols : cols.filter((c) => !c.internal);
  return list.map((c) => String(c.key ?? ""));
}

/** 列键 → 在下标数组中的位置；找不到返回 -1（调用方据此判定"产品没声明这一列"）。 */
export function makeColumnIndexer(
  formulas: ProductFormulasResponse,
  view: QuoteView,
): (key: string) => number {
  const keys = visibleColumnKeys(formulas, view);
  return (key: string) => keys.indexOf(key);
}

function pickTable(result: ExportQuoteResponse, view: QuoteView): QuoteTable {
  return view === "internal" && result.internal
    ? result.internal
    : result.customer;
}

/** 取一行（默认第 0 行）里某列的值；列不存在或非数值 → null。 */
function readCell(
  result: ExportQuoteResponse,
  view: QuoteView,
  indexOf: (key: string) => number,
  key: string,
  rowIndex = 0,
): number | null {
  const index = indexOf(key);
  if (index < 0) return null;
  const row = pickTable(result, view).rows[rowIndex];
  if (!row) return null;
  const value = row[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 内部分解（成本/利润）快照 —— 读 internal 视图的价链列。
 * 列键由产品定义声明（产品没声明的列读不到即省略），引擎单位：
 * `price.*` 是每平方米人民币价链，`piece.*` 是单件价。
 */
const INTERNAL_COST_KEYS = {
  cost_pretax: "price.cost_pretax",
  cost_incl: "price.cost_incl",
  profit_amount: "price.profit_amount",
  quote_excl_vat: "price.quote_excl_vat",
  output_vat: "price.output_vat",
  quote_incl_vat: "price.quote_incl_vat",
} as const;

function buildCostBreakdown(
  result: ExportQuoteResponse,
  formulas: ProductFormulasResponse,
  pieces: number,
  unitPriceFx: number,
): Record<string, unknown> {
  const indexOf = makeColumnIndexer(formulas, "internal");
  const perM2: Record<string, number> = {};
  for (const [label, key] of Object.entries(INTERNAL_COST_KEYS)) {
    const value = readCell(result, "internal", indexOf, key);
    if (value !== null) perM2[label] = value;
  }
  const pricePerPiece = readCell(
    result,
    "internal",
    indexOf,
    "piece.price_per_piece",
  );
  return {
    view: "internal",
    currency_cny_per_m2: perM2,
    per_piece: {
      price_cny: pricePerPiece,
      price_fx: unitPriceFx,
    },
    pieces,
  };
}

export interface BuildLineItemInput {
  product: Pick<ExportProduct, "key" | "name" | "name_en" | "hs_codes">;
  formulas: ProductFormulasResponse;
  spec: SpecValues;
  /** 按件改写的参数（**引擎单位**），如 `{ roll_len_m: 50, roll_dia_m: 0.3 }` */
  pieceBase?: Record<string, number | null | undefined>;
  result: ExportQuoteResponse;
  view: QuoteView;
  /** 件数 = 卷数 */
  pieces: number;
  /** 单件米数（引擎单位 m）；缺省则由规格变体的默认值决定，调用方负责传入 */
  rollLengthM?: number | null;
}

/** 单证/台账要的申报要素（与后端 `_SPEC_FIELDS` 的键名保持一致）。 */
export interface LineDeclaredFields {
  specification: string;
  hs_code?: string;
  /** 件数（Packages）= 卷数 */
  package?: number;
  gross_weight?: number;
  net_weight?: number;
  volume?: number;
}

export interface BuiltLineItem {
  /** 直接可提交给 `PUT /quotes/{id}/items` 的行项 */
  item: QuoteOrderItemIn & {
    line_amount: number;
    spec_snapshot: Record<string, unknown>;
  };
  /** 汇总用指标（不进数据库行项，落在 spec_snapshot 与界面汇总里） */
  metrics: {
    meters: number;
    netWeight: number;
    grossWeight: number;
    boxVolume: number;
    unitPriceFx: number;
  };
  /**
   * 缺失的申报要素键名（界面据此标黄）。
   * **不静默补 0** —— 报关表上印一个 0 重量比空白更危险。
   */
  missing: string[];
}

/**
 * 组装一行。返回值里的 `item` 可直接进报价单；`metrics` 用于汇总与单证要素。
 *
 * 重量口径：产品定义为**无包装**（`field_fence.py` notes #8「包装均为无包装」），
 * 因此毛重 = 净重。将来出现带包装的产品，应在产品定义里声明包装重量，
 * 而不是在这里凭经验加系数。
 */
export function buildLineItem(input: BuildLineItemInput): BuiltLineItem {
  const { product, formulas, spec, pieceBase, result, view, pieces } = input;
  const indexOf = makeColumnIndexer(formulas, view);

  const unitPriceFx = readCell(result, view, indexOf, COL.unitPriceFx) ?? 0;
  const netWeightPerPiece =
    readCell(result, view, indexOf, COL.netWeightPerPiece) ?? 0;
  const boxVolumePerPiece =
    readCell(result, view, indexOf, COL.boxVolumePerPiece) ?? 0;

  const specification = buildSpecification({ formulas, spec, pieceBase });
  const rollLengthM =
    input.rollLengthM === undefined || input.rollLengthM === null
      ? null
      : input.rollLengthM;

  const netWeight = netWeightPerPiece * pieces;
  const boxVolume = boxVolumePerPiece * pieces;
  const meters = rollLengthM === null ? 0 : rollLengthM * pieces;
  const lineAmount = unitPriceFx * pieces;

  const declared: LineDeclaredFields = {
    specification,
    hs_code: product.hs_codes?.[0],
    package: pieces,
    gross_weight: netWeight,
    net_weight: netWeight,
    volume: boxVolume,
  };

  const missing: string[] = [];
  if (!specification) missing.push("specification");
  if (!declared.hs_code) missing.push("hs_code");
  if (!(netWeight > 0)) missing.push("net_weight");

  const specSnapshot: Record<string, unknown> = {
    ...declared,
    product_key: product.key,
    /** 中文名留档：台账/内部沟通要看中文，单证只印英文（英文单据硬约定） */
    product_name_zh: product.name,
    /** 引擎原始规格（审计与重算的唯一依据） */
    specs: spec,
    ...(pieceBase ? { piece_overrides: pieceBase } : {}),
    ...(rollLengthM !== null ? { roll_len_m: rollLengthM } : {}),
    unit_price_fx: unitPriceFx,
  };

  // 内部分解快照（UNCERTAIN #19）：internal 视图把算价引擎的成本/利润列一并
  // 带进 cost_breakdown 落库——历史报价对内视图与参考价的核算依据。
  // customer 视图不带（后端也不会存出内部列）。
  const costBreakdown =
    view === "internal"
      ? buildCostBreakdown(result, formulas, pieces, unitPriceFx)
      : undefined;

  return {
    item: {
      product_name: product.name_en || product.name,
      // 数量口径：卷数 + ROLLS（见文件头 D3 说明）
      qty: pieces,
      qty_unit: QTY_UNIT_ROLLS,
      unit_price: unitPriceFx,
      line_amount: lineAmount,
      spec_snapshot: specSnapshot,
      sort_order: 0, // 由调用方按行序覆盖
      ...(costBreakdown ? { cost_breakdown: costBreakdown } : {}),
    },
    metrics: {
      meters,
      netWeight,
      grossWeight: netWeight,
      boxVolume,
      unitPriceFx,
    },
    missing,
  };
}

export interface QuoteSummary {
  lineCount: number;
  totalQty: number;
  totalMeters: number;
  totalNetWeight: number;
  totalGrossWeight: number;
  /** 长方体体积逐行累加（**未**扣减体积扣减项） */
  totalBoxVolume: number;
  /** Σ 行小计 —— 与单证 TOTAL 行同源同算法 */
  totalAmount: number;
}

/** 汇总：全部按"逐行求和"计算，与单证渲染器的 AUTO_SUMS / TOTAL_SOURCE 一致。 */
export function summarizeLines(lines: BuiltLineItem[]): QuoteSummary {
  const summary: QuoteSummary = {
    lineCount: lines.length,
    totalQty: 0,
    totalMeters: 0,
    totalNetWeight: 0,
    totalGrossWeight: 0,
    totalBoxVolume: 0,
    totalAmount: 0,
  };
  for (const line of lines) {
    summary.totalQty += line.item.qty;
    summary.totalMeters += line.metrics.meters;
    summary.totalNetWeight += line.metrics.netWeight;
    summary.totalGrossWeight += line.metrics.grossWeight;
    summary.totalBoxVolume += line.metrics.boxVolume;
    summary.totalAmount += line.item.line_amount;
  }
  return summary;
}

/**
 * 体积口径：产品定义可声明"每单扣减一次"的占用空间扣减项
 * （牛栏网为 2.5 m³，见 `field_fence.py` 的 `space_deduction`）。
 *
 * 判定不写死产品：只有声明了 `mode` 且语义是**每单一次**时才扣减，
 * 其余情况一律不扣（宁可不扣，也不能把客户体积算小 —— 运价少报是实打实的损失）。
 */
export function applySpaceDeduction(
  totalBoxVolume: number,
  deduction?: { mode?: unknown; value?: unknown } | null,
): number {
  const mode = String(deduction?.mode ?? "");
  const value = Number(deduction?.value);
  const perOrder = /order|shipment|single/i.test(mode);
  if (!perOrder || !Number.isFinite(value) || value <= 0) return totalBoxVolume;
  return Math.max(0, totalBoxVolume - value);
}
