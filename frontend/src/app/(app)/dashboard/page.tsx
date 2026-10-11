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

  /**
   * 数据集命中：**形状不认识就别当成 0，也别崩**。
   *
   * `useSafeQuery` 对**不合 schema** 的响应是 **fail-open**
   * （`lib/query/safe-query.ts:16-22` 只 `console.warn` 然后 `return raw`），
   * 所以 `summary` 完全可能是 `{}` —— **truthy 但字段全缺**。
   * 此时旧写法 `Object.keys(summary.dataset_hits)` 会抛
   * `TypeError: Cannot convert undefined to object` ⇒ **整页进错误边界**。
   *
   * 2026-10-11 实测（`E2E_FALLBACK=1`：兜底路由对 `/dashboard/summary` 回 `200 {}`）：
   * 渲染快照 = 「仪表盘加载异常 / 后端繁忙，请稍后重试」，`h1` 为空、
   * `.grid > *` 找不到 ⇒ `dashboard:4` **0/3**；修后同条件 **3/3**。
   *
   * 缺字段时显示 `—`（=「不知道」），**不是 `0 个数据集`**（=「确定没有」）——
   * 与 `frontend/src/mocks/handlers.ts` 里那条 fail-open 教训同一个方向：
   * 把"我不知道"改写成"我确定没有"，比直接失败更糟。
   */
  const datasetHits = summary?.dataset_hits;

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
            datasetHits ? `${Object.keys(datasetHits).length} 个数据集` : "—"
          }
          hint={
            datasetHits
              ? Object.entries(datasetHits)
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
