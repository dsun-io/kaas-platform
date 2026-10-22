"use client";

/**
 * 询盘工位（/inquiries）—— 设计 §9.1 的独立一等工位。
 *
 * 为什么以前没有这个页面：询盘只能"按客户归类"在客户页里看，跨客户的问题
 * （这个月展会来了多少询盘？哪条询盘报了价还没成单？）既慢又回答不了。
 * 现在询盘是独立工位：跨客户列表 + 阶段/渠道/时间筛选 + 详情报价历史。
 *
 * 分页口径（重要）：内核 `GET /inquiries` **不支持 page/page_size**
 * （ws_crm_ext.py:303-399 一次返回全部可见行，total=len(rows)），
 * 所以这里做**客户端分页**：请求不带任何分页参数，切片在本页完成。
 * 不伪造服务端翻页 —— 否则 mock 能翻、生产翻不动（这类"假功能"已踩过坑）。
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, Inbox } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { SectionCard } from "@/components/shared/section-card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { normalizeApiError } from "@/lib/api/api-error";
import { usePageView } from "@/lib/events/use-page-view";
import {
  EMPTY_INQUIRY_FILTERS,
  INQUIRIES_PAGE_SIZE,
  hasActiveInquiryFilters,
  paginateInquiryRows,
  type InquiryFilters,
} from "@/lib/inquiries/filters";
import { reopenStatus } from "@/lib/inquiries/stage";
import type { InquiryRow } from "@/lib/inquiries/types";

import { InquiryDetailDrawer } from "./components/inquiry-detail-drawer";
import { InquiryFilterBar } from "./components/inquiry-filter-bar";
import { InquiryListTable } from "./components/inquiry-list-table";
import { useInquiriesList, useUpdateInquiry } from "./hooks/use-inquiries";

export default function InquiriesPage() {
  usePageView({ resource_id: "/inquiries" });

  const [filters, setFilters] = useState<InquiryFilters>(EMPTY_INQUIRY_FILTERS);
  const [page, setPage] = useState(1);
  const list = useInquiriesList(filters);
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const slice = paginateInquiryRows(rows, page);
  const applied = hasActiveInquiryFilters(filters);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  // 行内「关闭 / 重开」也走二次确认：状态机里只有关闭是手动动作，重开会回已报价
  const [statusRow, setStatusRow] = useState<InquiryRow | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const update = useUpdateInquiry();

  // 深链支持 /inquiries?inquiry_id=<id>：从订单来源链/客户页跳过来直接打开详情。
  // 不用 useSearchParams（静态导出下需要 Suspense 包裹，quotes 页已踩过），
  // 直接在挂载后读 location.search。
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get("inquiry_id");
    const id = raw === null ? Number.NaN : Number(raw);
    if (Number.isInteger(id) && id > 0) setSelectedId(id);
  }, []);

  const applyFilters = (next: InquiryFilters) => {
    setFilters(next);
    setPage(1); // 筛选变化必须回第 1 页（否则停在越界页看到空列表）
  };

  const resetFilters = () => {
    setFilters(EMPTY_INQUIRY_FILTERS);
    setPage(1);
  };

  const toggleStatus = (row: InquiryRow) => {
    setStatusError(null);
    setStatusRow(row);
  };

  const confirmToggleStatus = async () => {
    if (!statusRow) return;
    const target =
      statusRow.status === "closed"
        ? reopenStatus("closed", statusRow.quote_count > 0)
        : "closed";
    if (!target) return;
    setStatusError(null);
    try {
      await update.mutateAsync({ id: statusRow.id, patch: { status: target } });
      toast.success(target === "closed" ? "询盘已关闭" : "询盘已重新打开");
      setStatusRow(null);
    } catch (error) {
      setStatusError(normalizeApiError(error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="询盘"
        description="跨客户的询盘总表：阶段/渠道/时间筛选，点开看报价历史与关联订单；报价与订单都从这里继续。"
        actions={
          <Link href="/quotes?tab=product">
            <Button variant="outline" size="sm">
              去报价工位 →
            </Button>
          </Link>
        }
      />

      <SectionCard
        title="筛选"
        description="阶段=业务流程进度；状态=报价三态；渠道/客户/时间按创建时间切。"
      >
        <InquiryFilterBar
          value={filters}
          onApply={applyFilters}
          disabled={list.isFetching}
          resultCount={list.data?.total}
        />
      </SectionCard>

      <SectionCard
        title={`询盘列表（共 ${list.data?.total ?? 0} 条）`}
        description="一行看清「这个询盘后来怎样了」：报价数 / 关联订单数 / 最近报价时间。"
      >
        {list.isLoading ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="询盘列表加载中"
          >
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : list.isError ? (
          <div className="flex items-center gap-2 py-8 text-sm text-destructive">
            <AlertCircle className="size-4" />
            读取询盘失败。请确认后端服务已启动。
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={applied ? AlertCircle : Inbox}
            title={applied ? "没有符合筛选条件的询盘" : "还没有询盘"}
            description={
              applied
                ? "换个条件试试：把阶段/状态/时间范围放宽，或清空关键字。"
                : "询盘是报价与单据的起点：在客户页添加询盘后，这里会跨客户汇总显示。"
            }
            action={
              applied ? (
                <Button size="sm" variant="outline" onClick={resetFilters}>
                  清空筛选
                </Button>
              ) : (
                <Link href="/customers">
                  <Button size="sm">去客户页添加询盘</Button>
                </Link>
              )
            }
          />
        ) : (
          <>
            <InquiryListTable
              rows={slice.rows}
              onOpen={setSelectedId}
              onToggleClosed={toggleStatus}
              togglingId={update.isPending ? (statusRow?.id ?? null) : null}
            />
            <PaginationBar
              page={slice.page}
              pageSize={INQUIRIES_PAGE_SIZE}
              total={slice.total}
              currentCount={slice.rows.length}
              loading={list.isFetching}
              onPageChange={setPage}
              ariaLabel="询盘列表分页"
            />
          </>
        )}
      </SectionCard>

      {selectedId !== null ? (
        <InquiryDetailDrawer
          inquiryId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      ) : null}

      <ConfirmDialog
        open={statusRow !== null}
        onOpenChange={(open) => {
          if (!open) setStatusRow(null);
        }}
        title={statusRow?.status === "closed" ? "重新打开询盘？" : "关闭询盘？"}
        description={
          statusRow?.status === "closed"
            ? "重新打开后状态回到「已报价」（该询盘已有报价）或「待报价」；阶段不会回退。"
            : "关闭后询盘进入终态：阶段记为「关闭」，并写一条阶段流水；之后只能重新打开。"
        }
        confirmLabel={statusRow?.status === "closed" ? "重新打开" : "关闭询盘"}
        pending={update.isPending}
        error={statusError}
        onConfirm={() => void confirmToggleStatus()}
      />
    </div>
  );
}
