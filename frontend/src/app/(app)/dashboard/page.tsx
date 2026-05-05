"use client";

import { useState } from "react";
import { useDashboard } from "./hooks/use-dashboard";
import { StatCard } from "./components/stat-card";
import { RangeSelector } from "./components/range-selector";
import { usePageView } from "@/lib/events/use-page-view";
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
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold md:text-2xl">仪表盘</h1>
        <RangeSelector value={range} onChange={setRange} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="今日报价数"
          icon={FileText}
          total={summary?.quotations_total ?? "—"}
          sampledCount={summary?.quotations_sampled}
          samplingRate={
            summary
              ? summary.quotations_sampled / summary.quotations_total
              : undefined
          }
        />
        <StatCard
          title="活跃客户"
          icon={Users}
          total={summary?.active_customers ?? "—"}
          sampledCount={summary?.customers_sampled}
          samplingRate={
            summary
              ? summary.customers_sampled / summary.active_customers
              : undefined
          }
        />
        <StatCard
          title="Token 消耗"
          icon={Cpu}
          total={summary?.token_total ?? "—"}
          sampledCount={summary?.token_sampled}
          samplingRate={
            summary ? summary.token_sampled / summary.token_total : undefined
          }
        />
        <StatCard
          title="P95 延迟"
          icon={Clock}
          total={summary?.p95_latency_ms ?? "—"}
          unit="ms"
          hint={summary ? `采样 ${summary.latency_sampled} 次请求` : undefined}
        />
        <StatCard
          title="数据集命中率"
          icon={Database}
          total={
            summary
              ? `${Object.keys(summary.dataset_hits).length} 个数据集`
              : "—"
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
          title="采样覆盖率"
          icon={TrendingUp}
          total={
            isLoading
              ? "—"
              : summary
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
