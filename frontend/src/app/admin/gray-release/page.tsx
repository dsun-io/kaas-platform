'use client';

import { useFeatureFlags } from './hooks/use-feature-flags';
import { useDeploymentAudit } from './hooks/use-deployment-audit';
import { FlagToggle } from './components/flag-toggle';
import { AuditTimeline } from './components/audit-timeline';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { usePageView } from '@/lib/events/use-page-view';
import { RouteGuard } from '@/components/route-guard';

const TENANTS = [
  { tenant_id: 'liankai', display_name: '联凯五金' },
  { tenant_id: 'client-b', display_name: '备选客户 B' },
];

export default function GrayReleasePage() {
  usePageView({ resource_id: '/admin/gray-release' });

  const { data: flags, isLoading: flagsLoading } = useFeatureFlags();
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: audits, isLoading: auditsLoading } = useDeploymentAudit(since7d);

  return (
    <RouteGuard adminOnly>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">灰度发布</h1>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>灰度开关</CardTitle>
          </CardHeader>
          <CardContent>
            {flagsLoading ? (
              <p className="text-sm text-muted-foreground">加载中...</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {TENANTS.map((t) => (
                  <FlagToggle
                    key={t.tenant_id}
                    tenantId={t.tenant_id}
                    tenantName={t.display_name}
                    flagKey="use_v2"
                    enabled={flags?.['use_v2'] ?? false}
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
