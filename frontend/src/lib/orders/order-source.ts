/**
 * 订单来源（设计 §3.2 / §8 / §9.2）—— 纯逻辑层：文案、深链、筛选参数、错误口径解释。
 *
 * 契约真源：
 *   · `row_to_order`（backend/kaas_common/workstation/order_serializers.py:33-65）已返回
 *     `source_type` / `source_channel` / `inquiry_id` / `quote_id` / `confirmed_*`；
 *   · `GET /orders?source_type=&source_channel=&inquiry_id=`（worker main.py:3715-3786，
 *     非法枚举 422 —— 前端选项必须来自同一份渠道清单，不能自造值）。
 *
 * 为什么把渠道文案放在 `lib/inquiries/format` 取：订单渠道与询盘渠道是**同一份**
 * 枚举（enums.py:44-52 `ORDER_CHANNEL = INQUIRY_CHANNEL`），各写一份必然漂移。
 */
import { CHANNEL_LABEL, channelLabel } from "@/lib/inquiries/format";
import type { StatusTone } from "@/components/shared/status-badge";

import type { OrderOption } from "@/lib/workstation/use-upstream";

/** 订单来源类型（真源 `kaas_common.domain.enums.ORDER_SOURCE_TYPE`）。 */
export const ORDER_SOURCE_TYPES = ["inquiry", "direct"] as const;
export type OrderSourceType = (typeof ORDER_SOURCE_TYPES)[number];

export const ORDER_SOURCE_TYPE_LABEL: Record<OrderSourceType, string> = {
  inquiry: "询盘转化",
  direct: "直接下单",
};

/** 列表筛选下拉（空串 = 全部）。 */
export const ORDER_SOURCE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "全部来源" },
  { value: "inquiry", label: "询盘转化" },
  { value: "direct", label: "直接下单" },
];

/** 渠道筛选下拉（空串 = 全部；顺序跟 `CHANNEL_LABEL` 的定义顺序一致）。 */
export const ORDER_CHANNEL_FILTER_OPTIONS: { value: string; label: string }[] =
  [
    { value: "", label: "全部渠道" },
    ...Object.entries(CHANNEL_LABEL).map(([value, label]) => ({
      value,
      label,
    })),
  ];

/**
 * 归一化来源类型：历史行可能为 null（迁移前没有该列）⇒ 与后端
 * `row_to_order` 一样按 `direct` 处理，前端不自己造第三种值。
 */
export function normalizeOrderSourceType(
  value: string | null | undefined,
): OrderSourceType {
  return value === "inquiry" ? "inquiry" : "direct";
}

/** 来源展示文案：询盘转化 / 直接下单 / 直接下单 · 电话（渠道未知时不伪造渠道）。 */
export function orderSourceLabel(
  sourceType: string | null | undefined,
  sourceChannel?: string | null,
): string {
  const type = normalizeOrderSourceType(sourceType);
  const base = ORDER_SOURCE_TYPE_LABEL[type];
  if (type === "direct" && sourceChannel) {
    return `${base} · ${channelLabel(sourceChannel)}`;
  }
  return base;
}

/** 来源徽标色：询盘转化是溯源链（info），直接下单是常规路径（default）。 */
export function orderSourceTone(
  sourceType: string | null | undefined,
): StatusTone {
  return normalizeOrderSourceType(sourceType) === "inquiry"
    ? "info"
    : "default";
}

/** 询盘深链（/inquiries 页已支持 ?inquiry_id= 直接打开详情抽屉）。 */
export function inquiryDeepLink(
  inquiryId: number | null | undefined,
): string | null {
  if (
    typeof inquiryId !== "number" ||
    !Number.isInteger(inquiryId) ||
    inquiryId <= 0
  ) {
    return null;
  }
  return `/inquiries?inquiry_id=${inquiryId}`;
}

/**
 * 报价深链：报价记录是 `/quotes` 的 `tab=records` 视图。
 * 不附加 `quote_id` —— 报价记录视图目前不支持按单号定位，
 * 传一个后端/页面都不认的参数会造出"链接看起来对、点了没反应"的假功能。
 */
export function quoteRecordsDeepLink(
  quoteId: number | null | undefined,
): string | null {
  if (
    typeof quoteId !== "number" ||
    !Number.isInteger(quoteId) ||
    quoteId <= 0
  ) {
    return null;
  }
  return "/quotes?tab=records";
}

export interface OrderSourceChainStep {
  kind: "inquiry" | "quote" | "order";
  label: string;
  /** 有值 = 可点跳转；null = 只有事实、没有可跳的页面 */
  href: string | null;
}

