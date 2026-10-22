/**
 * 手工建单向导的草稿 → 请求体（§13.3 + §6 四步向导）。
 *
 * 用手工新建的两种真实场景：
 * 1. **历史订单/线下成交**：客户必选、报价可选；有报价就按转单处理（后端继承条款/行项）；
 * 2. **向导录入**：订单信息（日期/币种/贸易条款）+ 货物明细 + 金额构成 + 收款计划 + 附件。
 *
 * 这里只做纯逻辑（行金额、总额、校验、payload），界面在
 * `app/(app)/orders/components/order-create-wizard.tsx`。
 * 后端契约见 `order-detail.ts` 头部注释（amount_breakdown 只传 4 键）。
 */
import { buildAmountBreakdown, roundMoney } from "./order-detail";
import { buildPaymentPlanPayload, type PaymentPlanRow } from "./payment-plan";

/** 向导里的货物行（数字都是输入框字符串）。 */
export interface OrderItemDraft {
  key: string;
  product_name: string;
  /** 规格描述（会作为 spec_snapshot.specification 落下） */
  spec_text: string;
  qty: string;
  qty_unit: string;
  unit_price: string;
  /** 行金额；用户可直接改（改后不再被 qty × price 覆盖） */
  line_amount: string;
  /** 用户是否手改过行金额（用于"数量/单价变化是否重算行金额"的判断） */
  amount_touched?: boolean;
}

export interface OrderInfoDraft {
  order_date: string;
  delivery_date: string;
  currency: string;
  incoterm: string;
  payment_terms: string;
  port_of_loading: string;
  port_of_destination: string;
  shipping_marks: string;
  country_of_origin: string;
  notes: string;
}

export const EMPTY_ORDER_INFO: OrderInfoDraft = {
  order_date: "",
  delivery_date: "",
  currency: "USD",
  incoterm: "",
  payment_terms: "",
  port_of_loading: "",
  port_of_destination: "",
  shipping_marks: "",
  country_of_origin: "",
  notes: "",
};

export const COMMON_QTY_UNITS = [
  "ROLLS",
  "PCS",
  "SET",
  "M",
  "M2",
  "KG",
  "TON",
  "CTN",
];

let itemSeq = 0;
export function nextItemKey(): string {
  itemSeq += 1;
  return `item-${Date.now().toString(36)}-${itemSeq}`;
}

export function makeItemDraft(
  input: Partial<Omit<OrderItemDraft, "key">> = {},
): OrderItemDraft {
  return {
    key: nextItemKey(),
    product_name: input.product_name ?? "",
    spec_text: input.spec_text ?? "",
    qty: input.qty ?? "",
    qty_unit: input.qty_unit ?? "ROLLS",
    unit_price: input.unit_price ?? "",
    line_amount: input.line_amount ?? "",
  };
}

/** 单行有效金额：手改过的 line_amount 优先；否则 qty × unit_price（两位小数）。 */
export function itemDraftAmount(item: OrderItemDraft): number {
  if (item.amount_touched && item.line_amount.trim() !== "") {
    const manual = Number(item.line_amount);
    if (Number.isFinite(manual)) return roundMoney(manual);
  }
  const qty = Number(item.qty);
  const price = Number(item.unit_price);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0;
  return roundMoney(qty * price);
}

/**
 * 数量/单价变化后重算行金额：只有**用户没手改过**时才覆盖。
 * 返回新行（不改入参）。
 */
export function recalcItemAmount(item: OrderItemDraft): OrderItemDraft {
  if (item.amount_touched) return item;
  const qty = Number(item.qty);
  const price = Number(item.unit_price);
  const amount =
    Number.isFinite(qty) && Number.isFinite(price)
      ? roundMoney(qty * price)
      : 0;
  return { ...item, line_amount: amount === 0 ? "" : amount.toFixed(2) };
}

/** 货物金额 = 各行有效金额之和。 */
export function sumDraftItemsAmount(items: OrderItemDraft[]): number {
  return roundMoney(
    items.reduce((sum, item) => sum + itemDraftAmount(item), 0),
  );
}

/** 订单总额 = 货物 + 运费 + 保险 + 其他。 */
export function draftOrderTotal(input: {
  items: OrderItemDraft[];
  freight: string;
  insurance: string;
  other: string;
}): number {
  return roundMoney(
    sumDraftItemsAmount(input.items) +
      Number(input.freight || 0) +
      Number(input.insurance || 0) +
      Number(input.other || 0),
  );
}

/** 非负数（空串按 0；非法/负数为错误）。 */
export function parseNonNegative(
  text: string,
): { ok: true; value: number } | { ok: false } {
  const raw = text.trim();
  if (raw === "") return { ok: true, value: 0 };
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return { ok: false };
  return { ok: true, value: num };
}

/** 校验货物行：数量 > 0、单价 ≥ 0、名称必填。返回人话错误列表。 */
export function validateOrderItems(items: OrderItemDraft[]): string[] {
  const errors: string[] = [];
  items.forEach((item, index) => {
    const label = `第 ${index + 1} 行`;
    if (!item.product_name.trim()) {
      errors.push(`${label}请填产品名称`);
    }
    const qty = Number(item.qty);
    if (item.qty.trim() === "" || !Number.isFinite(qty) || qty <= 0) {
      errors.push(`${label}的数量必须大于 0`);
    }
    const price = Number(item.unit_price);
    if (item.unit_price.trim() === "" || !Number.isFinite(price) || price < 0) {
      errors.push(`${label}的单价必须 ≥ 0`);
    }
    if (item.amount_touched && item.line_amount.trim() !== "") {
      const amount = Number(item.line_amount);
      if (!Number.isFinite(amount) || amount < 0) {
        errors.push(`${label}的金额必须 ≥ 0`);
      }
    }
  });
  return errors;
}

