"use client";

import { usePageView } from "@/lib/events/use-page-view";
import { BookOpen, FileText, Layers, Clock } from "lucide-react";
import { RouteGuard } from "@/components/route-guard";
import {
  PageHeader,
  StatusBadge,
  SectionCard,
  EmptyState,
} from "@/components/shared";

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

        <SectionCard title="概览">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {STATS.map((s) => (
              <div
                key={s.label}
                className="rounded-lg border border-border/70 bg-muted/20 p-4"
              >
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>{s.label}</span>
                  <s.icon className="size-4" />
                </div>
                <p className="mt-2 text-2xl font-semibold">{s.value}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="知识库内容">
          <EmptyState
            icon={BookOpen}
            title="知识库管理功能即将上线"
            description="支持工位能力网知识分层编辑、规格参数管理、公式配置。"
          />
        </SectionCard>
      </div>
    </RouteGuard>
  );
}
