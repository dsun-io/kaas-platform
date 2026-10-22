/**
 * 订单详情与金额构成（§13.3）—— 纯逻辑层。
 *
 * 契约口径（backend-money 2026-10-22 确认）：
 * - `amount_breakdown` 只存 **4 键**：goods_amount / freight_amount /
 *   insurance_amount / other_amount；**不存 total** —— 订单总额只认
 *   `orders.total_amount`（后端落库时若只给 breakdown 会按四项之和兜底）。
 * - 货物金额由货物明细汇总（数量 × 单价，允许直接改行金额）；
 *   订单总额 = 货物金额 + 运费 + 保险费 + 其他费用（前端只读展示）。
 * - 历史订单没有 breakdown（null）⇒ 展示时回退到「货物行合计 + total_amount」，
 *   不伪造四项拆分。
 *
 * 这里只放纯函数，网络访问在 `hooks/`，展示在 `components/`。
 */
import type { PaymentReceipt, PaymentSchedule } from "./payment-schedules";
import type { OrderOption } from "@/lib/workstation/use-upstream";

/** 订单金额构成（4 键；订单总额单独由 total_amount 承载） */
export interface AmountBreakdown {
  goods_amount: number;
  freight_amount: number;
  insurance_amount: number;
  other_amount: number;
}

/** 订单货物行（后端 `row_to_order_item` 的 11 键中前端要用的部分）。 */
export interface OrderItem {
  id?: number | null;
  sku_id?: number | null;
  product_name: string | null;
  spec_snapshot?: Record<string, unknown> | null;
  qty: number | null;
  qty_unit: string | null;
  unit_price: number | null;
  currency?: string | null;
  line_amount: number | null;
  sort_order?: number | null;
}

/** `GET /orders/{id}`：在列表行基础上补齐详情块。 */
export interface OrderDetail extends OrderOption {
  customer_id?: number | null;
  notes?: string | null;
  created_at?: string | null;
  fx_rate?: number | null;
  /** 历史订单为 null */
  amount_breakdown?: Partial<AmountBreakdown> | null;
  items?: OrderItem[];
  payment_schedules?: PaymentSchedule[];
  /** 后端 §13.3 起在详情里直接带实收记录；没有时回退单独接口 */
  receipts?: PaymentReceipt[];
}

export const EMPTY_AMOUNT_BREAKDOWN: AmountBreakdown = {
  goods_amount: 0,
  freight_amount: 0,
  insurance_amount: 0,
  other_amount: 0,
};

function toAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return 0;
}

/**
 * 容忍历史/半成品数据：缺失的键按 0 计，非法值按 0 计。
 * 返回 null 表示「这张订单没有金额构成」（历史订单）——调用方据此走回退展示。
 */
export function normalizeAmountBreakdown(
  raw: Partial<AmountBreakdown> | null | undefined,
): AmountBreakdown | null {
  if (!raw || typeof raw !== "object") return null;
  const keys: (keyof AmountBreakdown)[] = [
    "goods_amount",
    "freight_amount",
    "insurance_amount",
    "other_amount",
  ];
  const hasAny = keys.some((key) => raw[key] !== undefined && raw[key] !== null);
  if (!hasAny) return null;
  return {
    goods_amount: toAmount(raw.goods_amount),
    freight_amount: toAmount(raw.freight_amount),
    insurance_amount: toAmount(raw.insurance_amount),
    other_amount: toAmount(raw.other_amount),
  };
}

/** 单行金额：优先后端/用户给的 line_amount，否则 qty × unit_price。 */
export function orderItemAmount(item: OrderItem): number {
  if (typeof item.line_amount === "number" && Number.isFinite(item.line_amount)) {
    return item.line_amount;
  }
  const qty = toAmount(item.qty);
  const price = toAmount(item.unit_price);
  if (qty === 0 || price === 0) return 0;
  return Math.round(qty * price * 100) / 100;
}

/** 货物金额 = 所有行金额之和（两位小数）。 */
export function sumItemsAmount(items: OrderItem[] = []): number {
  return Math.round(
    items.reduce((sum, item) => sum + orderItemAmount(item), 0) * 100,
  ) / 100;
}

/** 订单总额 = 货物 + 运费 + 保险 + 其他（只读、自动算）。 */
export function sumAmountBreakdown(breakdown: AmountBreakdown): number {
  return (
    Math.round(
      (breakdown.goods_amount +
        breakdown.freight_amount +
        breakdown.insurance_amount +
        breakdown.other_amount) *
        100,
    ) / 100
  );
}

/** 由明细 + 三项手填费用组出 breakdown（总额另算，不进 body）。 */
export function buildAmountBreakdown(input: {
  goods: number;
  freight: number;
  insurance: number;
  other: number;
}): AmountBreakdown {
  return {
    goods_amount: roundMoney(input.goods),
    freight_amount: roundMoney(input.freight),
    insurance_amount: roundMoney(input.insurance),
    other_amount: roundMoney(input.other),
  };
}

/** 保留两位小数（负数原样保留，便于显示差异）。 */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/**
 * 详情展示用的金额构成：
 * - 有 breakdown ⇒ 用 breakdown（货物金额若为 0 但行项有值，用行项合计兜底，
 *   避免历史/手填不一致时空着）；
 * - 没有 breakdown ⇒ goods 用行项合计、其余为 0，并标记 `fallback=true`
 *   （页面据此提示"历史订单未拆费用"）。
 */
export function resolveAmountBreakdown(
  detail: Pick<OrderDetail, "amount_breakdown" | "items" | "total_amount">,
): { breakdown: AmountBreakdown; total: number; fallback: boolean } {
  const normalized = normalizeAmountBreakdown(detail.amount_breakdown);
  const itemsGoods = sumItemsAmount(detail.items ?? []);
  if (normalized) {
    const goods =
      normalized.goods_amount > 0 ? normalized.goods_amount : itemsGoods;
    const breakdown = { ...normalized, goods_amount: roundMoney(goods) };
    const total =
      typeof detail.total_amount === "number"
        ? roundMoney(detail.total_amount)
        : sumAmountBreakdown(breakdown);
    return { breakdown, total, fallback: false };
  }
  const breakdown = {
    ...EMPTY_AMOUNT_BREAKDOWN,
    goods_amount: roundMoney(itemsGoods),
  };
  const total =
    typeof detail.total_amount === "number"
      ? roundMoney(detail.total_amount)
      : sumAmountBreakdown(breakdown);
  return { breakdown, total, fallback: true };
}

/** 金额展示：币种 + 两位小数；null/undefined 显示「—」。 */
export function formatOrderMoney(
  value: number | null | undefined,
  currency?: string | null,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  const text = value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${text}` : text;
}

/** 日期展示：只保留 YYYY-MM-DD（后端给 ISO 串或 null）。 */
export function formatOrderDate(value: string | null | undefined): string {
  if (!value) return "—";
  return value.slice(0, 10);
}

/** 规格快照里的人类可读片段（单证描述优先；没有就展示原始值）。 */
export function orderItemSpecText(item: OrderItem): string {
  const spec = item.spec_snapshot;
  if (!spec || typeof spec !== "object") return "";
  const raw = spec.specification ?? spec.spec ?? spec.description;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return "";
}

/** 货物明细合计与订单总额的差异（用于详情页提示，不阻断任何操作）。 */
export function itemsVsTotalDifference(
  items: OrderItem[],
  total: number | null,
): number | null {
  if (typeof total !== "number" || !Number.isFinite(total)) return null;
  return roundMoney(sumItemsAmount(items) - total);
}
