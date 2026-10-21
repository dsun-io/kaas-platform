"use client";

/**
 * 应收台账表格（C36 下期 #7）—— 表现层，逾期红标在此
 *
 * 逾期判据：`status !== paid` 且该订单**最早未付**收款计划的 `due_date` 已过
 * （`use-order-due-dates.ts` 取数）。取不到到期日 ⇒ 显示「—」并标"未知"，
 * **不当作不逾期**（绿色会被读成"已核对过"）。
 */
import { StatusBadge } from "@/components/shared/status-badge";
import type { ReceivableRow } from "@/lib/receivables/summary";
import {
  RECEIVABLE_STATUS_LABEL,
  isOverdue,
  outstandingOf,
  overdueDays,
  receivedOf,
  totalOf,
} from "@/lib/receivables/summary";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, "warning" | "info" | "success"> = {
  unpaid: "warning",
  partial: "info",
  paid: "success",
};

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ReceivablesTable({
  rows,
  dueByOrder,
  dueLoading = false,
  today,
}: {
  rows: readonly ReceivableRow[];
  /** order_id → 最早未付到期日（null = 无未付计划/未取到） */
  dueByOrder: Readonly<Record<number, string | null | undefined>>;
  dueLoading?: boolean;
  /** 注入"今天"便于测试逾期天数 */
  today?: Date;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th scope="col" className="p-2">
              订单号
            </th>
            <th scope="col" className="p-2">
              客户
            </th>
            <th scope="col" className="p-2">
              应收总额
            </th>
            <th scope="col" className="p-2">
              已收
            </th>
            <th scope="col" className="p-2">
              未收
            </th>
            <th scope="col" className="p-2">
              状态
            </th>
            <th scope="col" className="p-2">
              最早未付到期
            </th>
            <th scope="col" className="p-2">
              逾期
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const orderId = Number(row.order_id);
            const due = Number.isFinite(orderId) ? dueByOrder[orderId] : null;
            const overdue = isOverdue(row, due, today);
            const days = overdueDays(due, today);
            return (
              <tr
                key={row.id}
                data-overdue={overdue ? "true" : undefined}
                className={cn(
                  "border-b last:border-0",
                  overdue && "bg-destructive/5",
                )}
              >
                <td className="p-2 font-mono text-xs">{row.order_no ?? "—"}</td>
                <td className="p-2">{row.customer_name ?? "—"}</td>
                <td className="p-2 font-mono">
                  {money(String(row.currency ?? "—"), totalOf(row))}
                </td>
                <td className="p-2 font-mono text-success">
                  {money(String(row.currency ?? "—"), receivedOf(row))}
                </td>
                <td
                  className={cn(
                    "p-2 font-mono font-semibold",
                    outstandingOf(row) > 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                  )}
                >
                  {money(String(row.currency ?? "—"), outstandingOf(row))}
                </td>
                <td className="p-2">
                  <StatusBadge
                    tone={STATUS_TONE[String(row.status)] ?? "default"}
                  >
                    {RECEIVABLE_STATUS_LABEL[
                      String(row.status) as keyof typeof RECEIVABLE_STATUS_LABEL
                    ] ?? String(row.status)}
                  </StatusBadge>
                </td>
                <td className="p-2 font-mono text-xs">
                  {dueLoading ? (
                    <span className="text-muted-foreground">加载中…</span>
                  ) : due ? (
                    String(due).slice(0, 10)
                  ) : (
                    <span
                      className="text-muted-foreground"
                      title="该订单没有未付收款计划，或计划尚未取到"
                    >
                      —
                    </span>
                  )}
                </td>
                <td className="p-2 text-xs">
                  {overdue ? (
                    <span className="font-medium text-destructive" role="alert">
                      逾期 {days} 天
                    </span>
                  ) : String(row.status) === "paid" ? (
                    <span className="text-muted-foreground">—</span>
                  ) : dueLoading ? (
                    <span className="text-muted-foreground">…</span>
                  ) : due ? (
                    <span className="text-muted-foreground">未到期</span>
                  ) : (
                    <span
                      className="text-muted-foreground"
                      title="无到期日，无法判定"
                    >
                      未知
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
