"use client";

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Eye } from "lucide-react";
import type { Quotation } from "../hooks/use-quotations";

const STATUS_BADGE: Record<
  string,
  { variant: "default" | "destructive" | "secondary"; label: string }
> = {
  matched: { variant: "default", label: "已匹配" },
  estimated: { variant: "destructive", label: "参考价 - 需人工确认" },
  spec_not_supported: { variant: "secondary", label: "已废止" },
};

interface Props {
  quotations: Quotation[];
  onSelect: (q: Quotation) => void;
  loading?: boolean;
}

function QuotationRow({
  q,
  onSelect,
}: {
  q: Quotation;
  onSelect: (q: Quotation) => void;
}) {
  const statusBadge = STATUS_BADGE[q.status] ?? {
    variant: "secondary" as const,
    label: q.status,
  };
  return (
    <TableRow className={q.unit_price === null ? "opacity-50" : undefined}>
      <TableCell className="hidden sm:table-cell font-mono text-xs">
        {q.quotation_id}
      </TableCell>
      <TableCell className="hidden md:table-cell text-xs">
        {q.customer_id}
      </TableCell>
      <TableCell>{q.product_category}</TableCell>
      <TableCell>{q.quantity}</TableCell>
      <TableCell>
        {q.unit_price !== null ? `¥${q.unit_price.toFixed(2)}` : "—"}
      </TableCell>
      <TableCell>
        <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Badge variant="outline" className="text-xs">
          {q.source}
        </Badge>
      </TableCell>
      <TableCell className="hidden md:table-cell text-xs">
        {new Date(q.effective_from).toLocaleDateString("zh-CN")}
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon-xs" onClick={() => onSelect(q)}>
          <Eye className="size-3" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

export function QuotationTable({ quotations, onSelect, loading }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: quotations.length > 200 ? quotations.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="报价列表加载中">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (quotations.length === 0) {
    return (
      <EmptyState
        title="暂无报价记录"
        description="调整筛选条件，或从「产品报价」保存一张报价单后再回来查看。"
        className="border-0 py-8"
      />
    );
  }

  if (quotations.length <= 200) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden sm:table-cell">报价编号</TableHead>
            <TableHead className="hidden md:table-cell">客户</TableHead>
            <TableHead>品类</TableHead>
            <TableHead>数量</TableHead>
            <TableHead>单价</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="hidden sm:table-cell">来源</TableHead>
            <TableHead className="hidden md:table-cell">有效期</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotations.map((q) => (
            <QuotationRow key={q.id} q={q} onSelect={onSelect} />
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div ref={parentRef} style={{ height: "600px", overflow: "auto" }}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden sm:table-cell">报价编号</TableHead>
            <TableHead className="hidden md:table-cell">客户</TableHead>
            <TableHead>品类</TableHead>
            <TableHead>数量</TableHead>
            <TableHead>单价</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="hidden sm:table-cell">来源</TableHead>
            <TableHead className="hidden md:table-cell">有效期</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <tr style={{ height: `${virtualizer.getTotalSize()}px` }}>
            <td style={{ padding: 0 }} colSpan={9}>
              <div style={{ position: "relative" }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const q = quotations[virtualItem.index]!;
                  return (
                    <div
                      key={q.id}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        height: `${virtualItem.size}px`,
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      <QuotationRow q={q} onSelect={onSelect} />
                    </div>
                  );
                })}
              </div>
            </td>
          </tr>
        </TableBody>
      </Table>
    </div>
  );
}
