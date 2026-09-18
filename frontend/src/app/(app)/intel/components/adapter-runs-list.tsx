"use client";

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

export function AdapterRunsList() {
  const { data, isLoading, error } = useIntelAdapterRuns();

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "secondary" | "destructive"> = {
      success: "default",
      completed: "default",
      running: "secondary",
      failed: "destructive",
    };
    const labels: Record<string, string> = {
      success: "已完成",
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
        ) : data && data.length > 0 ? (
          <>
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="text-right">处理条数</TableHead>
                    <TableHead className="text-right">插入条数</TableHead>
                    <TableHead>开始时间</TableHead>
                    <TableHead>完成时间</TableHead>
                    <TableHead>错误信息</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.id}</TableCell>
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
                        {run.finished_at
                          ? new Date(run.finished_at).toLocaleString("zh-CN")
                          : "-"}
                      </TableCell>
                      <TableCell className="max-w-xs truncate">
                        {run.error_message || "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="text-sm text-muted-foreground mt-2">
              共 {data.length} 条记录
            </p>
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
