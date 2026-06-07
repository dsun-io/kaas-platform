"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Receipt, CheckCircle, XCircle, AlertTriangle } from "lucide-react";

interface TodoItem {
  id: number;
  invoice_request_id: number;
  status: string;
  priority: number;
  customer_name?: string;
  amount?: string;
  extraction_confidence?: number;
  ai_issues?: Record<string, string>[];
  assigned_at: string;
  timeout_at?: string;
}

export default function InvoiceWorkstationPage() {
  const [loading, setLoading] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([
    // 占位数据，实际对接 API
    {
      id: 1,
      invoice_request_id: 101,
      status: "pending",
      priority: 2,
      customer_name: "示例客户 A",
      amount: "¥12,800.00",
      extraction_confidence: 0.95,
      ai_issues: [],
      assigned_at: "2026-05-23T09:00:00Z",
      timeout_at: "2026-05-23T09:30:00Z",
    },
    {
      id: 2,
      invoice_request_id: 102,
      status: "pending",
      priority: 1,
      customer_name: "示例客户 B",
      amount: "¥3,500.00",
      extraction_confidence: 0.72,
      ai_issues: [{ field: "tax_id", msg: "税号格式疑似错误" }],
      assigned_at: "2026-05-23T09:05:00Z",
      timeout_at: "2026-05-23T09:35:00Z",
    },
  ]);

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary">待处理</Badge>;
      case "assigned":
        return <Badge variant="default">处理中</Badge>;
      case "completed":
        return <Badge variant="outline">已完成</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getConfidenceColor = (conf?: number) => {
    if (conf === undefined) return "text-muted-foreground";
    if (conf >= 0.9) return "text-green-600";
    if (conf >= 0.7) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Receipt className="size-6" />
            智能开票工位
          </h1>
          <p className="text-muted-foreground mt-1">
            处理企业微信开票请求，确认抬头与参数
          </p>
        </div>
        <Button onClick={() => setLoading(!loading)}>刷新待办</Button>
      </div>

      <div className="grid gap-4">
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : todos.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <CheckCircle className="size-12 mx-auto mb-4 opacity-50" />
              <p>当前无待处理开票请求</p>
            </CardContent>
          </Card>
        ) : (
          todos.map((todo) => (
            <Card key={todo.id} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold">
                        #{todo.invoice_request_id}
                      </span>
                      {getStatusBadge(todo.status)}
                      {todo.priority >= 2 && (
                        <Badge variant="destructive">高优先级</Badge>
                      )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      客户：{todo.customer_name || "未知"}
                    </p>
                    <p className="text-sm font-medium mt-1">
                      金额：{todo.amount || "—"}
                    </p>
                    {todo.ai_issues && todo.ai_issues.length > 0 && (
                      <div className="flex items-center gap-1 mt-2 text-yellow-600 text-sm">
                        <AlertTriangle className="size-4" />
                        <span>AI 风险提示：{todo.ai_issues.length} 项</span>
                      </div>
                    )}
                  </div>
                  <div className="text-right space-y-2">
                    <div
                      className={`text-sm font-medium ${getConfidenceColor(todo.extraction_confidence)}`}
                    >
                      置信度：
                      {todo.extraction_confidence !== undefined
                        ? `${(todo.extraction_confidence * 100).toFixed(1)}%`
                        : "—"}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline">
                        <XCircle className="size-4 mr-1" />
                        拒绝
                      </Button>
                      <Button size="sm">
                        <CheckCircle className="size-4 mr-1" />
                        确认开票
                      </Button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
