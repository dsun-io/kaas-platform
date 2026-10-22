/**
 * 询盘展示格式化（纯函数）：渠道文案、日期、金额、产品摘要、报价状态。
 *
 * 为什么集中在一处：列表 / 详情抽屉 / 报价历史三处都要显示同一批字段，
 * 各写一份 `toFixed / toLocaleString` 会出现「列表两位小数、详情三位」的漂移。
 *
 * 时间口径：后端返回 ISO 字符串（可能带时区、可能为空）。这里**不做时区换算**，
 * 统一按字符串截取展示（date = 前 10 位，datetime = 前 16 位 + 空格）——
 * 避免 SSR/客户端时区不同导致同一行显示两个日期；完整原值放 title 供悬停查看。
 */
import type { StatusTone } from "@/components/shared";

import type { InquiryBase, InquiryItem } from "./types";

/** 渠道（真源 = `kaas_common.domain.enums.INQUIRY_CHANNEL`，与 mocks 枚举同序）。 */
export const CHANNEL_LABEL: Record<string, string> = {
  email: "邮件",
  whatsapp: "WhatsApp",
  alibaba: "阿里巴巴",
  expo: "展会",
  website: "官网",
  phone: "电话",
  referral: "转介绍",
  other: "其他",
};

export function channelLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return CHANNEL_LABEL[value] ?? value;
}

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  sent: "已发送",
  accepted: "已接受",
  rejected: "已拒绝",
  expired: "已过期",
  closed: "已关闭",
};

export function quoteStatusLabel(status: string): string {
  return QUOTE_STATUS_LABEL[status] ?? status;
}

export function quoteStatusTone(status: string): StatusTone {
  if (status === "accepted") return "success";
  if (status === "rejected") return "danger";
  if (status === "expired") return "warning";
  if (status === "sent") return "info";
  return "default";
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  producing: "生产中",
  shipped: "已出运",
  completed: "已完成",
  cancelled: "已取消",
};

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? status;
}

export function orderStatusTone(status: string): StatusTone {
  if (status === "completed" || status === "shipped") return "success";
  if (status === "cancelled") return "danger";
  if (status === "pending") return "warning";
  if (status === "confirmed" || status === "producing") return "info";
  return "default";
}

/** ISO → YYYY-MM-DD（空/非法 → "—"）。 */
export function formatInquiryDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "—";
}

/** ISO → YYYY-MM-DD HH:mm（不换算时区；完整原值用于 title）。 */
export function formatInquiryDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = formatInquiryDate(iso);
  if (date === "—") return "—";
  const time = iso.slice(11, 16);
  return /^\d{2}:\d{2}$/.test(time) ? `${date} ${time}` : date;
}

/** 金额（两位小数 + 千分位）；缺金额 → "—"，缺币种只显示数字。 */
export function formatInquiryMoney(
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

/** 详情/列表共用的产品行视图。 */
export interface InquiryItemView {
  name: string;
  spec: string | null;
  quantity: number | null;
  quantityUnit: string | null;
  application: string | null;
}

export const EMPTY_ITEM_NAME = "未填写产品";

function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 产品行视图：**items 优先**（后端 `row_to_inquiry` 已保证 items 恒为数组，
 * 历史行也由旧标量字段合成一行），因此这里只需做展示映射。
 */
export function inquiryItemViews(
  inquiry: Pick<InquiryBase, "items"> | { items?: InquiryItem[] | null },
): InquiryItemView[] {
  const items = Array.isArray(inquiry.items) ? inquiry.items : [];
  return items.map((item) => ({
    name: textOf(item.product_name_raw) || EMPTY_ITEM_NAME,
    spec: textOf(item.spec_text) || null,
    quantity: typeof item.quantity === "number" ? item.quantity : null,
    quantityUnit: textOf(item.quantity_unit) || null,
    application: textOf(item.application) || null,
  }));
}

/** 产品摘要（列表列）：单品显示名称，多品折叠成「甲、乙 等 3 个产品」。 */
export function inquiryProductSummary(
  views: readonly InquiryItemView[],
): string {
  if (views.length === 0) return EMPTY_ITEM_NAME;
  const names = views.map((view) => view.name);
  if (names.length <= 2) return names.join("、");
  return `${names[0]}、${names[1]} 等 ${names.length} 个产品`;
}

/** 数量文案（列表/详情共用）：有单位才拼单位。 */
export function itemQuantityText(view: InquiryItemView): string {
  if (view.quantity === null) return "—";
  const quantity = view.quantity.toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
  return view.quantityUnit ? `${quantity} ${view.quantityUnit}` : quantity;
}
