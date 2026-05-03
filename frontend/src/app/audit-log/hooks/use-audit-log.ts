'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';

export interface AuditEntry {
  id: string;
  action: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  reason: string;
  timestamp: string;
  flag_key?: string;
  enabled_before?: boolean;
  enabled_after?: boolean;
}

interface AuditLogFilters {
  action?: string;
  actor_id?: string;
  resource_type?: string;
  since?: string;
  until?: string;
}

export function useAuditLog(filters: AuditLogFilters = {}) {
  return useQuery({
    queryKey: queryKeys.auditLog.list(filters as Record<string, unknown>),
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== '' && value !== null) {
          params.set(key, String(value));
        }
      });
      const query = params.toString();
      const { data } = await apiClient.get<{ items: AuditEntry[]; total: number }>(
        `/admin/audit-log${query ? `?${query}` : ''}`,
      );
      return data;
    },
  });
}
