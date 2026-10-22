/**
 * 站内通知的展示与深链解析（纯函数）。
 *
 * 通知类型真源是内核 `ws_approvals.py:46-48`：
 *   `approval_requested` / `approval_approved` / `approval_rejected`。
 * 但 `frontend/src/mocks/handlers.ts` 的 M2-C mock 用的是另一套词汇
 * （`order_item_change_requested|approved|rejected`）——两者都要认，
 * 否则 mock 模式下通知徽标全是"未知类型"（已列入交接报告，等 Lead 对齐）。
 *
 * 深链：**以内核给的 `link` 为主路径** —— A4（P0-A）起内核批准/拒绝通知写
 * `/orders?id={order_id}`（`ws_approvals.py:426`），与前端唯一可落地的订单工位
 * 深链口径（`/inquiries` 的「关联订单」也用它）一致，原样透传即可。
 * 提交侧仍是 `/approvals?focus={rid}`（审批中心定位到该申请）。
 * 旧数据兼容：历史内核/mock 曾写 `/orders/{order_id}`，而订单工位没有
 * `[id]` 动态路由 —— 这种形态**只为兼容历史**归一到 `/orders?id=`，不是主路径。
 * 只接受站内相对路径，防 `//evil.com` / `javascript:` 被当成跳转目标。
 */
import type { StatusTone } from "@/components/shared";

import type { AppNotification } from "./types";

export interface NotificationMeta {
  label: string;
  tone: StatusTone;
}

const NOTIFICATION_META: Record<string, NotificationMeta> = {
  // 内核词汇（真源）
  approval_requested: { label: "待审批", tone: "warning" },
  approval_approved: { label: "已批准", tone: "success" },
  approval_rejected: { label: "已拒绝", tone: "danger" },
  // mock 词汇（M2-C handlers.ts 现用；等待与内核对齐）
  order_item_change_requested: { label: "待审批", tone: "warning" },
  order_item_change_approved: { label: "已批准", tone: "success" },
  order_item_change_rejected: { label: "已拒绝", tone: "danger" },
};

export function notificationMeta(type: string): NotificationMeta {
  return NOTIFICATION_META[type] ?? { label: "通知", tone: "default" };
}

/** 本期通知只做审批相关（设计 D-13）；未知类型不展示审批动作，只展示通用通知。 */
export function isApprovalNotification(type: string): boolean {
  return type.startsWith("approval_") || type.startsWith("order_item_change_");
}

/** 站内相对路径白名单：必须以单个 "/" 开头，且不含空白/引号/尖括号。 */
export function isSafeInternalLink(link: unknown): link is string {
  if (typeof link !== "string") return false;
  if (!link.startsWith("/") || link.startsWith("//")) return false;
  return !/[\s<>"']/.test(link);
}

/**
 * **仅兼容历史数据**：旧内核/mock 写的 `/orders/{order_id}`（前端没有 `[id]` 路由，
 * 照搬会 404）。A4 起内核已改写 `/orders?id={order_id}`（见文件头），这里保留归一
 * 只为让历史通知不失效；新增通知**不应**再产生该形态。
 */
const LEGACY_ORDER_PATH_RE = /^\/orders\/([1-9]\d*)\/?$/;

/**
 * 点击通知的落点：后端 link 优先（新形态 `/orders?id=` 原样透传），
 * 仅对历史的 `/orders/{id}` 做兼容归一；缺失/不安全时回审批中心。
 */
export function resolveNotificationLink(
  notification: Pick<AppNotification, "link" | "type">,
): string {
  if (!isSafeInternalLink(notification.link)) return "/approvals";
  const legacyOrderId = LEGACY_ORDER_PATH_RE.exec(notification.link)?.[1];
  if (legacyOrderId) return `/orders?id=${legacyOrderId}`;
  return notification.link;
}

/** 未读角标文案：0 → 空串（不渲染）、1–99 → 数字、>99 → "99+"。 */
export function formatUnreadBadge(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count))
    return "";
  const value = Math.max(0, Math.floor(count));
  if (value <= 0) return "";
  return value > 99 ? "99+" : String(value);
}
