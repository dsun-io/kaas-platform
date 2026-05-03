'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import type { Capability } from '@contracts/capabilities';

interface SyncJob {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  created_at: string;
  completed_at: string | null;
}

export function useCapabilities(customerId: string) {
  return useQuery({
    queryKey: ['customers', customerId, 'capabilities'] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<(Capability & { id: string; updated_at: string })[]>(
        `/customer/${customerId}/capabilities`,
      );
      return data;
    },
    enabled: !!customerId,
  });
}

export function useUpdateCapability(customerId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      spec_constraints?: Record<string, unknown>;
      is_active?: boolean;
    }) => {
      const { data } = await apiClient.patch<{
        capability: Capability & { id: string };
        sync_job_id: string;
      }>(`/customer/${customerId}/capabilities`, input);
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['customers', customerId, 'capabilities'] });
      // Return sync_job_id for polling
      return data.sync_job_id;
    },
  });
}

export function useSyncJob(jobId: string | null) {
  return useQuery({
    queryKey: ['sync_jobs', jobId] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<SyncJob>(`/sync_jobs/${jobId}`);
      return data;
    },
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'done' || status === 'failed' ? false : 1000;
    },
  });
}
