"use client";

/**
 * 报价历史（1:N）——「客户上次问的是什么价、我们报了多少、改价几次」一站看全。
 *
 * 数据来自详情响应的 `quotes[]`（内核 ws_crm_ext.py:426-448：row_to_quote + order_count，
 * 按 created_at,id **正序** = 改价轨迹）。列表接口不返回行项（防 N+1），
 * 这里只显示 item_count；行项/成本明细去报价工位看。
 *
 * 打印入口：当前应用没有"按报价单号直达打印"的路由（单证在 /trade-docs 生成后打印），
 * 所以这里的入口落到单证工位，并在报告里登记为建议优化点。
 */
import Link from "next/link";

import { StatusBadge } from "@/components/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatInquiryDateTime,
  formatInquiryMoney,
  quoteStatusLabel,
  quoteStatusTone,
} from "@/lib/inquiries/format";
import type { InquiryQuote } from "@/lib/inquiries/types";

export function InquiryQuoteHistory({ quotes }: { quotes: InquiryQuote[] }) {
  if (quotes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        还没有报价单。点下方「为此询盘报价
        →」去报价工位开单；一张询盘可以多次报价 （改价重报），历史都会留在下面。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>报价单号</TableHead>
            <TableHead>时间</TableHead>
            <TableHead className="text-right">金额</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">行项数</TableHead>
            <TableHead className="text-right">关联订单</TableHead>
            <TableHead>打印</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotes.map((quote) => (
            <TableRow key={quote.id}>
              <TableCell className="font-mono text-xs">
                {quote.quote_no}
              </TableCell>
              <TableCell className="text-xs">
                <span title={quote.created_at ?? undefined}>
                  {formatInquiryDateTime(quote.created_at)}
                </span>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {formatInquiryMoney(quote.total_amount, quote.currency)}
              </TableCell>
              <TableCell>
                <StatusBadge tone={quoteStatusTone(quote.status)}>
                  {quoteStatusLabel(quote.status)}
                </StatusBadge>
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {quote.item_count}
              </TableCell>
              <TableCell className="text-right text-xs tabular-nums">
                {quote.order_count}
              </TableCell>
              <TableCell>
                <Link
                  href="/trade-docs"
                  className="text-xs font-medium text-primary hover:underline"
                  aria-label={`去单证工位查看/打印报价单 ${quote.quote_no}`}
                >
                  查看/打印 →
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
