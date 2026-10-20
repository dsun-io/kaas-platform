/**
 * 业务客户「往来记录」树 —— 数据形状与**永不抛**的归一化。
 *
 * 设计依据：docs/CUSTOMER_DOCUMENTS_VIEW.md §3
 *   GET /api/v1/customers/{customer_id}/records
 *   {customer, counts, quotes:[{..., documents:[], orders:[{..., documents:[]}]}],
 *    direct:{orders:[], documents:[]}}
 *
 * 为什么归一化要单独写成纯函数、而且"怎么都不许抛"：
 *   读写两侧不同步上线（这个接口后端还没实现），线上可能拿到 404 的空体、
 *   网关的 HTML 错误页、或者缺字段的半成品 JSON。客户详情页是主流程页面，
 *   不能因为一块**附加信息**把整页打成白屏 —— 因此这里所有取值都是防御式读取，
 *   拿不到就退化成空树，由调用方渲染"暂无往来记录 / 加载失败"。
 *   纯函数的好处是可以用单测钉住"喂垃圾也不崩"。
 */

/** 单个单据 chip 需要的最小信息（doc_type 决定图标与配色）。 */
export interface RecordDocument {
  id: number | null;
  doc_no: string;
  doc_type: string;
  status: string | null;
  currency: string | null;
  total_amount: number | null;
  created_at: string | null;
}

/** 树里的订单节点（报价下的订单 / 直接挂客户的订单共用）。 */
export interface RecordOrder {
  id: number | null;
  order_no: string;
  status: string | null;
  currency: string | null;
  total_amount: number | null;
  created_at: string | null;
  documents: RecordDocument[];
}

/** 树里的报价节点：自带报价单单证 + 由它产生的订单。 */
export interface RecordQuote {
  id: number | null;
  quote_no: string;
  status: string | null;
  currency: string | null;
  total_amount: number | null;
  created_at: string | null;
  /** 询盘来源：客户详情「询盘」页签按它把后续单据挂回询盘；null = 未关联询盘 */
  inquiry_id: number | null;
  documents: RecordDocument[];
  orders: RecordOrder[];
}

/** `direct` = 直接归属客户的订单与单证（手动新建 / 导入已有数据的正规路径）。 */
export interface CustomerRecordsDirect {
  orders: RecordOrder[];
  documents: RecordDocument[];
}

export interface CustomerRecords {
  customerId: number | null;
  customerName: string | null;
  counts: { quotes: number; orders: number; documents: number };
  quotes: RecordQuote[];
  direct: CustomerRecordsDirect;
}

export const EMPTY_CUSTOMER_RECORDS: CustomerRecords = {
  customerId: null,
  customerName: null,
  counts: { quotes: 0, orders: 0, documents: 0 },
  quotes: [],
  direct: { orders: [], documents: [] },
};

// ── 防御式读取原语 ──────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 后端可能用字符串传 Decimal（金额），能解析就解析
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asInteger(value: unknown): number | null {
  const n = asNumber(value);
  return n === null ? null : Math.trunc(n);
}

function asText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function asNullableText(value: unknown): string | null {
  const text = asText(value, "");
  return text === "" ? null : text;
}

/** 多字段名取第一个有值的（后端/历史/mock 的字段名不完全一致）。 */
function pickText(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const text = asText(source[key], "");
    if (text !== "") return text;
  }
  return "";
}

// ── 归一化 ──────────────────────────────────────────────────────────────────

function normalizeDocument(raw: unknown): RecordDocument | null {
  if (!isRecord(raw)) return null;
  const docType = pickText(raw, ["doc_type", "type"]);
  const docNo = pickText(raw, ["doc_no", "no", "number"]);
  // 两个都没有的行没有展示价值，直接丢掉而不是渲染一个空 chip
  if (docType === "" && docNo === "") return null;
  return {
    id: asInteger(raw.id),
    doc_no: docNo || "—",
    doc_type: docType || "other",
    status: asNullableText(raw.status),
    currency: asNullableText(raw.currency),
    total_amount: asNumber(raw.total_amount),
    created_at: asNullableText(raw.created_at),
  };
}

function normalizeOrder(raw: unknown): RecordOrder | null {
  if (!isRecord(raw)) return null;
  const orderNo = pickText(raw, ["order_no", "no"]);
  const documents = asArray(raw.documents)
    .map(normalizeDocument)
    .filter((d): d is RecordDocument => d !== null);
  const id = asInteger(raw.id);
  // 既没有编号/主键、也没有任何单证的"空节点"直接丢掉：它只会在树上留一行空白
  if (id === null && orderNo === "" && documents.length === 0) return null;
  return {
    id,
    order_no: orderNo || "—",
    status: asNullableText(raw.status),
    currency: asNullableText(raw.currency),
    total_amount: asNumber(raw.total_amount),
    created_at: asNullableText(raw.created_at),
    documents,
  };
}

