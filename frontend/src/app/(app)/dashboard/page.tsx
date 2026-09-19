"use client";

import { useState } from "react";
import { useDashboard } from "./hooks/use-dashboard";
import { RangeSelector } from "./components/range-selector";
import { usePageView } from "@/lib/events/use-page-view";
import { PageHeader, StatCard } from "@/components/shared";
import {
  FileText,
  Users,
  Database,
  Cpu,
  Clock,
  TrendingUp,
} from "lucide-react";

export default function DashboardPage() {
  usePageView({ resource_id: "/dashboard" });
  const [range, setRange] = useState("today");
  const { data, isLoading } = useDashboard(range);

  const summary = data;

  return (
    <div className="space-y-8">
      <PageHeader
        title="仪表盘"
        description="实时业务指标与系统运行概览"
        actions={<RangeSelector value={range} onChange={setRange} />}
      />

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="今日报价数"
          icon={FileText}
          value={summary?.quotations_total ?? "—"}
          variant="gradient"
          hint={
            summary
              ? `采样 ${summary.quotations_sampled}/${summary.quotations_total}`
              : undefined
          }
        />
        <StatCard
          label="活跃客户"
          icon={Users}
          value={summary?.active_customers ?? "—"}
          hint={
            summary
              ? `采样 ${summary.customers_sampled}/${summary.active_customers}`
              : undefined
          }
        />
        <StatCard
          label="Token 消耗"
          icon={Cpu}
          value={summary?.token_total ?? "—"}
          hint={
            summary ? `采样 ${summary.token_sampled}/${summary.token_total}` : undefined
          }
        />
        <StatCard
          label="P95 延迟"
          icon={Clock}
          value={summary ? `${summary.p95_latency_ms} ms` : "—"}
          hint={summary ? `采样 ${summary.latency_sampled} 次请求` : undefined}
        />
        <StatCard
          label="数据集命中率"
          icon={Database}
          value={
            summary ? `${Object.keys(summary.dataset_hits).length} 个数据集` : "—"
          }
          hint={
            summary
              ? Object.entries(summary.dataset_hits)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")
              : undefined
          }
        />
        <StatCard
          label="采样覆盖率"
          icon={TrendingUp}
          value={
            isLoading
              ? "—"
              : summary && summary.quotations_total > 0
                ? `${(
                    (summary.quotations_sampled / summary.quotations_total) *
                    100
                  ).toFixed(1)}%`
                : "—"
          }
        />
      </div>

      {isLoading && (
        <p className="text-center text-sm text-muted-foreground">加载中...</p>
      )}
    </div>
  );
}
