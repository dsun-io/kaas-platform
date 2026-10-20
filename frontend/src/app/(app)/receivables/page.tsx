"use client";

/**
 * 应收台账页面（C36 下期 #7 · `GET /api/v1/receivables`）
 *
 * 入口为什么放在**订单页**而不是侧栏：
 *   侧栏导航由共享契约 `shared/contracts/workstations.ts` 驱动，且 R2 规则把
 *   `WORKSTATIONS` 与后端 `kaas_common/domain/workstations.py` 逐条比对 ——
 *   加一个导航项=改契约+改后端共享内核（超出本任务写范围）。应收由订单产生、
 *   与订单金额同源，从订单页进语义最顺（页头加了入口按钮），因此本轮走订单页入口。
 *
 * 后端能力边界（页面必须如实标注，不能装成全量筛选）：
 *   - ✅ `status` 服务端过滤；`page/page_size` 服务端分页
 *   - ❌ 无 `customer` 参数 ⇒ 客户名筛选只作用于**当前页**
 *   - ❌ 无 `due_date` 字段 ⇒ 逾期判据按订单取 `payment-schedules`，
 *        且只对**当前页**订单取（≤20 个请求）；取不到即「未知」，不猜
 *   - 汇总来自单独的 ≤200 条窗口查询（带同一 status 条件）
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { RouteGuard } from "@/components/route-guard";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageView } from "@/lib/events/use-page-view";
import {
  RECEIVABLE_STATUS_LABEL,
  filterReceivables,
  summarizeReceivables,
  type ReceivableStatus,
} from "@/lib/receivables/summary";

import { ReceivablesSummaryCards } from "./components/receivables-summary";
import { ReceivablesTable } from "./components/receivables-table";
import {
  RECEIVABLES_PAGE_SIZE,
  RECEIVABLES_SUMMARY_WINDOW,
  orderIdOf,
  useReceivables,
  useReceivablesSummaryWindow,
} from "./hooks/use-receivables";
import { useOrderDueDates } from "./hooks/use-order-due-dates";

const STATUS_OPTIONS: Array<{ value: ReceivableStatus | "all"; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "unpaid", label: RECEIVABLE_STATUS_LABEL.unpaid },
  { value: "partial", label: RECEIVABLE_STATUS_LABEL.partial },
  { value: "paid", label: RECEIVABLE_STATUS_LABEL.paid },
];

export default function ReceivablesPage() {
  usePageView({ resource_id: "/receivables" });

  const [status, setStatus] = useState<ReceivableStatus | "all">("all");
  const [customer, setCustomer] = useState("");
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [page, setPage] = useState(1);

  const list = useReceivables({ page, status });
  const summaryWindow = useReceivablesSummaryWindow({ status });

  const pageRows = useMemo(() => list.data?.items ?? [], [list.data]);
  const windowRows = useMemo(
    () => summaryWindow.data?.items ?? [],
    [summaryWindow.data],
  );

  // 逾期判据只对当前页订单取（≤20 个请求）；汇总窗口不取到期日（不放大 N+1）
  const currentPageOrderIds = useMemo(
    () => pageRows.map((row) => orderIdOf(row)).filter((id): id is number => id !== null),
    [pageRows],
  );
  const { dueByOrder, loading: dueLoading, failedCount } = useOrderDueDates(
    currentPageOrderIds,
  );

  const filteredRows = useMemo(
    () =>
      filterReceivables(
        pageRows,
        { status: "all", customer, onlyOverdue },
        dueByOrder,
      ),
    [pageRows, customer, onlyOverdue, dueByOrder],
  );

  const summary = useMemo(() => summarizeReceivables(windowRows), [windowRows]);
  const total = list.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / RECEIVABLES_PAGE_SIZE));

  return (
    <RouteGuard internalOnly>
      <div className="space-y-6">
        <PageHeader
          title="应收台账"
          description="按订单汇总的应收账款：金额、已收/未收、逾期（到期日来自该订单的收款计划）。"
          actions={
            <Link href="/orders">
              <Button variant="outline" size="sm">
                <ArrowLeft className="mr-1 h-4 w-4" />
                返回订单
              </Button>
            </Link>
          }
        />

        <ReceivablesSummaryCards
          summary={summary}
          windowCount={Math.min(summaryWindow.data?.total ?? 0, RECEIVABLES_SUMMARY_WINDOW)}
          loading={summaryWindow.isLoading}
        />

        <SectionCard
          title="应收明细"
          description={`服务端支持状态筛选与分页；客户名/只看逾期作用于当前页（后端接口暂未提供这两个参数）。${
            failedCount > 0
              ? ` 有 ${failedCount} 个订单的收款计划读取失败，逾期列显示「未知」。`
              : ""
          }`}
        >
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">状态</span>
              <select
                aria-label="状态筛选"
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as ReceivableStatus | "all");
                  setPage(1);
                }}
              >
                {STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">客户/订单号（当前页）</span>
              <Input
                aria-label="客户筛选"
                className="h-8 w-48 text-xs"
                placeholder="输入客户名或订单号"
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
              />
            </label>

            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                aria-label="只看逾期"
                checked={onlyOverdue}
                onChange={(e) => setOnlyOverdue(e.target.checked)}
              />
              <span>只看逾期（当前页）</span>
            </label>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void list.refetch();
                void summaryWindow.refetch();
              }}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              刷新
            </Button>
            <span className="text-xs text-muted-foreground">
              {pageRows.length} / {total} 条
            </span>
          </div>

          {list.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-full rounded" />
              ))}
            </div>
          ) : list.isError ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-destructive">
                读取应收台账失败：{String((list.error as Error)?.message ?? "请稍后重试")}
              </CardContent>
            </Card>
          ) : pageRows.length === 0 ? (
            <EmptyState
              title="暂无应收记录"
              description="订单确认后会自动生成应收；没有订单时这里是空的。"
            />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              title="当前页没有符合条件的记录"
              description="客户名/只看逾期只作用于当前页；试试翻页或清空筛选。"
            />
          ) : (
            <ReceivablesTable
              rows={filteredRows}
              dueByOrder={dueByOrder}
              dueLoading={dueLoading}
            />
          )}

          <PaginationBar
            page={page}
            pageSize={RECEIVABLES_PAGE_SIZE}
            total={total}
            currentCount={pageRows.length}
            loading={list.isFetching}
            onPageChange={(next) => {
              // 翻页后当前页变了 ⇒ 清掉页内筛选，避免"第 2 页看起来是空的"
              setCustomer("");
              setOnlyOverdue(false);
              setPage(Math.min(Math.max(next, 1), totalPages));
            }}
            ariaLabel="应收台账分页"
            className="mt-3"
          />
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
