/**
 * 订单货物明细编辑 + 已确认订单的变更审批（设计 §6 / §6.1 / §9.2）—— 纯逻辑层。
 *
 * 契约真源：
 *   · `PATCH /orders/{id}` 带 `items`：**pending 直接生效**并重算总额；非 pending
 *     一律 409 `ORDER_ITEMS_LOCKED`（worker main.py:4319-4373）；
 *   · `POST /orders/{id}/item-change-requests`：非 pending 才允许，提交时订单**不变**，
 *     同一订单同时只能有一条 pending（409 `CHANGE_REQUEST_PENDING`），
 *     申请体 `{items, reason}`（worker ws_approvals.py:220-292）；
 *   · `GET /orders/{id}/item-change-requests` → `{items,total}`，行形状见
 *     `_request_dict`（ws_approvals.py:166-184）；
 *   · approve/reject 响应 = 申请行 + `applied` / `affected_docs` / `new_total_amount`。
 *
 * 这里只放纯函数（差异对比、状态文案、编辑模式判定），网络访问在 `hooks/`。
 */
import type { StatusTone } from "@/components/shared/status-badge";

import type { OrderItem } from "./order-detail";

/** 变更申请状态（与 ws_approvals.py:41-43 一致）。 */
export const CHANGE_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

export const CHANGE_REQUEST_STATUS_LABEL: Record<string, string> = {
  pending: "待审批",
  approved: "已批准",
  rejected: "已拒绝",
};

export function changeRequestStatusLabel(
  status: string | null | undefined,
): string {
  if (!status) return "—";
  return CHANGE_REQUEST_STATUS_LABEL[status] ?? status;
}

export function changeRequestStatusTone(
  status: string | null | undefined,
): StatusTone {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "pending") return "warning";
  return "default";
}

/** 受影响单证（approve 响应里给出，设计 §6.1 第 3 条）。 */
export interface AffectedDoc {
  id?: number | null;
  doc_type: string;
  doc_no: string;
  status: string | null;
}

/** `GET/POST /orders/{id}/item-change-requests` 一行（`_request_dict`）。 */
export interface OrderItemChangeRequest {
  id: number;
  order_id: number;
  order_no?: string | null;
  requested_by?: number | string | null;
  reason: string | null;
  /** 新明细（整批替换语义） */
  items: OrderItem[];
  /** 提交时的旧明细快照 */
  snapshot: OrderItem[];
  status: ChangeRequestStatus | string;
  decided_by?: number | string | null;
  decided_at?: string | null;
  decision_reason?: string | null;
  team_id?: number | null;
  created_at?: string | null;
}

/** approve/reject 响应（`_decide_change_request` 的返回）。 */
export interface OrderItemChangeDecision extends OrderItemChangeRequest {
  applied: boolean;
  affected_docs: AffectedDoc[];
  new_total_amount: number | null;
}

export interface OrderItemChangeListResponse {
  items: OrderItemChangeRequest[];
  total: number;
}

/** 取该订单当前「待审批」的那一条（后端保证最多一条）。 */
export function pendingChangeRequest(
  list: readonly OrderItemChangeRequest[] | null | undefined,
): OrderItemChangeRequest | null {
  return (list ?? []).find((row) => row.status === "pending") ?? null;
}

/** 历史按时间倒序（后端已排；这里兜底 undefined 的 created_at）。 */
export function sortChangeRequests(
  list: readonly OrderItemChangeRequest[],
): OrderItemChangeRequest[] {
  return [...list].sort((a, b) => {
    const at = a.created_at ?? "";
    const bt = b.created_at ?? "";
    if (at === bt) return b.id - a.id;
    return at < bt ? 1 : -1;
  });
}

/** 非 pending 的订单：明细改动必须走审批（D-8）。 */
export type OrderItemsEditMode = "direct" | "approval";

export function orderItemsEditMode(
  status: string | null | undefined,
): OrderItemsEditMode {
  return status === "pending" ? "direct" : "approval";
}

export function orderItemsEditHint(mode: OrderItemsEditMode): string {
  return mode === "direct"
    ? "待确认订单：保存后立即生效，金额按「货物明细 + 运费/保险/其他」自动重算。"
    : "已确认订单：明细改动需提交变更申请，管理员批准后才生效（订单当前不变）。";
}

// ── 新旧明细对比 ────────────────────────────────────────────────────────────

export type ItemDiffKind = "added" | "removed" | "changed" | "unchanged";

export interface ItemFieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export interface ItemDiffRow {
  key: string;
  kind: ItemDiffKind;
  productName: string;
  before: OrderItem | null;
  after: OrderItem | null;
  changes: ItemFieldChange[];
}