function normalizeQuote(raw: unknown): RecordQuote | null {
  if (!isRecord(raw)) return null;
  const quoteNo = pickText(raw, ["quote_no", "no"]);
  const documents = asArray(raw.documents)
    .map(normalizeDocument)
    .filter((d): d is RecordDocument => d !== null);
  const orders = asArray(raw.orders)
    .map(normalizeOrder)
    .filter((o): o is RecordOrder => o !== null);
  const id = asInteger(raw.id);
  if (
    id === null &&
    quoteNo === "" &&
    documents.length === 0 &&
    orders.length === 0
  ) {
    return null;
  }
  return {
    id,
    quote_no: quoteNo || "—",
    status: asNullableText(raw.status),
    currency: asNullableText(raw.currency),
    total_amount: asNumber(raw.total_amount),
    created_at: asNullableText(raw.created_at),
    inquiry_id: asInteger(raw.inquiry_id),
    documents,
    orders,
  };
}

/** 从树里数出来的计数（接口没给 counts，或只给了一半时的兜底）。 */
function countFromTree(
  quotes: RecordQuote[],
  direct: CustomerRecordsDirect,
): CustomerRecords["counts"] {
  let orders = direct.orders.length;
  let documents = direct.documents.length;
  for (const quote of quotes) {
    documents += quote.documents.length;
    orders += quote.orders.length;
    for (const order of quote.orders) documents += order.documents.length;
  }
  for (const order of direct.orders) documents += order.documents.length;
  return { quotes: quotes.length, orders, documents };
}

/**
 * 把任意响应体归一化成 `CustomerRecords`。
 * **不抛异常**：任何缺字段、错类型、非对象输入都退化成空树。
 */
export function normalizeCustomerRecords(raw: unknown): CustomerRecords {
  if (!isRecord(raw)) {
    return { ...EMPTY_CUSTOMER_RECORDS, direct: { orders: [], documents: [] } };
  }

  const quotes = asArray(raw.quotes)
    .map(normalizeQuote)
    .filter((q): q is RecordQuote => q !== null);

  const directRaw = isRecord(raw.direct) ? raw.direct : null;
  const direct: CustomerRecordsDirect = {
    orders: asArray(directRaw?.orders)
      .map(normalizeOrder)
      .filter((o): o is RecordOrder => o !== null),
    // 兼容"直接挂在根上的 documents"这种旧/扁平形状
    documents: asArray(directRaw ? directRaw.documents : raw.documents)
      .map(normalizeDocument)
      .filter((d): d is RecordDocument => d !== null),
  };

  const computed = countFromTree(quotes, direct);
  const countsRaw = isRecord(raw.counts) ? raw.counts : {};
  const counts = {
    // 后端给了就用后端的（它可能统计的是分页之外的全量），缺哪项补哪项
    quotes: asInteger(countsRaw.quotes) ?? computed.quotes,
    orders: asInteger(countsRaw.orders) ?? computed.orders,
    documents: asInteger(countsRaw.documents) ?? computed.documents,
  };

  const customerRaw = isRecord(raw.customer) ? raw.customer : {};
  const customerName = pickText(customerRaw, [
    "company_name",
    "name",
    "customer_name",
  ]);
  return {
    customerId: asInteger(customerRaw.id),
    customerName: customerName === "" ? null : customerName,
    counts,
    quotes,
    direct,
  };
}

/** 树里是否真的有一条记录（决定"空态引导新建报价"还是渲染树）。 */
export function hasAnyRecord(records: CustomerRecords): boolean {
  return (
    records.quotes.length > 0 ||
    records.direct.orders.length > 0 ||
    records.direct.documents.length > 0 ||
    records.counts.quotes > 0 ||
    records.counts.orders > 0 ||
    records.counts.documents > 0
  );
}

/** `3 报价 · 2 订单 · 6 单证`（与设计文档的标题右侧计数一致）。 */
export function formatRecordCounts(counts: CustomerRecords["counts"]): string {
  return `${counts.quotes} 报价 · ${counts.orders} 订单 · ${counts.documents} 单证`;
}

/** 含订单的报价是业务最关心的，默认展开；纯草稿/未成单折叠（设计 §4）。 */
export function defaultQuoteExpanded(quote: RecordQuote): boolean {
  return quote.orders.length > 0;
}
