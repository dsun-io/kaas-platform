/**
 * 报价单编辑（设计 §6 / §9.3）—— 纯逻辑：可编辑判定、状态流转、整批替换请求体。
 *
 * 后端两条硬规则（`backend/worker/src/quote_api.py`）：
 *   ① 行项整批替换只在 `status === "draft"` 时允许，其余 409 `QUOTE_NOT_EDITABLE`
 *      （`_QUOTE_EDITABLE_STATUS`，:294/:2229）——签发后的报价是法律凭证；
 *   ② 单号/下游锁定：`quote_no_editable === false` = 已有下游订单或单证
 *      （列表 :1776-1797、详情 :2076 用同一推导）⇒ 行项与金额锁定。
 * 状态机（:289-292）：draft → sent/expired；sent → accepted/rejected/expired。
 *
 * 界面据此**明示锁定原因**，不静默禁用（用户要知道为什么改不了、该怎么做）。
 */
import type {
  QuoteOrder,
  QuoteOrderItem,
  QuoteOrderItemIn,
  QuoteOrderPatch,
} from "@contracts/quote-order";

export const QUOTE_EDITABLE_STATUSES = ["draft"] as const;

export const QUOTE_NEXT_STATUS: Record<string, string[]> = {
  draft: ["sent", "expired"],
  sent: ["accepted", "rejected", "expired"],
};

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  sent: "已发送",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
  closed: "已关闭",
};

export function quoteStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return QUOTE_STATUS_LABEL[status] ?? status;
}

/** 当前状态可流转到的下一状态（空数组 = 终态，只能查看）。 */
export function nextQuoteStatuses(status: string | null | undefined): string[] {
  if (!status) return [];
  return QUOTE_NEXT_STATUS[status] ?? [];
}

/**
 * 锁定原因（null = 行项/条款可编辑）。
 *
 * 优先级：下游锁定（已转订单/已开单证）> 已签发（非 draft）。两者同时成立时
 * 先说下游 —— 那是用户最不能自己解决的那一条。
 */
export function quoteLockReason(
  quote: Pick<QuoteOrder, "status" | "quote_no_editable">,
): string | null {
  if (quote.quote_no_editable === false) {
    return "该报价已转为订单或已开出 PI/合同等后续单证：行项与金额已锁定，只能改备注与状态。";
  }
  if (!(QUOTE_EDITABLE_STATUSES as readonly string[]).includes(quote.status)) {
    return `该报价已${quoteStatusLabel(quote.status)}：签发后是法律凭证，行项与金额锁定，只能改备注与状态；要改价请另开一张报价单。`;
  }
  return null;
}

// ── 行项草稿（整批替换）─────────────────────────────────────────────────────

export interface QuoteItemDraft {
  key: string;
  product_name: string;
  /** 规格描述（写回 spec_snapshot.specification，其余申报要素原样保留） */
  spec_text: string;
  qty: string;
  qty_unit: string;
  unit_price: string;
  /** 原行：整批替换 = 删表重插，成本分解/成本覆盖/币种等必须带回去 */
  source: QuoteOrderItem | null;
}

let draftSeq = 0;
export function makeQuoteItemDraft(
  input: Partial<Omit<QuoteItemDraft, "key">> = {},
): QuoteItemDraft {
  draftSeq += 1;
  return {
    key: `quote-item-${Date.now().toString(36)}-${draftSeq}`,
    product_name: "",
    spec_text: "",
    qty: "",
    qty_unit: "ROLLS",
    unit_price: "",
    source: null,
    ...input,
  };
}

function specTextOf(item: QuoteOrderItem): string {
  const spec = item.spec_snapshot;
  if (!spec || typeof spec !== "object") return "";
  const raw = (spec as Record<string, unknown>).specification;
  return typeof raw === "string" ? raw : "";
}

export function quoteItemDrafts(
  items: readonly QuoteOrderItem[],
): QuoteItemDraft[] {
  return items.map((item) =>
    makeQuoteItemDraft({
      product_name: item.product_name ?? "",
      spec_text: specTextOf(item),
      qty: item.qty === null || item.qty === undefined ? "" : String(item.qty),
      qty_unit: item.qty_unit ?? "ROLLS",
      unit_price:
        item.unit_price === null || item.unit_price === undefined
          ? ""
          : String(item.unit_price),
      source: item,
    }),
  );
}

export function roundQuoteMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/** 行金额 = 数量 × 单价（与单证审单口径一致，不做多次舍入）。 */
export function quoteDraftAmount(draft: QuoteItemDraft): number {
  const qty = Number(draft.qty);
  const price = Number(draft.unit_price);
  if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0) return 0;
  return roundQuoteMoney(qty * price);
}

