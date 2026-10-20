"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { BookOpen, FileText, Layers, Clock } from "lucide-react";
import { RouteGuard } from "@/components/route-guard";
import { PageHeader, StatusBadge } from "@/components/shared";

const STATS = [
  { label: "知识条目", value: 48, icon: FileText },
  { label: "产品品类", value: 6, icon: Layers },
  { label: "最近更新", value: "2 小时前", icon: Clock },
  { label: "数据源", value: "工位能力网", icon: BookOpen },
];

export default function KbPage() {
  usePageView({ resource_id: "/kb" });

  return (
    <RouteGuard internalOnly>
      <div className="space-y-6">
        <PageHeader
          title="知识库管理"
          description="产品知识与工位能力资料"
          actions={<StatusBadge tone="warning">建设中</StatusBadge>}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s) => (
            <Card key={s.label} data-testid="stat-card">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {s.label}
                </CardTitle>
                <s.icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle>知识库内容</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="py-12 text-center text-muted-foreground space-y-2">
              <BookOpen className="size-12 mx-auto opacity-30" />
              <p className="text-sm">知识库管理功能即将上线</p>
              <p className="text-xs">
                支持工位能力网知识分层编辑、规格参数管理、公式配置
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </RouteGuard>
  );
}
