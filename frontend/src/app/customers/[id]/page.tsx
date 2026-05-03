'use client';

import { useParams } from 'next/navigation';
import { useCapabilities } from '../hooks/use-capabilities';
import { CapabilityForm } from '../components/capability-form';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { usePageView } from '@/lib/events/use-page-view';

export default function CustomerDetailPage() {
  usePageView({ resource_id: '/customers/:id' });
  const params = useParams();
  const customerId = params.id as string;
  const { data: capabilities, isLoading } = useCapabilities(customerId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">客户详情</h1>
        <p className="text-sm text-muted-foreground font-mono">{customerId}</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>产品能力配置</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <div className="space-y-3">
              {(capabilities ?? []).map((cap) => (
                <CapabilityForm
                  key={cap.id}
                  customerId={customerId}
                  capability={cap}
                  onSaved={() => {}}
                />
              ))}
              {(capabilities ?? []).length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无能力配置
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
