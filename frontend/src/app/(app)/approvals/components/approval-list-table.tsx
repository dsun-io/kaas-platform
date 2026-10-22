"use client";

/**
 * 审批中心列表（三视图共用的列）。
 *
 * 列口径 = 设计 §6.2：类型 / 订单号 / 申请人 / 提交时间 / 金额变化 / 状态。
 * 行内「查看」按钮（而不是整行可点）：表格行做成可点会丢掉键盘可达性，
 * e2e a11y 还会把无名称交互报出来。
 */
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { describeAmountChange } from "@/lib/approvals/diff";
import {
  changeStatusMeta,
  formatDateTime,
  orderStatusLabel,
  orderStatusTone,
} from "@/lib/approvals/format";
import type { ApprovalItem } from "@/lib/approvals/types";

export function ApprovalListTable({
  items,
  onOpen,
}: {
  items: readonly ApprovalItem[];
  onOpen: (item: ApprovalItem) => void;
}) {
  return (
    <Table aria-label="审批申请列表">
      <TableHeader>
        <TableRow>
          <TableHead>类型</TableHead>
          <TableHead>订单号</TableHead>
          <TableHead>申请人</TableHead>
          <TableHead>提交时间</TableHead>
          <TableHead>金额变化</TableHead>
          <TableHead>状态</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          const status = changeStatusMeta(item.status);
          return (
            <TableRow key={item.id}>
              <TableCell>货物明细变更</TableCell>
              <TableCell>
                <div className="font-medium">
                  {item.order_no ?? `订单 #${item.order_id}`}
                </div>
                <div className="mt-0.5">
                  <StatusBadge
                    tone={orderStatusTone(item.order_status)}
                    dot={false}
                  >
                    {orderStatusLabel(item.order_status)}
                  </StatusBadge>
                </div>
              </TableCell>
              <TableCell>
                {item.requester_name ??
                  (item.requested_by !== null ? `#${item.requested_by}` : "—")}
              </TableCell>
              <TableCell
                className="text-muted-foreground"
                title={item.created_at ?? undefined}
              >
                {formatDateTime(item.created_at)}
              </TableCell>
              <TableCell className="tabular-nums">
                {describeAmountChange(
                  item.snapshot,
                  item.items,
                  item.order_currency,
                )}
              </TableCell>
              <TableCell>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`查看申请 #${item.id}`}
                  onClick={() => onOpen(item)}
                >
                  查看
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
