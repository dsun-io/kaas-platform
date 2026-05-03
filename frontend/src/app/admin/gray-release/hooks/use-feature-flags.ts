'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';

export function useFeatureFlags() {
  return useQuery({
    queryKey: ['admin', 'featureFlags'] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<Record<string, boolean>>('/admin/feature_flag');
      return data;
    },
  });
}

export function useToggleFeatureFlag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { flag_key: string; enabled: boolean; reason: string; actor_id: string }) => {
      const { data } = await apiClient.post<{ flag_key: string; before: boolean; after: boolean }>(
        '/admin/feature_flag',
        input,
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'featureFlags'] });
      queryClient.invalidateQueries({ queryKey: ['admin', 'tenants'] });
      queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}
