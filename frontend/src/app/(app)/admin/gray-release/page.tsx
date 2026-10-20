"use client";

import { useMemo } from "react";
import { useFeatureFlags } from "./hooks/use-feature-flags";
import { useDeploymentAudit } from "./hooks/use-deployment-audit";
import { useTenants } from "../../settings/hooks/use-tenants";
import { FlagToggle } from "./components/flag-toggle";
import { AuditTimeline } from "./components/audit-timeline";
import { ArchiveLogsCard } from "./components/archive-logs-card";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";
import { PageHeader } from "@/components/shared";
import { Skeleton } from "@/components/ui/skeleton";

export default function GrayReleasePage() {
  usePageView({ resource_id: "/admin/gray-release" });

  const { data: tenants, isLoading: tenantsLoading } = useTenants();
  const { data: flags, isLoading: flagsLoading } = useFeatureFlags();
  const since7d = useMemo(
    () => new Date(Date.now() - 7 * 86400000).toISOString(),
    [],
  );
  const {
    data: audits,
    isLoading: auditsLoading,
    isError: auditsUnavailable,
  } = useDeploymentAudit(since7d);

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <PageHeader title="灰度发布" description="灰度开关与发布审计" />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>灰度开关</CardTitle>
          </CardHeader>
          <CardContent>
            {tenantsLoading || flagsLoading ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full rounded-lg" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(tenants ?? []).map((t) => (
                  <FlagToggle
                    key={t.tenant_id}
                    tenantId={t.tenant_id}
                    tenantName={t.display_name}
                    flagKey="use_v2"
                    enabled={flags?.[t.tenant_id]?.["use_v2"] ?? false}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>变更历史（近 7 天）</CardTitle>
          </CardHeader>
          <CardContent>
            {/* 三态必须分开：加载中 / 接口不可用 / 真的没有记录。
                `GET /admin/deployment_audit` 生产不存在（404 属设计），
                空时间线会被读成「近 7 天没有变更」—— 那是假结论。 */}
            <AuditTimeline
              entries={audits ?? []}
              loading={auditsLoading}
              unavailable={auditsUnavailable}
            />
          </CardContent>
        </Card>

        {/* C30：事件归档记录（每月把上月事件写 R2 并记账；数据在 events_archive_log） */}
        <ArchiveLogsCard />
      </div>
    </RouteGuard>
  );
}