/** 校验订单信息：币种 3 位字母（后端 currency 枚举）；日期本身交给 input[type=date]。 */
export function validateOrderInfo(info: OrderInfoDraft): string[] {
  const errors: string[] = [];
  const currency = info.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    errors.push("币种请填 3 位字母代码，如 USD / EUR / CNY");
  }
  if (
    info.order_date &&
    info.delivery_date &&
    info.delivery_date < info.order_date
  ) {
    errors.push("交货日期不能早于订单日期");
  }
  return errors;
}

/**
 * 组 `POST /orders` 请求体。
 *
 * 为什么金额构成总是传：§13.3 要求订单总额 = 货物 + 运费 + 保险 + 其他，
 * 后端在缺 total_amount 时按四项之和兜底；前端不传 total_amount（避免与四项
 * 之和打架），由后端落 `orders.total_amount`。
 */
/**
 * 货物行草稿 → 请求体行项（`POST /orders` 与 `PATCH /orders/{id}` 的 `items`
 * 是同一形状：整批替换语义，行金额由前端先算好，后端仍会重算校验）。
 */
export function buildOrderItemsPayload(
  items: OrderItemDraft[],
  currency: string,
): Record<string, unknown>[] {
  const code = currency.trim().toUpperCase();
  return items.map((item, index) => {
    const qty = Number(item.qty);
    const price = Number(item.unit_price);
    const line = itemDraftAmount(item);
    const row: Record<string, unknown> = {
      product_name: item.product_name.trim(),
      qty: Number.isFinite(qty) ? qty : 0,
      qty_unit: item.qty_unit.trim() || "ROLLS",
      unit_price: Number.isFinite(price) ? price : 0,
      currency: code,
      line_amount: line,
      sort_order: index,
    };
    const spec = item.spec_text.trim();
    if (spec) row.spec_snapshot = { specification: spec };
    return row;
  });
}

export function buildOrderCreatePayload(input: {
  customer_id: number | string;
  customer_name: string;
  quote_order_id?: number | null;
  /** 来源（设计 §3.2）：始终显式传 source_type，direct 可带渠道 */
  source_type?: "inquiry" | "direct";
  inquiry_id?: number | null;
  source_channel?: string | null;
  info: OrderInfoDraft;
  items: OrderItemDraft[];
  freight: string;
  insurance: string;
  other: string;
  plan: PaymentPlanRow[];
}): Record<string, unknown> {
  const { info } = input;
  const body: Record<string, unknown> = {
    customer_id: input.customer_id,
    customer_name: input.customer_name.trim(),
    currency: info.currency.trim().toUpperCase(),
    amount_breakdown: buildAmountBreakdown({
      goods: sumDraftItemsAmount(input.items),
      freight: Number(input.freight || 0),
      insurance: Number(input.insurance || 0),
      other: Number(input.other || 0),
    }),
    payment_plan: buildPaymentPlanPayload(input.plan),
  };
  if (input.quote_order_id) body.quote_order_id = input.quote_order_id;
  // 来源三元组：内核按「显式 > 报价自带询盘 > direct」判定（main.py:3915-3986）。
  // 前端始终显式给 source_type，避免"以为选了询盘、实际落成 direct"的静默降级。
  if (input.source_type) body.source_type = input.source_type;
  if (input.source_type === "inquiry" && input.inquiry_id) {
    body.inquiry_id = input.inquiry_id;
  }
  if (input.source_type === "direct" && input.source_channel) {
    body.source_channel = input.source_channel;
  }
  const textFields: (keyof OrderInfoDraft)[] = [
    "order_date",
    "delivery_date",
    "incoterm",
    "payment_terms",
    "port_of_loading",
    "port_of_destination",
    "shipping_marks",
    "country_of_origin",
    "notes",
  ];
  for (const field of textFields) {
    const value = info[field].trim();
    if (value) body[field] = value;
  }
  if (input.items.length > 0) {
    body.items = buildOrderItemsPayload(input.items, info.currency);
  }
  return body;
}

/** 由报价单行项初始化货物草稿（选报价后自动带出，用户仍可改）。 */
export function itemDraftsFromQuote(
  items:
    | {
        product_name?: string | null;
        qty?: number | null;
        qty_unit?: string | null;
        unit_price?: number | null;
        line_amount?: number | null;
        spec_snapshot?: Record<string, unknown> | null;
      }[]
    | undefined,
): OrderItemDraft[] {
  return (items ?? []).map((item) => {
    const spec =
      typeof item.spec_snapshot?.specification === "string"
        ? item.spec_snapshot.specification
        : "";
    return makeItemDraft({
      product_name: item.product_name ?? "",
      spec_text: spec,
      qty: item.qty === null || item.qty === undefined ? "" : String(item.qty),
      qty_unit: item.qty_unit ?? "ROLLS",
      unit_price:
        item.unit_price === null || item.unit_price === undefined
          ? ""
          : String(item.unit_price),
      line_amount:
        item.line_amount === null || item.line_amount === undefined
          ? ""
          : String(item.line_amount),
    });
  });
}
