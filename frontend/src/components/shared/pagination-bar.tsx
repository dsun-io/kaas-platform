"use client";

/**
 * 列表分页条（C25）：显示「当前范围 + 总数 + 页码」并提供上一页/下一页。
 *
 * 为什么抽成共享控件：orders / events / audit 三个列表后端都已经是同一套分页契约
 * （`page` / `page_size` → `{items, total, page, page_size}`，**没有 has_more**），
 * 各页各写一份翻页逻辑必然漂移（有的算错末页、有的忘了"筛选后回第 1 页"）。
 *
 * 设计取舍：
 * - **只做上一页/下一页**（不渲染页码按钮）：这三个列表的总量都在千级以下但页数不定，
 *   页码按钮要么截断成省略号（多一套状态机）要么撑爆工具栏；上下页 + "第 X / Y 页"
 *   已经够用，且与 `intel/shipments-table` 的既有形态一致。
 * - **范围用 `currentCount` 精确算**（末页可能不满、后端可能钳位 page_size）：
 *   只按 `page*page_size` 猜会把"第 21–40 条"显示成实际不存在的区间。
 * - 只有一页（或没有数据）时**不渲染** —— 与 shipments 表 `totalPages > 1` 同口径。
 */
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  /** 当前页（1 起）；后端钳位后可能大于总页数，组件内部会夹紧显示 */
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  /** 本页实际条数（末页不满时用；不给则按 pageSize 推算上限） */
  currentCount?: number;
  /** 翻页请求进行中（禁用按钮，避免连点跳页） */
  loading?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function PaginationBar({
  page,
  pageSize,
  total,
  onPageChange,
  currentCount,
  loading = false,
  className,
  ariaLabel = "列表分页",
}: Props) {
  const safePageSize = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(Math.max(0, total) / safePageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = total <= 0 ? 0 : (safePage - 1) * safePageSize + 1;
  const to =
    total <= 0
      ? 0
      : currentCount !== undefined
        ? Math.min(from + Math.max(0, currentCount) - 1, total)
        : Math.min(safePage * safePageSize, total);

  // 一页装得下就没有翻页可做（空列表同理）—— 不占版面
  if (total <= safePageSize) return null;

  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "mt-4 flex flex-wrap items-center justify-center gap-3",
        className,
      )}
    >
      <span className="text-sm text-muted-foreground">
        第 {from}–{to} 条 / 共 {total} 条
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(safePage - 1)}
        disabled={safePage <= 1 || loading}
      >
        <ChevronLeft className="mr-1 h-4 w-4" />
        上一页
      </Button>
      <span className="text-sm text-muted-foreground">
        第 {safePage} / {totalPages} 页
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onPageChange(safePage + 1)}
        disabled={safePage >= totalPages || loading}
      >
        下一页
        <ChevronRight className="ml-1 h-4 w-4" />
      </Button>
    </nav>
  );
}
