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
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingBlock } from "@/components/shared/loading-block";
import { normalizeApiError } from "@/lib/api/api-error";

export function AdapterRunsList() {
  const { data, isLoading, error, refetch } = useIntelAdapterRuns();

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
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorState
            title="采集任务读取失败"
            message={normalizeApiError(error).message}
            onRetry={() => void refetch()}
          />
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
          <EmptyState
            title="暂无采集任务记录"
            description="还没有跑过数据采集任务；触发采集后这里会记录每次运行结果。"
            className="border-0 py-8"
          />
        )}
      </CardContent>
    </Card>
  );
}
