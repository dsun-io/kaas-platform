"use client";

/**
 * 收款计划表（含期次序号 / 应收 / 已收 / 差异 / 状态 / 行内操作）。
 *
 * 关键语义（不可回退）：
 * - **O3**：行内「登记收款」把 `period = index + 1`（列表期次序号）交给上层的
 *   RegisterReceiptDialog，标题显示「第 N 期」而不是数据库 id —— 删过计划会跳号，
 *   用 id 会把「第 2 期」显示成「第 12 期」；
 * - 行内操作顺序：登记收款 → 标记收款（仅未收清且无 receipts 的旧计划）→ 修改，
 *   外层测试按这个顺序取按钮（index），不要调整。
 */
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { formatOrderDate, formatOrderMoney } from "@/lib/orders/order-detail";
import {
  effectiveScheduleStatus,
  isHistoricalPaidNoReceipt,
  receivedAmountForSchedule,
  receiptsForSchedule,
  scheduleDifference,
  SCHEDULE_STATUS_LABEL,
  SCHEDULE_STATUS_TONE,
  SCHEDULE_TYPE_LABEL,
  type PaymentReceipt,
  type PaymentSchedule,
} from "@/lib/orders/payment-schedules";

import { diffText, pct } from "./payment-schedule-format";

export function SchedulesTable({
  items,
  receipts,
  currency,
  onRegister,
  onMarkPaid,
  onEdit,
}: {
  items: PaymentSchedule[];
  receipts: PaymentReceipt[];
  currency: string | null;
  /** 登记收款：period 是**列表期次序号**（1-based），不是 DB id（O3） */
  onRegister: (schedule: PaymentSchedule, period: number) => void;
  onMarkPaid: (schedule: PaymentSchedule) => void;
  onEdit: (schedule: PaymentSchedule) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th scope="col" className="p-2">
              期次
            </th>
            <th scope="col" className="p-2">
              类型
            </th>
            <th scope="col" className="p-2">
              比例
            </th>
            <th scope="col" className="p-2">
              应收金额
            </th>
            <th scope="col" className="p-2">
              已收
            </th>
            <th scope="col" className="p-2">
              差异
            </th>
            <th scope="col" className="p-2">
              到期日
            </th>
            <th scope="col" className="p-2">
              状态
            </th>
            <th scope="col" className="p-2">
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => {
            const received = receivedAmountForSchedule(item, receipts);
            const diff = scheduleDifference(item, receipts);
            const status = effectiveScheduleStatus(item, receipts);
            const historical = isHistoricalPaidNoReceipt(item, receipts);
            const ownReceipts = receiptsForSchedule(receipts, item.id);
            return (
              <tr key={item.id} className="border-b last:border-0">
                <td className="p-2">#{index + 1}</td>
                <td className="p-2">
                  {SCHEDULE_TYPE_LABEL[item.schedule_type] ??
                    item.schedule_type}
                </td>
                <td className="p-2">{pct(item.ratio)}</td>
                <td className="p-2">
                  {formatOrderMoney(
                    typeof item.amount === "number" ? item.amount : null,
                    item.currency ?? currency,
                  )}
                </td>
                <td className="p-2">
                  <div className="flex flex-col">
                    <span>
                      {formatOrderMoney(received, item.currency ?? currency)}
                    </span>
                    {historical && (
                      <span className="text-[11px] text-muted-foreground">
                        历史收款（无截图）
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-2">
                  <span
                    className={
                      diff === null || Math.abs(diff) < 0.005
                        ? "text-muted-foreground"
                        : "text-warning"
                    }
                  >
                    {diffText(diff, item.currency ?? currency)}
                  </span>
                </td>
                <td className="p-2">{formatOrderDate(item.due_date)}</td>
                <td className="p-2">
                  <StatusBadge tone={SCHEDULE_STATUS_TONE[status] ?? "default"}>
                    {SCHEDULE_STATUS_LABEL[status] ?? status}
                  </StatusBadge>
                </td>
                <td className="p-2">
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRegister(item, index + 1)}
                    >
                      登记收款
                    </Button>
                    {status !== "paid" && ownReceipts.length === 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onMarkPaid(item)}
                      >
                        标记收款
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onEdit(item)}
                    >
                      修改
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