function specText(item: OrderItem | null): string {
  const spec = item?.spec_snapshot;
  if (!spec || typeof spec !== "object") return "";
  const raw =
    (spec as Record<string, unknown>).specification ??
    (spec as Record<string, unknown>).spec ??
    (spec as Record<string, unknown>).description;
  return typeof raw === "string" ? raw.trim() : "";
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}

function moneyOf(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value.toFixed(2);
}

function compareItem(before: OrderItem, after: OrderItem): ItemFieldChange[] {
  const pairs: { field: string; label: string; a: string; b: string }[] = [
    {
      field: "product_name",
      label: "产品",
      a: before.product_name ?? "",
      b: after.product_name ?? "",
    },
    { field: "spec", label: "规格", a: specText(before), b: specText(after) },
    {
      field: "qty",
      label: "数量",
      a: textOf(before.qty),
      b: textOf(after.qty),
    },
    {
      field: "qty_unit",
      label: "单位",
      a: before.qty_unit ?? "",
      b: after.qty_unit ?? "",
    },
    {
      field: "unit_price",
      label: "单价",
      a: moneyOf(before.unit_price),
      b: moneyOf(after.unit_price),
    },
    {
      field: "line_amount",
      label: "行金额",
      a: moneyOf(before.line_amount),
      b: moneyOf(after.line_amount),
    },
  ];
  return pairs
    .filter((pair) => pair.a !== pair.b)
    .map((pair) => ({
      field: pair.field,
      label: pair.label,
      before: pair.a,
      after: pair.b,
    }));
}

/**
 * 新旧明细对比（审批横幅/审批中心共用）。
 *
 * 配对策略：申请里没有行 id（`_order_items_snapshot` 不选 id），所以先按
 * **产品名 + 顺序**配对；找不到同名旧行就算新增，旧行没被配上就算删除。
 * 这样"把某行产品改名"会显示为「删除旧行 + 新增新行」而不是静默配对错行 ——
 * 审批人看到的事实比"少一行变更"更重要。
 */
export function diffOrderItems(
  before: readonly OrderItem[] | null | undefined,
  after: readonly OrderItem[] | null | undefined,
): ItemDiffRow[] {
  const oldItems = [...(before ?? [])];
  const used = new Set<number>();
  const rows: ItemDiffRow[] = [];

  (after ?? []).forEach((next, index) => {
    const name = next.product_name ?? "";
    const matchIndex = oldItems.findIndex(
      (candidate, i) => !used.has(i) && (candidate.product_name ?? "") === name,
    );
    const key = `after-${index}-${name}`;
    if (matchIndex === -1) {
      rows.push({
        key,
        kind: "added",
        productName: name || `第 ${index + 1} 行`,
        before: null,
        after: next,
        changes: [],
      });
      return;
    }
    used.add(matchIndex);
    const prev = oldItems[matchIndex]!;
    const changes = compareItem(prev, next);
    rows.push({
      key,
      kind: changes.length > 0 ? "changed" : "unchanged",
      productName: name || `第 ${index + 1} 行`,
      before: prev,
      after: next,
      changes,
    });
  });

  oldItems.forEach((prev, index) => {
    if (used.has(index)) return;
    rows.push({
      key: `before-${index}-${prev.product_name ?? ""}`,
      kind: "removed",
      productName: prev.product_name ?? `第 ${index + 1} 行`,
      before: prev,
      after: null,
      changes: [],
    });
  });

  return rows;
}

export interface ItemDiffSummary {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

export function itemDiffSummary(rows: readonly ItemDiffRow[]): ItemDiffSummary {
  const summary: ItemDiffSummary = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
  };
  for (const row of rows) summary[row.kind] += 1;
  return summary;
}

/** `新增 1 · 删除 1 · 修改 2`（没有变更项时返回「明细未变」）。 */
export function itemDiffSummaryText(rows: readonly ItemDiffRow[]): string {
  const summary = itemDiffSummary(rows);
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`新增 ${summary.added}`);
  if (summary.removed > 0) parts.push(`删除 ${summary.removed}`);
  if (summary.changed > 0) parts.push(`修改 ${summary.changed}`);
  return parts.length > 0 ? parts.join(" · ") : "明细未变";
}

export const ITEM_DIFF_KIND_LABEL: Record<ItemDiffKind, string> = {
  added: "新增",
  removed: "删除",
  changed: "修改",
  unchanged: "未变",
};

/** 对比行的展示名（删除行取旧值，其余取新值）。 */
export function itemDiffProductName(row: ItemDiffRow): string {
  return row.after?.product_name || row.before?.product_name || row.productName;
}