/**
 * 来源链（询盘 → 报价 → 本订单）：只列出**确实有值**的环节。
 * direct 单返回空数组 —— 由调用方渲染「直接下单 · 渠道」而不是一条空链。
 */
export function orderSourceChain(
  order: Pick<
    OrderOption,
    "inquiry_id" | "quote_id" | "order_no" | "source_type"
  >,
): OrderSourceChainStep[] {
  if (normalizeOrderSourceType(order.source_type) === "direct") {
    return [];
  }
  const steps: OrderSourceChainStep[] = [];
  if (order.inquiry_id) {
    steps.push({
      kind: "inquiry",
      label: `询盘 #${order.inquiry_id}`,
      href: inquiryDeepLink(order.inquiry_id),
    });
  }
  if (order.quote_id) {
    steps.push({
      kind: "quote",
      label: `报价单 #${order.quote_id}`,
      href: quoteRecordsDeepLink(order.quote_id),
    });
  }
  steps.push({ kind: "order", label: order.order_no, href: null });
  return steps;
}

/** 确认来源（`confirmed_source`）的人话。 */
export function orderConfirmSourceLabel(
  source: string | null | undefined,
): string | null {
  if (source === "manual") return "人工确认";
  if (source === "deposit_receipt") return "定金到账联动确认";
  return null;
}

/**
 * 建单时的来源入参（`POST /orders`，worker main.py:3915-3986）。
 *
 * 三条后端硬规则（前端在此**提前拦**，避免必然失败的请求）：
 *   ① `source_type=inquiry` 必须有询盘，否则 422 `INQUIRY_REQUIRED`；
 *   ② `source_type=direct` 不能再挂询盘，否则 422 `DIRECT_ORDER_INQUIRY_CONFLICT`；
 *   ③ 询盘必须属于本单客户，否则 422 `INQUIRY_CUSTOMER_MISMATCH`。
 * 不传 source_type 时内核按"有询盘→inquiry，否则 direct"兜底，所以这里始终显式传。
 */
export interface OrderSourceDraft {
  sourceType: OrderSourceType;
  inquiryId?: number | null;
  sourceChannel?: string | null;
}

export interface OrderSourcePayload {
  source_type: OrderSourceType;
  inquiry_id?: number;
  source_channel?: string;
}

export function buildOrderSourcePayload(
  draft: OrderSourceDraft,
): OrderSourcePayload {
  const payload: OrderSourcePayload = {
    source_type: draft.sourceType === "inquiry" ? "inquiry" : "direct",
  };
  if (payload.source_type === "inquiry") {
    const id = toPositiveInt(draft.inquiryId);
    if (id !== null) payload.inquiry_id = id;
    // 询盘转化不显式传渠道：内核会继承询盘渠道（main.py:3981-3986），
    // 显式传一个空/猜测的渠道反而会覆盖真实来源。
    return payload;
  }
  const channel = draft.sourceChannel?.trim() ?? "";
  if (channel) payload.source_channel = channel;
  return payload;
}

function toPositiveInt(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : null;
}

/** 建单来源的本地预检：返回给人看的错误，null = 可提交。 */
export function validateOrderSourceDraft(
  draft: OrderSourceDraft,
): string | null {
  if (
    draft.sourceType === "inquiry" &&
    toPositiveInt(draft.inquiryId) === null
  ) {
    return "询盘转化订单必须选择询盘；没有询盘请把来源改为「直接下单」";
  }
  return null;
}

/**
 * 把后端 422 的来源错误码翻译成**能指导操作**的话（内核措辞已很好，这里补上下文）。
 * 未知码返回 null，由调用方回退到后端原文。
 */
export function orderSourceErrorHint(
  code: string | null | undefined,
): string | null {
  switch (code) {
    case "INQUIRY_REQUIRED":
      return "询盘转化订单必须关联询盘：请选择询盘，或把来源改为「直接下单」。";
    case "DIRECT_ORDER_INQUIRY_CONFLICT":
      return "「直接下单」不能再挂询盘（会造成两套真相）：请把来源改为「询盘转化」。";
    case "INQUIRY_CUSTOMER_MISMATCH":
      return "所选询盘不属于本单客户：请选本客户的询盘，或改为「直接下单」。";
    case "INVALID_INQUIRY_ID":
      return "询盘编号无效，请重新选择。";
    case "INVALID_ENUM":
      return "来源/渠道取值不在后端允许的清单里，请重新选择。";
    default:
      return null;
  }
}
