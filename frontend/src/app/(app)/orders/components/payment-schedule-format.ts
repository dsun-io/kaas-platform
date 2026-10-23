/**
 * 收款计划/实收的展示格式化（纯函数）。
 *
 * 从原 `payment-schedules-panel.tsx` 内联实现抽出：计划表与实收记录表都要用
 * 「比例」「差异」，各写一份会出现两处口径漂移（与 lib/inquiries/format.ts 同思路；
 * 本任务的写范围只有 orders/components/**，所以放在组件目录内）。
 */
import { formatOrderMoney } from "@/lib/orders/order-detail";

/** 比例（0~1）→ 百分比文案；null → "—"。 */
export function pct(value: number | null): string {
  if (value === null || value === undefined) return "—";
  return `${Number((value * 100).toFixed(2))}%`;
}

/** 差异文案（带正负号）；0 显示 0.00（不显示 +0.00）。 */
export function diffText(diff: number | null, currency: string | null): string {
  if (diff === null) return "—";
  if (Math.abs(diff) < 0.005) return formatOrderMoney(0, currency);
  return `${diff > 0 ? "+" : ""}${formatOrderMoney(diff, currency)}`;
}
