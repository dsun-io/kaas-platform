/**
 * 审批中心的展示格式化（纯函数）：状态文案/色板、时间、金额、数量、货物行摘要。
 *
 * 为什么集中一处：列表 / 详情抽屉 / 通知抽屉三处显示同一批字段，各写一份
 * `toLocaleString` 会出现「列表两位小数、详情三位」的漂移（客户/询盘已踩过）。
 *
 * 时间口径：后端给 ISO 字符串（可能带时区、可能为 null）。这里**不做时区换算**，
 * 按字符串截取展示（与 `lib/inquiries/format.ts` 同口径），避免 SSR/客户端时区
 * 不同导致同一行显示两个时间。
 */
import type { StatusTone } from "@/components/shared";

import type { ChangeLine } from "./types";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

/** 变更申请状态 → 文案/色板（状态不能只靠颜色，必须同时有文案）。 */
export const CHANGE_STATUS_META: Record<string, StatusMeta> = {
  pending: { label: "待审批", tone: "warning" },
  approved: { label: "已批准", tone: "success" },
  rejected: { label: "已拒绝", tone: "danger" },
};

export function changeStatusMeta(status: string): StatusMeta {
  return (
    CHANGE_STATUS_META[status] ?? {
      label: status || "未知状态",
      tone: "default",
    }
  );
}

/** 订单状态文案（与内核 orders.status 枚举、询盘模块同口径）。 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  producing: "生产中",
  shipped: "已出运",
  completed: "已完成",
  cancelled: "已取消",
};

export function orderStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return ORDER_STATUS_LABEL[status] ?? status;
}

export function orderStatusTone(status: string | null | undefined): StatusTone {
  if (status === "completed" || status === "shipped") return "success";
  if (status === "cancelled") return "danger";
  if (status === "pending") return "warning";
  if (status === "confirmed" || status === "producing") return "info";
  return "default";
}

/** ISO → YYYY-MM-DD（空/非法 → "—"）。 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "—";
}

/** ISO → YYYY-MM-DD HH:mm（不换算时区；完整原值可放 title 悬停查看）。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = formatDate(iso);
  if (date === "—") return "—";
  const time = iso.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(time) ? `${date} ${time}` : date;
}

/** 金额（两位小数 + 千分位）；缺金额 → "—"，缺币种只显示数字。 */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) {
    return "—";
  }
  const formatted = amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${formatted}` : formatted;
}

/** 数量（最多 4 位小数 + 单位）；缺数量 → "—"。 */
export function formatQuantity(
  qty: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (qty === null || qty === undefined || !Number.isFinite(qty)) return "—";
  const text = qty.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return unit ? `${text} ${unit}` : text;
}

const EMPTY_PRODUCT_NAME = "未填写货物";

/** 货物名（列表/详情/对比表共用）：品名优先，其次 SKU，最后占位文案。 */
export function lineProductName(line: ChangeLine | null | undefined): string {
  if (!line) return EMPTY_PRODUCT_NAME;
  const name =
    typeof line.product_name === "string" ? line.product_name.trim() : "";
  if (name) return name;
  // 类型上 sku_id 是 number，但历史/脏数据可能给字符串 —— 按 unknown 收窄才安全
  const sku: unknown = line.sku_id;
  if (typeof sku === "number" && Number.isFinite(sku)) return `SKU #${sku}`;
  if (typeof sku === "string" && sku.trim()) return `SKU ${sku.trim()}`;
  return EMPTY_PRODUCT_NAME;
}

/**
 * 规格快照里的人类可读片段（与订单详情 `orderItemSpecText` 同口径）：
 * 优先读 specification / spec / description；旧数据可能是字符串，直接展示；
 * 其余对象键（如 mesh/width）拼成短摘要，保证"有数据但不认识"时也不空白。
 */
export function lineSpecText(line: ChangeLine | null | undefined): string {
  const spec = line?.spec_snapshot;
  if (typeof spec === "string") return spec.trim();
  if (!spec || typeof spec !== "object") return "";
  const record = spec as Record<string, unknown>;
  for (const key of ["specification", "spec", "description"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}: ${String(value)}`);
    }
    if (parts.length >= 4) break;
  }
  return parts.join(" · ");
}
