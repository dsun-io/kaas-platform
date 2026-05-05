"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { BookOpen, FileText, Layers, Clock } from "lucide-react";
import { RouteGuard } from "@/components/route-guard";

const STATS = [
  { label: "知识条目", value: 48, icon: FileText },
  { label: "产品品类", value: 6, icon: Layers },
  { label: "最近更新", value: "2 小时前", icon: Clock },
  { label: "数据源", value: "L1 / L2 / L3", icon: BookOpen },
];

export default function KbPage() {
  usePageView({ resource_id: "/kb" });

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">知识库管理</h1>
          <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
            建设中
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s) => (
            <Card key={s.label}>
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
                支持 L1/L2/L3 层级知识编辑、规格参数管理、公式配置
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </RouteGuard>
  );
}
