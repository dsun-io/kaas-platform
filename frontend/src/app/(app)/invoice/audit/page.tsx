"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { History, Hash, Server } from "lucide-react";

interface AuditItem {
  id: number;
  event_type: string;
  actor_id?: number;
  resource_type: string;
  resource_id: string;
  action: string;
  current_hash: string;
  minio_status: string;
  created_at: string;
}

export default function InvoiceAuditPage() {
  const [logs] = useState<AuditItem[]>([
    {
      id: 1,
      event_type: "invoice_request_created",
      actor_id: 3,
      resource_type: "invoice_request",
      resource_id: "101",
      action: "create",
      current_hash: "a1b2c3...",
      minio_status: "archived",
      created_at: "2026-05-23T09:00:00Z",
    },
    {
      id: 2,
      event_type: "invoice_request_confirmed",
      actor_id: 3,
      resource_type: "invoice_request",
      resource_id: "101",
      action: "confirm",
      current_hash: "d4e5f6...",
      minio_status: "archived",
      created_at: "2026-05-23T09:05:00Z",
    },
  ]);

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <History className="size-6" />
          开票审计日志
        </h1>
        <p className="text-muted-foreground mt-1">
          哈希链式审计日志，支持 MinIO 归档校验
        </p>
      </div>

      <div className="grid gap-4">
        {logs.map((log) => (
          <Card key={log.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline">{log.event_type}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {log.resource_type} #{log.resource_id}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
                    <span className="flex items-center gap-1">
                      <Hash className="size-3" />
                      {log.current_hash}
                    </span>
                    <span className="flex items-center gap-1">
                      <Server className="size-3" />
                      MinIO: {log.minio_status}
                    </span>
                  </div>
                </div>
                <div className="text-right text-sm text-muted-foreground">
                  <p>操作人：{log.actor_id}</p>
                  <p>{new Date(log.created_at).toLocaleString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
