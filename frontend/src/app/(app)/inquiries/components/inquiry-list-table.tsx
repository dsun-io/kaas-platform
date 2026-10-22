"use client";

/**
 * 询盘列表（桌面表格 + 窄屏卡片）。
 *
 * 一行要回答「这个询盘后来怎样了」：客户 / 产品摘要 / 渠道 / 阶段徽标 /
 * 报价数 / 关联订单数 / 最近报价时间（设计 §8「不必逐条点进去」）。
 * 动作：
 *  · 「报价 →」= 与 customers 页逐字相同的深链（`/quotes?tab=product&customer_id=&inquiry_id=`），
 *    去报价工位继续开单；
 *  · 「详情」打开右侧抽屉（产品行/渠道可编辑、报价历史、关联订单、阶段时间线）；
 *  · 「关闭 / 重开」走状态机（内核 ws_crm_ext.py:_INQUIRY_NEXT，非法流转 409）。
 */
import Link from "next/link";
import type { Route } from "next";
import { ChevronRight } from "lucide-react";

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
import { inquiryQuoteHref } from "@/lib/inquiries/filters";
import {
  channelLabel,
  formatInquiryDate,
  formatInquiryDateTime,
  inquiryItemViews,
  inquiryProductSummary,
} from "@/lib/inquiries/format";
import { resolveInquiryStage } from "@/lib/inquiries/stage";
import type { InquiryRow } from "@/lib/inquiries/types";

const QUOTE_LINK_CLASS =
  "inline-flex h-7 items-center rounded-lg border border-border bg-white/70 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-white";

export function InquiryListTable({
  rows,
  onOpen,
  onToggleClosed,
  togglingId = null,
}: {
  rows: InquiryRow[];
  onOpen: (id: number) => void;
  onToggleClosed: (row: InquiryRow) => void;
  togglingId?: number | null;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>询盘号</TableHead>
              <TableHead>客户</TableHead>
              <TableHead>产品摘要</TableHead>
              <TableHead>渠道</TableHead>
              <TableHead>阶段</TableHead>
              <TableHead className="text-right">报价数</TableHead>
              <TableHead className="text-right">关联订单</TableHead>
              <TableHead>最近报价</TableHead>
              <TableHead>创建时间</TableHead>
              <TableHead>操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const stage = resolveInquiryStage(row.stage, row.status);
              const closed = row.status === "closed";
              return (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-muted/40"
                  onClick={() => onOpen(row.id)}
                >
                  <TableCell className="font-mono text-xs font-medium">
                    {row.inquiry_no ?? `询盘 #${row.id}`}
                  </TableCell>
                  <TableCell>{row.company_name ?? "—"}</TableCell>
                  <TableCell
                    className="max-w-[16rem] truncate"
                    title={inquiryProductSummary(inquiryItemViews(row))}
                  >
                    {inquiryProductSummary(inquiryItemViews(row))}
                  </TableCell>
                  <TableCell className="text-xs">
                    {channelLabel(row.channel)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.quote_count}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.order_count}
                  </TableCell>
                  <TableCell className="text-xs">
                    {row.latest_quote_at ? (
                      <span title={row.latest_quote_at}>
                        {formatInquiryDateTime(row.latest_quote_at)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">未报价</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span title={row.created_at ?? undefined}>
                      {formatInquiryDate(row.created_at)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <div
                      className="flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Link
                        href={inquiryQuoteHref(row) as Route}
                        className={QUOTE_LINK_CLASS}
                        aria-label={`为此询盘 ${row.inquiry_no ?? row.id} 报价`}
                      >
                        {row.quote_count > 0 ? "重新报价 →" : "为此询盘报价 →"}
                      </Link>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onOpen(row.id)}
                        aria-label={`查看询盘 ${row.inquiry_no ?? row.id} 详情`}
                      >
                        详情
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={togglingId === row.id}
                        onClick={() => onToggleClosed(row)}
                      >
                        {closed ? "重新打开" : "关闭"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* 窄屏卡片：DOM 在表格之后，避免隐藏节点干扰文本定位 */}
      <div className="divide-y divide-border/60 md:hidden">
        {rows.map((row) => {
          const stage = resolveInquiryStage(row.stage, row.status);
          const closed = row.status === "closed";
          return (
            <div
              key={row.id}
              className="flex items-center gap-3 px-5 py-4"
              role="group"
              aria-label={`询盘 ${row.inquiry_no ?? row.id}`}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                aria-label={`查看询盘 ${row.inquiry_no ?? row.id} 详情`}
                onClick={() => onOpen(row.id)}
              >
                <span className="block truncate font-medium">
                  {row.inquiry_no ?? `询盘 #${row.id}`}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {row.company_name ?? "—"} ·{" "}
                  {inquiryProductSummary(inquiryItemViews(row))}
                </span>
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  <StatusBadge tone={stage.tone}>{stage.label}</StatusBadge>
                  <span className="text-xs text-muted-foreground">
                    报价 {row.quote_count} · 订单 {row.order_count}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {channelLabel(row.channel)}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <Link
                  href={inquiryQuoteHref(row) as Route}
                  className={QUOTE_LINK_CLASS}
                  aria-label={`为此询盘 ${row.inquiry_no ?? row.id} 报价`}
                >
                  报价 →
                </Link>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={togglingId === row.id}
                  onClick={() => onToggleClosed(row)}
                >
                  {closed ? "重新打开" : "关闭"}
                </Button>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
            </div>
          );
        })}
      </div>
    </>
  );
}
