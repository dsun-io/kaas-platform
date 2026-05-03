'use client';

import { apiClient } from '@/lib/api/client';
import { queryKeys } from '@/lib/query/keys';
import { useSafeQuery } from '@/lib/query/safe-query';
import { DashboardResponseSchema } from '@/lib/schemas/responses';
import type { DashboardResponse } from '@/lib/schemas/responses';

export function useDashboard(range: string) {
  return useSafeQuery({
    queryKey: queryKeys.dashboard.summary(range),
    queryFn: async () => {
      const { data } = await apiClient.get<DashboardResponse>(
        `/dashboard/summary?range=${range}`,
      );
      return data;
    },
    staleTime: 60_000,
    schema: DashboardResponseSchema,
  });
}
