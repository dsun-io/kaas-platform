"use client";

import { useMemo } from "react";
import { useFeatureFlags } from "./hooks/use-feature-flags";
import { useDeploymentAudit } from "./hooks/use-deployment-audit";
import { useTenants } from "../../settings/hooks/use-tenants";
import { FlagToggle } from "./components/flag-toggle";
import { AuditTimeline } from "./components/audit-timeline";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { usePageView } from "@/lib/events/use-page-view";
import { RouteGuard } from "@/components/route-guard";

export default function GrayReleasePage() {
  usePageView({ resource_id: "/admin/gray-release" });

  const { data: tenants, isLoading: tenantsLoading } = useTenants();
  const { data: flags, isLoading: flagsLoading } = useFeatureFlags();
  const since7d = useMemo(
    () => new Date(Date.now() - 7 * 86400000).toISOString(),
    [],
  );
  const { data: audits, isLoading: auditsLoading } =
    useDeploymentAudit(since7d);

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">灰度发布</h1>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>灰度开关</CardTitle>
          </CardHeader>
          <CardContent>
            {tenantsLoading || flagsLoading ? (
              <p className="text-sm text-muted-foreground">加载中...</p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {(tenants ?? []).map((t) => (
                  <FlagToggle
                    key={t.tenant_id}
                    tenantId={t.tenant_id}
                    tenantName={t.name}
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
            <AuditTimeline entries={audits ?? []} loading={auditsLoading} />
          </CardContent>
        </Card>
      </div>
    </RouteGuard>
  );
}
