/**
 * 审批中心 / 站内通知 / 指定审批人 —— 前端类型真源。
 *
 * 后端真源：`backend/worker/src/ws_approvals.py`（M1-e 内核，M1-f 门面原样透传）。
 * 本文件只描述**API 响应形状**，不放任何展示逻辑（展示纯函数见同目录 format/diff/
 * notification/approvers）。字段名与内核 `_request_dict` / `_notification_dict` /
 * `list_team_approvers` 逐字对齐，不在前端改名 —— 改名会让 mock 与生产悄悄漂移。
 */

/** 审批中心三个视图（内核 `_APPROVAL_VIEWS`：pending / mine / done）。 */
export type ApprovalView = "pending" | "mine" | "done";

/** 变更申请状态机（迁移 202610220005 的 CHECK 同口径）。 */
export type ChangeRequestStatus = "pending" | "approved" | "rejected";

/**
 * 一行业务明细：`order_items` / 变更申请的 `items`（新） / `snapshot`（旧）三者同构。
 * 内核 `_order_items_snapshot` 只给这 9 个键；前端不做额外假设。
 */
export interface ChangeLine {
  sku_id?: number | null;
  product_name?: string | null;
  spec_snapshot?: unknown;
  qty?: number | null;
  qty_unit?: string | null;
  unit_price?: number | null;
  currency?: string | null;
  line_amount?: number | null;
  sort_order?: number | null;
}

/** 变更申请（`_request_dict` + 审批中心聚合列表补的 5 个订单/申请人字段）。 */
export interface ApprovalItem {
  id: number;
  order_id: number;
  order_no: string | null;
  requested_by: number | null;
  /** 申请人显示名（聚合列表 join users 得到；详情/历史接口可能为 null） */
  requester_name: string | null;
  reason: string | null;
  items: ChangeLine[];
  snapshot: ChangeLine[];
  status: string;
  decided_by: number | null;
  decided_at: string | null;
  decision_reason: string | null;
  team_id: number | null;
  created_at: string | null;
  /** 订单当前状态（聚合列表） */
  order_status: string | null;
  order_total_amount: number | null;
  order_currency: string | null;
}

export interface ApprovalListPage {
  items: ApprovalItem[];
  total: number;
  page: number;
  page_size: number;
}

/** 批准响应里的受影响单证（内核 `_decide_change_request` 的 affected_docs）。 */
export interface AffectedDoc {
  id: number;
  doc_type: string;
  doc_no: string | null;
  status: string | null;
}

/** 批准 / 拒绝的响应（`_request_dict` + 三个决策字段）。 */
export interface DecidedChangeRequest extends Omit<
  ApprovalItem,
  | "order_no"
  | "requester_name"
  | "order_status"
  | "order_total_amount"
  | "order_currency"
> {
  applied: boolean;
  affected_docs: AffectedDoc[];
  new_total_amount: number | null;
}

/** 站内通知（`_notification_dict`）。 */
export interface AppNotification {
  id: number;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  ref_type: string | null;
  ref_id: number | null;
  read_at: string | null;
  created_at: string | null;
}

export interface NotificationListPage {
  items: AppNotification[];
  total: number;
  page: number;
  page_size: number;
}

/** 铃铛角标（内核 `unread_notification_count` 返回 `{unread}`，不是 `{count}`）。 */
export interface UnreadCountResponse {
  unread: number;
}

/** 全部已读（内核返回实际标记条数）。 */
export interface MarkAllReadResponse {
  marked: number;
}

/** 指定审批人条目（`GET/PUT /team/approvers` 的 items）。 */
export interface TeamApprover {
  user_id: number;
  display_name: string | null;
  email: string | null;
  created_by: number | null;
  created_at: string | null;
}

/** `GET/PUT /team/approvers` 响应；fallback 说明"空名单时谁来批"。 */
export interface TeamApproversResponse {
  team_id: number | null;
  items: TeamApprover[];
  fallback: string;
}
