"use client";

import { useState } from "react";
import { useIntelAdapterRuns } from "../hooks/use-intel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

const PAGE_SIZE = 20;

export function AdapterRunsList() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useIntelAdapterRuns(page, PAGE_SIZE);

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      completed: "default",
      running: "secondary",
      failed: "destructive",
    };
    const labels: Record<string, string> = {
      completed: "已完成",
      running: "运行中",
      failed: "失败",
    };
    return (
      <Badge variant={variants[status] || "secondary"}>
        {labels[status] || status}
      </Badge>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>采集任务记录</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-8 text-muted-foreground">
            加载失败，请稍后重试
          </div>
        ) : data && data.items.length > 0 ? (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>渠道</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">处理条数</TableHead>
                    <TableHead className="text-right">插入条数</TableHead>
                    <TableHead>开始时间</TableHead>
                    <TableHead>完成时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.id}</TableCell>
                      <TableCell className="font-medium">{run.channel}</TableCell>
                      <TableCell>{getStatusBadge(run.status)}</TableCell>
                      <TableCell className="text-right">
                        {run.items_processed.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {run.items_inserted.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {new Date(run.started_at).toLocaleString("zh-CN")}
                      </TableCell>
                      <TableCell>
                        {run.completed_at
                          ? new Date(run.completed_at).toLocaleString("zh-CN")
                          : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-4">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p - 1)}
                  disabled={page === 1}
                >
                  上一页
                </Button>
                <span className="text-sm text-muted-foreground">
                  第 {page} 页 / 共 {totalPages} 页（共 {data.total} 条）
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPage((p) => p + 1)}
                  disabled={page === totalPages}
                >
                  下一页
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            暂无采集任务记录
          </div>
        )}
      </CardContent>
    </Card>
  );
}
