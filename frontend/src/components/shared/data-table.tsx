"use client";

/**
 * 声明式列表表格（P0-C）。
 *
 * 为什么抽：业务页现在大量手写原生 table/thead/th 结构（表头宽度用内联 style），
 * 每页各写一套 → 表头宽度/对齐/空态各不相同；失败/加载分支各页还会漏（有的把失败
 * 渲染成空态）。这里把「列定义 + 三态 + 分页插槽」收成一处，页面只描述数据。
 *
 * 内部只用 `@/components/ui/table`（`TableHead` 已默认 `scope="col"`），不自造 CSS。
 *
 * 三态优先级（按"用户最需要知道的信息"排序）：
 *   error → loading → empty → 表格本身
 * 传了插槽就用插槽（`errorSlot/loadingSlot/emptySlot`），否则用共享默认实现
 * （ErrorState / LoadingBlock / EmptyState），保证三态文案和行为全站一致。
 *
 * 用法：
 * ```tsx
 * <DataTable
 *   columns={[
 *     { key: "doc_no", header: "单号" },
 *     { key: "amount", header: "金额", align: "right", width: 120 },
 *     { key: "status", header: "状态", render: (row) => <StatusBadge … /> },
 *   ]}
 *   rows={items}
 *   getRowKey={(row) => row.id}
 *   loading={query.isLoading}
 *   error={query.isError ? normalizeApiError(query.error).message : null}
 *   onRetry={() => query.refetch()}
 *   emptySlot={<EmptyState title="暂无单证" description="调整筛选条件后重试" />}
 *   paginationSlot={<PaginationBar page={page} pageSize={pageSize} total={total} onPageChange={setPage} />}
 * />
 * ```
 */
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import { LoadingBlock } from "./loading-block";

export interface DataTableColumn<T> {
  /** 列唯一键（React key 用，通常等于字段名） */
  key: string;
  /** 表头内容 */
  header: React.ReactNode;
  /** 单元格渲染；不传则取 `row[key]` 的文本（null/undefined 显示 "—"） */
  render?: (row: T) => React.ReactNode;
  /** 对齐，默认 left */
  align?: "left" | "center" | "right";
  /** 列宽（数字按 px；也可传 "40%" 等） */
  width?: string | number;
  /** 表头 + 单元格附加类名 */
  className?: string;
}

export interface DataTableProps<T> {
  columns: readonly DataTableColumn<T>[];
  rows: readonly T[];
  /** 行主键（数据主键不叫 id 时由调用方指定） */
  getRowKey: (row: T) => React.Key;
  /** 加载中（渲染 loadingSlot，默认 LoadingBlock） */
  loading?: boolean;
  loadingSlot?: React.ReactNode;
  /** 空数据（渲染 emptySlot，默认 EmptyState「暂无数据」） */
  emptySlot?: React.ReactNode;
  /** 错误文案（非空即进入错误态，优先于 loading）；null/undefined/空串视为无错误 */
  error?: string | null | undefined;
  /** 自定义错误插槽（优先于 error 文案） */
  errorSlot?: React.ReactNode;
  /** 错误态重试回调（走默认 ErrorState 时使用） */
  onRetry?: () => void;
  /** 分页插槽（通常 PaginationBar），渲染在表格下方 */
  paginationSlot?: React.ReactNode;
  /** 表格的无障碍标题（sr-only caption），列表页建议给 */
  caption?: string;
  className?: string;
  /** 透传给 `<table>` 的类名（例如固定列宽） */
  tableClassName?: string;
}

const ALIGN_CLASS: Record<
  NonNullable<DataTableColumn<unknown>["align"]>,
  string
> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
};

function formatCellValue(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number") return value;
  // 非标量字段必须由调用方给 render（否则 React 无法安全渲染对象）
  return "—";
}

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  loading = false,
  loadingSlot,
  emptySlot,
  error = null,
  errorSlot,
  onRetry,
  paginationSlot,
  caption,
  className,
  tableClassName,
}: DataTableProps<T>) {
  const hasError = errorSlot !== undefined || (error != null && error !== "");

  if (hasError) {
    return (
      <div className={className}>
        {errorSlot ?? (
          <ErrorState message={error ?? undefined} onRetry={onRetry} />
        )}
      </div>
    );
  }

  if (loading) {
    return <div className={className}>{loadingSlot ?? <LoadingBlock />}</div>;
  }

  if (rows.length === 0) {
    return (
      <div className={className}>
        {emptySlot ?? <EmptyState title="暂无数据" />}
      </div>
    );
  }

  return (
    <div className={className}>
      <Table className={tableClassName}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow>
            {columns.map((column) => (
              <TableHead
                key={column.key}
                scope="col"
                className={cn(
                  column.align ? ALIGN_CLASS[column.align] : undefined,
                  column.className,
                )}
                style={
                  column.width !== undefined
                    ? { width: column.width }
                    : undefined
                }
              >
                {column.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={getRowKey(row)}>
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(
                    column.align ? ALIGN_CLASS[column.align] : undefined,
                    column.className,
                  )}
                >
                  {column.render
                    ? column.render(row)
                    : formatCellValue(
                        (row as Record<string, unknown>)[column.key],
                      )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {paginationSlot}
    </div>
  );
}
