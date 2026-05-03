'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  flag_key: string;
  enabled_before: boolean;
  enabled_after: boolean;
  reason: string;
  timestamp: string;
}

export function useDeploymentAudit(since: string) {
  return useQuery({
    queryKey: ['admin', 'deploymentAudit', since] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<{ items: AuditEntry[]; total: number }>(
        `/admin/deployment_audit?since=${since}&limit=200`,
      );
      return data.items;
    },
  });
}
