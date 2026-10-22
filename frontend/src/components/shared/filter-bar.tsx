"use client";

/**
 * 筛选区容器（P0-C）：统一「筛选控件 + 防抖搜索 + 重置」的排布。
 *
 * 为什么抽：各列表页的筛选条有 3 种写法（有的每键请求、有的没有重置、有的把
 * "重置"做成清空某个 state），用户在不同页面学到不同操作。这里统一：
 * - 搜索框**防抖**（内部 `useDebouncedValue`，默认 300ms）：输入即时回显，
 *   但只在停顿后才 `onSearchCommit`（调用方在那里发请求 / 写 URL）；
 * - 重置按钮只在传了 `onReset` 时出现；
 * - 布局可换行（1366×768 不横向溢出），子控件由调用方给（Select/日期/复选框…）。
 *
 * 用法：
 * ```tsx
 * <FilterBar
 *   searchValue={search}
 *   onSearchChange={setSearch}
 *   onSearchCommit={(v) => setQueryParam("q", v)}
 *   onReset={resetFilters}
 * >
 *   <Select … />
 * </FilterBar>
 * ```
 */
import { RotateCcw, Search } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { cn } from "@/lib/utils";

export interface FilterBarProps {
  /** 搜索框之外的筛选控件 */
  children?: React.ReactNode;
  /** 重置回调；传了才渲染「重置」按钮 */
  onReset?: () => void;
  /** 重置按钮文案，默认「重置」 */
  resetLabel?: string;
  /** 搜索框受控值（配合 onSearchChange；不传则不渲染搜索框） */
  searchValue?: string;
  /** 搜索框输入回调（每次击键都触发，用于受控回显） */
  onSearchChange?: (value: string) => void;
  /** 防抖后的搜索回调（停顿 debounceMs 后触发一次；挂载时不触发） */
  onSearchCommit?: (value: string) => void;
  /** 搜索框占位文案，默认「搜索」 */
  searchPlaceholder?: string;
  /** 防抖时长（毫秒），默认 300 */
  debounceMs?: number;
  className?: string;
  /** 容器无障碍名称，默认「筛选」 */
  ariaLabel?: string;
}

export function FilterBar({
  children,
  onReset,
  resetLabel = "重置",
  searchValue,
  onSearchChange,
  onSearchCommit,
  searchPlaceholder = "搜索",
  debounceMs = 300,
  className,
  ariaLabel = "筛选",
}: FilterBarProps) {
  const showSearch = onSearchChange !== undefined;
  const debouncedSearch = useDebouncedValue(searchValue ?? "", debounceMs);

  // onSearchCommit 常用内联箭头函数：放进 ref，避免每次父渲染都"提交"一次。
  const commitRef = useRef(onSearchCommit);
  useEffect(() => {
    commitRef.current = onSearchCommit;
  }, [onSearchCommit]);

  // 挂载时不提交：初始值通常已经由页面用于首屏查询，再提交会打两次请求。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    commitRef.current?.(debouncedSearch);
  }, [debouncedSearch]);

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-2",
        className,
      )}
    >
      {showSearch ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={searchValue ?? ""}
            onChange={(event) => onSearchChange?.(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-8 w-56 pl-7"
          />
        </div>
      ) : null}

      {children}

      {onReset ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={onReset}
        >
          <RotateCcw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
          {resetLabel}
        </Button>
      ) : null}
    </div>
  );
}
