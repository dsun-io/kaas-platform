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
 *
 * U-P0C：列表表格改用共享 `DataTable`（ui:patterns no-bare-table）。行内派生值
 * （期次序号 / 已收 / 差异 / 状态 / 该期 receipts）在 `rows` 里一次算好，
 * 因为 DataTable 的 render 只拿得到行数据、拿不到行下标。
 */
import {
  DataTable,
  type DataTableColumn,
} from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
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

/** 行视图：把"依赖其余行/下标"的派生值一次算好（DataTable render 只有行数据）。 */
interface ScheduleRow extends PaymentSchedule {
  /** 列表期次序号（1-based；不是 DB id，O3 口径） */
  period: number;
  /** 该期实收合计（含历史 paid 无截图的兼容口径） */
  received: number;
  /** 实收 − 应收；null = 无法判定 */
  diff: number | null;
  /** 有效状态（pending/partial/paid/overdue） */
  effectiveStatus: string;
  /** 历史"已标记 paid 但没有 receipts"的行 */
  historical: boolean;
  /** 该期已有的实收记录（用于显示"标记收款"是否还有必要） */
  ownReceiptCount: number;
}

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
  const rows: ScheduleRow[] = items.map((item, index) => ({
    ...item,
    period: index + 1,
    received: receivedAmountForSchedule(item, receipts),
    diff: scheduleDifference(item, receipts),
    effectiveStatus: effectiveScheduleStatus(item, receipts),
    historical: isHistoricalPaidNoReceipt(item, receipts),
    ownReceiptCount: receiptsForSchedule(receipts, item.id).length,
  }));

  const columns: DataTableColumn<ScheduleRow>[] = [
    { key: "period", header: "期次", render: (row) => `#${row.period}` },
    {
      key: "schedule_type",
      header: "类型",
      render: (row) =>
        SCHEDULE_TYPE_LABEL[row.schedule_type] ?? row.schedule_type,
    },
    { key: "ratio", header: "比例", render: (row) => pct(row.ratio) },
    {
      key: "amount",
      header: "应收金额",
      render: (row) =>
        formatOrderMoney(
          typeof row.amount === "number" ? row.amount : null,
          row.currency ?? currency,
        ),
    },
    {
      key: "received",
      header: "已收",
      render: (row) => (
        <div className="flex flex-col">
          <span>
            {formatOrderMoney(row.received, row.currency ?? currency)}
          </span>
          {row.historical && (
            <span className="text-[11px] text-muted-foreground">
              历史收款（无截图）
            </span>
          )}
        </div>
      ),
    },
    {
      key: "diff",
      header: "差异",
      render: (row) => (
        <span
          className={
            row.diff === null || Math.abs(row.diff) < 0.005
              ? "text-muted-foreground"
              : "text-warning"
          }
        >
          {diffText(row.diff, row.currency ?? currency)}
        </span>
      ),
    },
    {
      key: "due_date",
      header: "到期日",
      render: (row) => formatOrderDate(row.due_date),
    },
    {
      key: "status",
      header: "状态",
      render: (row) => (
        <StatusBadge
          tone={SCHEDULE_STATUS_TONE[row.effectiveStatus] ?? "default"}
        >
          {SCHEDULE_STATUS_LABEL[row.effectiveStatus] ?? row.effectiveStatus}
        </StatusBadge>
      ),
    },
    {
      key: "actions",
      header: "操作",
      render: (row) => (
        <div className="flex flex-wrap gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRegister(row, row.period)}
          >
            登记收款
          </Button>
          {row.effectiveStatus !== "paid" && row.ownReceiptCount === 0 && (
            <Button size="sm" variant="ghost" onClick={() => onMarkPaid(row)}>
              标记收款
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onEdit(row)}>
            修改
          </Button>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(row) => row.id}
      caption="收款计划"
      emptySlot={
        <EmptyState
          title="还没有收款计划"
          description="按模板生成或在下方「新增一期」手工添加。"
        />
      }
    />
  );
}
