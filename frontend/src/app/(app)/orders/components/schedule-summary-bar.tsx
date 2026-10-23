"use client";

/**
 * 计划汇总条：共 N 期 / 应收合计 / 已收（含已收清与部分收款期数）/ 待收 / 实收登记。
 *
 * 口径全部来自 `lib/orders/payment-schedules`（实收按登记金额，不静默改计划金额）——
 * 这个组件只负责把同一份汇总渲染成一行，不做任何计算之外的业务判断。
 */
import { formatOrderMoney } from "@/lib/orders/order-detail";
import {
  summarizeReceipts,
  summarizeSchedules,
  type PaymentReceipt,
  type PaymentSchedule,
} from "@/lib/orders/payment-schedules";

export function ScheduleSummaryBar({
  items,
  receipts,
  currency,
}: {
  items: PaymentSchedule[];
  receipts: PaymentReceipt[];
  currency: string | null;
}) {
  const summary = summarizeSchedules(items, receipts);
  const receiptSummary = summarizeReceipts(receipts);

  return (
    <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span>共 {summary.count} 期</span>
      <span>应收合计 {formatOrderMoney(summary.totalAmount, currency)}</span>
      <span className="text-success">
        已收 {formatOrderMoney(summary.paidAmount, currency)}（
        {summary.paidCount} 期已收清
        {summary.partialCount > 0
          ? ` / ${summary.partialCount} 期部分收款`
          : ""}
        ）
      </span>
      <span className="text-warning-muted-foreground">
        待收 {formatOrderMoney(Math.max(0, summary.pendingAmount), currency)}
      </span>
      <span>
        实收登记 {receiptSummary.count} 笔 ·{" "}
        {formatOrderMoney(receiptSummary.totalAmount, currency)}
      </span>
    </div>
  );
}
