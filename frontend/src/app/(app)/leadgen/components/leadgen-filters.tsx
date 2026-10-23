"use client";

/** 线索池筛选条（从 page.tsx 拆出；选项集合与文案保持原样）。 */
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

import { INQUIRY_STATUS_CN, OUTREACH_STATUS_CN } from "../lib/status-labels";

const OUTREACH_FILTERS = [
  "none",
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
] as const;
const INQUIRY_FILTERS = ["new", "following", "won", "lost"] as const;

export function LeadgenFilters({
  search,
  onSearchChange,
  outreachFilter,
  onOutreachFilterChange,
  inquiryFilter,
  onInquiryFilterChange,
  sort,
  onSortChange,
  onCreateManual,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  outreachFilter: string;
  onOutreachFilterChange: (value: string) => void;
  inquiryFilter: string;
  onInquiryFilterChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  onCreateManual: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Input
        className="w-56"
        placeholder="搜索公司 / 城市…"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={outreachFilter}
        onChange={(e) => onOutreachFilterChange(e.target.value)}
      >
        <option value="">触达：全部</option>
        {OUTREACH_FILTERS.map((s) => (
          <option key={s} value={s}>
            {OUTREACH_STATUS_CN[s] ?? s}
          </option>
        ))}
      </select>
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={inquiryFilter}
        onChange={(e) => onInquiryFilterChange(e.target.value)}
      >
        <option value="">询盘：全部</option>
        {INQUIRY_FILTERS.map((s) => (
          <option key={s} value={s}>
            {INQUIRY_STATUS_CN[s] ?? s}
          </option>
        ))}
      </select>
      <select
        className="rounded-md border bg-background px-3 py-2 text-sm"
        value={sort}
        onChange={(e) => onSortChange(e.target.value)}
      >
        <option value="score">排序：匹配分</option>
        <option value="recent">排序：最近</option>
        <option value="name">排序：名称</option>
      </select>
      <Button size="sm" variant="outline" onClick={onCreateManual}>
        新建线索
      </Button>
    </div>
  );
}
