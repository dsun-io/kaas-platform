/**
 * 询盘列表的筛选参数（纯函数）。
 *
 * 契约真源：`backend/worker/src/ws_crm_ext.py:303-399` —— 参数只有
 * `status / customer_id / stage / channel / date_from / date_to / q`，
 * **没有 page / page_size**（内核一次返回全部行，前端只能客户端分页）。
 * 因此这里刻意不生成任何分页参数：mock / 生产行为必须一致，
 * 否则会出现「mock 能翻页、生产翻不动」的假功能。
 *
 * 非法枚举由后端 422（stage 的 allowed 清单也由后端给），日期非法同样 422；
 * 前端只做**同一口径的预检**，减少一次必然失败的请求（真正裁决仍在后端）。
 */
import { INQUIRY_STAGES, type InquiryStage } from "./types";

export interface InquiryFilters {
  /** 报价三态（unquoted / quoted / closed），可空 */
  status?: string;
  /** 流程阶段（inquiry / quotation / order / shipment / completed / closed） */
  stage?: InquiryStage | "";
  channel?: string;
  /** 客户 id（下拉选择器里是字符串；空串 = 不限） */
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
}

/** 默认（全部不限）；用空串而不是 undefined，保证 queryKey / 表单回填稳定。 */
export const EMPTY_INQUIRY_FILTERS: InquiryFilters = {
  status: "",
  stage: "",
  channel: "",
  customerId: "",
  dateFrom: "",
  dateTo: "",
  q: "",
};

/** 客户端分页页大小（内核不支持分页，翻页在前端切片）。 */
export const INQUIRIES_PAGE_SIZE = 20;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格 YYYY-MM-DD（拒绝 2026-02-31 这类后端也会 422 的值）。 */
export function isInquiryDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

/**
 * 前端预检：非法日期 / 起止倒置 ⇒ 返回给人看的错误文案，null = 可提交。
 * 文案直接说明后端会拒的原因，与后端 422 INVALID_DATE 对齐。
 */
export function validateInquiryFilters(filters: InquiryFilters): string | null {
  const from = filters.dateFrom?.trim() ?? "";
  const to = filters.dateTo?.trim() ?? "";
  if (from && !isInquiryDate(from)) return "开始日期必须是 YYYY-MM-DD";
  if (to && !isInquiryDate(to)) return "结束日期必须是 YYYY-MM-DD";
  if (from && to && from > to) return "开始日期不能晚于结束日期";
  if (
    filters.stage &&
    !(INQUIRY_STAGES as readonly string[]).includes(filters.stage)
  ) {
    return "阶段取值非法";
  }
  return null;
}

/** 筛选 → 查询参数（只带非空值；下划线命名 = 后端 Query 名）。 */
export function toInquiryQueryParams(
  filters: InquiryFilters,
): Record<string, string> {
  const params: Record<string, string> = {};
  if (filters.status) params.status = filters.status;
  if (filters.stage) params.stage = filters.stage;
  if (filters.channel) params.channel = filters.channel;
  if (filters.customerId) params.customer_id = filters.customerId;
  if (filters.dateFrom) params.date_from = filters.dateFrom;
  if (filters.dateTo) params.date_to = filters.dateTo;
  const q = filters.q?.trim();
  if (q) params.q = q;
  return params;
}

/** 是否有任何筛选生效（空态文案据此区分「还没数据」与「筛掉了」）。 */
export function hasActiveInquiryFilters(filters: InquiryFilters): boolean {
  return Object.keys(toInquiryQueryParams(filters)).length > 0;
}

export interface InquiryPageSlice<T> {
  rows: T[];
  page: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
}

/** 客户端分页切片：页码越界自动夹紧（筛选变化后回第 1 页由调用方负责）。 */
export function paginateInquiryRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = INQUIRIES_PAGE_SIZE,
): InquiryPageSlice<T> {
  const size = Math.max(1, pageSize);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * size;
  const slice = rows.slice(start, start + size);
  return {
    rows: slice,
    page: safePage,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
  };
}

/**
 * 「为此询盘报价」深链 —— 与 customers 页逐字一致
 * （customers/page.tsx:1204-1212），报价工位据 `customer_id` + `inquiry_id` 开单。
 */
export function inquiryQuoteHref(row: {
  id: number;
  customer_id: number;
}): string {
  return `/quotes?tab=product&customer_id=${row.customer_id}&inquiry_id=${row.id}`;
}

/** 关联订单深链（订单页据 ?id= 打开详情 —— 见报告里的「建议优化点」）。 */
export function orderDetailHref(orderId: number): string {
  return `/orders?id=${orderId}`;
}
