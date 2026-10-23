"use client";

import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * 事件归档记录卡片（C30）
 *
 * 放在灰度/运维页：归档是**定时任务**的产物（每月把上月事件写 R2 并记账），
 * 与灰度开关/发布审计同属「平台运维」视角；业务工位不需要看它。
 *
 * 三态必须分开（与同页 `AuditTimeline` 同一纪律）：
 *  加载中 / 接口失败 / **真的没有记录**。
 * 空态文案要解释"为什么现在是空的"：归档是**每月自动**跑的，新库头一个月必然为空 ——
 * 直接留白会被读成"功能坏了"。
 */
import { useState } from "react";
import { Archive, AlertCircle, RotateCw } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { PaginationBar } from "@/components/shared/pagination-bar";
import { StatusBadge } from "@/components/shared/status-badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import {
  ARCHIVE_LOGS_PAGE_SIZE,
  useArchiveLogs,
} from "../../hooks/use-archive-logs";

/** 归档文件位置默认折叠：路径是内部存储位置，日常查看不需要看到（设计稿 §1/§7）。 */
function ArchivePathCell({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TableCell className="max-w-[28rem] p-2 text-xs">
      <button
        type="button"
        className="text-muted-foreground underline decoration-dotted underline-offset-2"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        查看详情（一般不需要看）
      </button>
      {open && (
        <span className="mt-1 block break-all font-mono text-[11px] text-muted-foreground">
          {path}
        </span>
      )}
    </TableCell>
  );
}

function formatArchivedAt(value: string | null): string {
  if (!value) return "—";
  // 后端给 ISO（带时区）。无法解析时原样显示，不吞掉数据
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function ArchiveLogsCard() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching, refetch } = useArchiveLogs({
    page,
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Archive className="size-4" />
          事件归档记录
          {data && (
            <span className="text-sm font-normal text-muted-foreground">
              共 {total} 条
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="归档记录加载中"
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : isError ? (
          <div className="flex items-center gap-2 py-6 text-sm text-destructive">
            <AlertCircle className="size-4" />
            读取归档记录失败。
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => void refetch()}
            >
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={RotateCw}
            title="暂无归档记录"
            description="每月自动归档上月事件；首次归档跑完之前这里是空的。"
            className="border-0 py-8"
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow className="border-b text-left text-muted-foreground">
                    <TableHead scope="col" className="p-2">
                      归档月份
                    </TableHead>
                    <TableHead scope="col" className="p-2">
                      归档文件
                    </TableHead>
                    <TableHead scope="col" className="p-2">
                      状态
                    </TableHead>
                    <TableHead scope="col" className="p-2">
                      归档时间
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <TableRow
                      key={entry.id}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <TableCell className="whitespace-nowrap p-2 font-medium">
                        {entry.month}
                      </TableCell>
                      <ArchivePathCell path={entry.path} />
                      <TableCell className="p-2">
                        <StatusBadge
                          tone={
                            entry.status === "archived" ? "success" : "warning"
                          }
                        >
                          {entry.status}
                        </StatusBadge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap p-2 text-xs text-muted-foreground">
                        {formatArchivedAt(entry.archived_at)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PaginationBar
              page={page}
              pageSize={ARCHIVE_LOGS_PAGE_SIZE}
              total={total}
              currentCount={items.length}
              loading={isFetching}
              onPageChange={setPage}
              ariaLabel="事件归档记录分页"
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
