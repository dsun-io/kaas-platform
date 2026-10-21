"use client";

/**
 * 应收汇总卡（C36 下期 #7）
 *
 * 口径：**按币种分组**，不跨币种相加（应收行没有"已收金额的本币折算"字段，
 * 硬折会引入新假设）。汇总来自单独的 ≤200 条窗口查询，卡上标注窗口范围，
 * 避免把"窗口内合计"读成"全局合计"。
 */
import { Wallet } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReceivablesSummary } from "@/lib/receivables/summary";

function money(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ReceivablesSummaryCards({
  summary,
  windowCount,
  loading = false,
}: {
  summary: ReceivablesSummary;
  /** 汇总窗口实际行数（≤200） */
  windowCount: number;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Wallet className="h-4 w-4" />
          应收汇总
          <span className="text-xs font-normal text-muted-foreground">
            （按币种分组；统计口径：最新 {windowCount} 条，超出请用状态筛选）
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : summary.byCurrency.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            当前筛选下没有应收记录。
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summary.byCurrency.map((entry) => (
              <div key={entry.currency} className="rounded-lg border p-3">
                <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{entry.currency}</span>
                  <span>{entry.count} 条</span>
                </div>
                <dl className="space-y-0.5 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">应收总额</dt>
                    <dd className="font-mono">
                      {money(entry.currency, entry.total)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">已收</dt>
                    <dd className="font-mono text-success">
                      {money(entry.currency, entry.received)}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">未收</dt>
                    <dd className="font-mono font-semibold text-destructive">
                      {money(entry.currency, entry.outstanding)}
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
        )}
        {!loading && summary.byCurrency.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            状态分布：未收 {summary.byStatus.unpaid ?? 0} · 部分收款{" "}
            {summary.byStatus.partial ?? 0} · 已收清{" "}
            {summary.byStatus.paid ?? 0}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