export function sumQuoteDrafts(items: readonly QuoteItemDraft[]): number {
  return roundQuoteMoney(
    items.reduce((sum, item) => sum + quoteDraftAmount(item), 0),
  );
}

/** 校验草稿：返回人话错误列表（空数组 = 可提交）。 */
export function validateQuoteItemDrafts(
  items: readonly QuoteItemDraft[],
): string[] {
  const errors: string[] = [];
  items.forEach((item, index) => {
    const label = `第 ${index + 1} 行`;
    if (!item.product_name.trim()) errors.push(`${label}请填产品名称`);
    const qty = Number(item.qty);
    if (item.qty.trim() === "" || !Number.isFinite(qty) || qty <= 0) {
      errors.push(`${label}的数量必须大于 0`);
    }
    const price = Number(item.unit_price);
    if (item.unit_price.trim() === "" || !Number.isFinite(price) || price < 0) {
      errors.push(`${label}的单价必须 ≥ 0`);
    }
  });
  return errors;
}

/**
 * 草稿 → `PUT /quotes/{id}/items` 的 `items`。
 * 保留原行的 `sku_id` / `cost_breakdown` / `cost_override` / 币种 ——
 * 丢掉 `cost_breakdown` 会让内部成本/利润列在编辑后凭空消失（数据回退）。
 */
export function buildQuoteItemsPayload(
  drafts: readonly QuoteItemDraft[],
  headCurrency: string,
): QuoteOrderItemIn[] {
  return drafts.map((draft, index) => {
    const source = draft.source;
    const spec = draft.spec_text.trim();
    const baseSpec =
      source?.spec_snapshot && typeof source.spec_snapshot === "object"
        ? (source.spec_snapshot as Record<string, unknown>)
        : null;
    const spec_snapshot = spec
      ? { ...(baseSpec ?? {}), specification: spec }
      : (source?.spec_snapshot ?? null);
    return {
      product_name: draft.product_name.trim(),
      sku_id: source?.sku_id ?? null,
      spec_snapshot,
      qty: Number(draft.qty),
      qty_unit: draft.qty_unit.trim() || "ROLLS",
      unit_price: Number(draft.unit_price),
      currency: source?.currency ?? headCurrency,
      line_amount: quoteDraftAmount(draft),
      cost_override: source?.cost_override ?? null,
      sort_order: index,
      cost_breakdown: source?.cost_breakdown ?? null,
    };
  });
}

// ── 单头 / 状态流转 ─────────────────────────────────────────────────────────

export const QUOTE_TERM_FIELDS = [
  { key: "incoterm", label: "贸易术语" },
  { key: "payment_terms", label: "付款方式" },
  { key: "port_of_loading", label: "装运港" },
  { key: "port_of_destination", label: "目的港" },
  { key: "shipping_marks", label: "唛头" },
  { key: "country_of_origin", label: "原产国" },
] as const;

export type QuoteTermKey = (typeof QUOTE_TERM_FIELDS)[number]["key"];
export type QuoteTermsDraft = Record<QuoteTermKey, string>;

export function quoteTermsFromOrder(quote: QuoteOrder): QuoteTermsDraft {
  const out = {} as QuoteTermsDraft;
  for (const field of QUOTE_TERM_FIELDS) {
    const value = quote[field.key];
    out[field.key] = typeof value === "string" ? value : "";
  }
  return out;
}

/**
 * 组 `PATCH /quotes/{id}` 请求体：条款 / 备注 / 状态。
 * 状态只在**确实变化**时带上（后端对同值不发 SQL，但前端不制造噪音）。
 * 空条款送 null（清空栏位），不是空串 —— 空串会被渲染成空白行。
 */
export function buildQuotePatch(input: {
  terms: QuoteTermsDraft;
  notes: string;
  status: string;
  currentStatus: string;
}): QuoteOrderPatch {
  const patch: QuoteOrderPatch = {};
  for (const field of QUOTE_TERM_FIELDS) {
    const value = input.terms[field.key]?.trim() ?? "";
    patch[field.key] = value === "" ? null : value;
  }
  patch.notes = input.notes.trim() === "" ? null : input.notes.trim();
  if (
    input.status &&
    input.status !== input.currentStatus &&
    nextQuoteStatuses(input.currentStatus).includes(input.status)
  ) {
    patch.status = input.status as NonNullable<QuoteOrderPatch["status"]>;
  }
  return patch;
}

/** 状态下拉选项：保持当前 + 合法下一状态（终态只剩"保持当前"）。 */
export function quoteStatusSelectOptions(
  currentStatus: string,
): { value: string; label: string }[] {
  return [
    {
      value: currentStatus,
      label: `保持「${quoteStatusLabel(currentStatus)}」`,
    },
    ...nextQuoteStatuses(currentStatus).map((value) => ({
      value,
      label: quoteStatusLabel(value),
    })),
  ];
}
