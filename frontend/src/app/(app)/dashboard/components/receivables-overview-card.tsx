"use client";

/**
 * 订单应收概览（P0-A A3）—— 接 `GET /api/v1/dashboard/receivables` 真实数据。
 *
 * 显示口径（全部来自内核聚合，前端**不重算**）：
 *  · `by_currency`：每币种一行 total / received / outstanding / count；
 *    **不做跨币种合计**（不同币种硬加无意义，折算口径归后端）；
 *  · `by_status`：未收 / 部分收款 / 已收清的**笔数**摘要
 *    （`by_status.total` 是跨币种原值相加，只作规模参考，这里不当金额展示）；
 *  · `totals.count`：时间窗内应收行数（唯一可跨状态/跨币种的计数）。
 *
 * 为什么以前是「待补后端」空态：当时内核只有 `GET /receivables` 分页台账，
 * 前端自己拼会得出**只覆盖当前页**的假数字；A3 补了聚合端点后这里改接真实数据。
 */
import { Wallet } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { SectionCard } from "@/components/shared/section-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { normalizeApiError } from "@/lib/api/api-error";
import { formatAmount } from "@/lib/dashboard/funnel";
import {
  isEmptyReceivables,
  receivableStatusLabel,
  sortReceivableStatuses,
} from "@/lib/dashboard/receivables";

import { useDashboardReceivables } from "../hooks/use-dashboard-receivables";

export function ReceivablesOverviewCard({ range }: { range: string }) {
  const { data, error, isError, isLoading, refetch } =
    useDashboardReceivables(range);
  const empty = isEmptyReceivables(data);
  const currencies = data?.by_currency ?? [];
  const statuses = data?.by_status ?? [];
  const multiCurrency = currencies.length > 1;

  return (
    <SectionCard
      title="订单应收概览"
      description="时间窗内应收（按币种分组，金额不跨币种相加）。"
    >
      {isLoading ? (
        <LoadingBlock rows={3} />
      ) : isError ? (
        <ErrorState
          title="应收数据读取失败"
          message={normalizeApiError(error).message}
          onRetry={() => void refetch()}
        />
      ) : !data || empty ? (
        <EmptyState
          icon={Wallet}
          title="本时间窗内没有应收"
          description="应收在订单创建收款计划并登记实收后产生；可以换个更长的时间范围。"
        />
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">
            共 {data.totals.count} 笔应收
            {multiCurrency ? "（多币种按行分列，未做跨币种合计）" : ""}
          </p>

          <Table aria-label="应收按币种">
            <TableHeader>
              <TableRow>
                <TableHead>币种</TableHead>
                <TableHead className="text-right">应收总额</TableHead>
                <TableHead className="text-right">已收</TableHead>
                <TableHead className="text-right">未收</TableHead>
                <TableHead className="text-right">笔数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {currencies.map((row) => (
                <TableRow
                  key={row.currency}
                  data-testid={`receivable-currency-${row.currency}`}
                >
                  <TableCell className="font-medium">{row.currency}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(row.total)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(row.received)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatAmount(row.outstanding)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.count}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {sortReceivableStatuses(statuses).map((row) => (
              <span
                key={row.status}
                data-testid={`receivable-status-${row.status}`}
              >
                {receivableStatusLabel(row.status)} {row.count} 笔
              </span>
            ))}
          </div>

          {/* 诚实口径：金额只在同币种内汇总；状态金额是跨币种原值，不作金额展示 */}
          <p className="text-[11px] text-muted-foreground">
            金额只做同币种内汇总（未折算）；状态笔数是跨币种计数。
          </p>
        </div>
      )}
    </SectionCard>
  );
}
