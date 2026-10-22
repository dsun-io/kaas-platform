/**
 * 询盘工位（/inquiries）类型层 —— 形状**逐字照后端契约**，不自造字段。
 *
 * 真源：
 *   · 列表  `backend/worker/src/ws_crm_ext.py:303-399`（row_to_inquiry + company_name
 *           + quote_count + order_count + latest_quote_at）。
 *   · 详情  `backend/worker/src/ws_crm_ext.py:402-479`（row_to_inquiry + company_name
 *           + quotes[]（row_to_quote + order_count）+ orders[]（row_to_order）
 *           + stage_log[] + counts{quotes,orders,open_orders}）。
 *   · 行投影 `backend/kaas_common/workstation/customer_serializers.py:63-93`
 *           （row_to_inquiry）/ `quote_serializers.py:11-44`（row_to_quote）/
 *           `order_serializers.py:33-65`（row_to_order）。
 *
 * 口径提醒：**status 与 stage 是两层语义**
 *   · `status` 是"报价三态"（unquoted / quoted / closed），驱动线索池同步；
 *   · `stage` 是"业务流程进度"（inquiry < quotation < order < shipment < completed，
 *     closed 为终态），由事件驱动（backend/worker/src/inquiry_stage.py:22-34）。
 * 界面要分别展示，不能拿一个当另一个。
 */

/** 阶段取值（真源 = `backend/worker/src/inquiry_stage.py:30-34` 的 ALL_STAGES）。 */
export const INQUIRY_STAGES = [
  "inquiry",
  "quotation",
  "order",
  "shipment",
  "completed",
  "closed",
] as const;
export type InquiryStage = (typeof INQUIRY_STAGES)[number];

/** 报价三态（真源 = `kaas_common.domain.enums.INQUIRY_STATUS`）。 */
export const INQUIRY_STATUSES = ["unquoted", "quoted", "closed"] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/** 询盘多产品行（`customer_serializers.inquiry_items()` 的归一化输出）。 */
export interface InquiryItem {
  product_key?: string | null;
  product_name_raw: string | null;
  spec_text?: string | null;
  quantity?: number | null;
  quantity_unit?: string | null;
  application?: string | null;
  notes?: string | null;
}

/** `row_to_inquiry()` 的 13 个键。 */
export interface InquiryBase {
  id: number;
  customer_id: number;
  inquiry_no: string | null;
  lead_id: number | null;
  channel: string | null;
  category_id: number | null;
  product_name_raw: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  application: string | null;
  /** 恒为数组：历史行由后端用旧标量字段合成一行 */
  items: InquiryItem[];
  status: InquiryStatus | string;
  /** 历史行可能为 null（迁移前没有 stage 列） */
  stage: InquiryStage | string | null;
  stage_updated_at: string | null;
  created_at: string | null;
}

/** 列表行：`row_to_inquiry` + JOIN 客户名 + 三个聚合列。 */
export interface InquiryRow extends InquiryBase {
  company_name: string | null;
  quote_count: number;
  order_count: number;
  latest_quote_at: string | null;
}

/** `GET /api/v1/inquiries` 响应（**没有 page / page_size**：内核一次返回全部，
 *  见 ws_crm_ext.py:390-398 —— 前端因此只能做客户端分页，不要伪造服务端翻页）。 */
export interface InquiryListResponse {
  items: InquiryRow[];
  total: number;
}

/** 详情 quotes[]：`row_to_quote` 投影 + order_count（报价历史）。 */
export interface InquiryQuote {
  id: number;
  quote_no: string;
  customer_id: number | null;
  customer_name: string | null;
  inquiry_id: number | null;
  status: string;
  currency: string;
  total_amount: number | null;
  valid_until: string | null;
  notes: string | null;
  fx_rate: number | null;
  fx_rate_date: string | null;
  tax_archive_id: number | null;
  tax_archive_code: string | null;
  tax_archive_name: string | null;
  tax_snapshot: Record<string, unknown> | null;
  created_at: string | null;
  created_by: string | null;
  owner_id: string | null;
  owner_scope: string | null;
  /** 行项数（后端逐单 count，非 N+1 列表字段） */
  item_count: number;
  incoterm: string | null;
  payment_terms: string | null;
  port_of_loading: string | null;
  port_of_destination: string | null;
  shipping_marks: string | null;
  country_of_origin: string | null;
  destination_country: string | null;
  destination_region: string | null;
  carrier: string | null;
  freight_valid_from: string | null;
  freight_valid_to: string | null;
  /** 该报价已转出的订单数（不含 cancelled） */
  order_count: number;
}

/** 详情 orders[]：`row_to_order` 的展示子集。 */
export interface InquiryOrder {
  id: number;
  order_no: string;
  customer_id: number | null;
  customer_name: string | null;
  status: string;
  currency: string;
  total_amount: number | null;
  order_date: string | null;
  delivery_date: string | null;
  created_at: string | null;
  /** 报价传递的关联（历史单只有这个） */
  quote_id: number | null;
  /** 正列关联（设计 §3.1：订单直挂询盘） */
  inquiry_id: number | null;
  source_type: string | null;
  source_channel: string | null;
}

/** 阶段流水（`inquiry_stage_log`；ws_crm_ext.py:466-470）。 */
export interface InquiryStageLog {
  id: number;
  from_stage: string | null;
  to_stage: string;
  source_event: string;
  actor_id: string | null;
  note: string | null;
  created_at: string | null;
}

export interface InquiryCounts {
  quotes: number;
  orders: number;
  open_orders: number;
}

/** `GET /api/v1/inquiries/{id}` 响应。 */
export interface InquiryDetail extends InquiryBase {
  company_name: string | null;
  quotes: InquiryQuote[];
  orders: InquiryOrder[];
  stage_log: InquiryStageLog[];
  counts: InquiryCounts;
}
