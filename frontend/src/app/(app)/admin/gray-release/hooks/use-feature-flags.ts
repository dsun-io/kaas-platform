"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export function useFeatureFlags() {
  return useQuery({
    queryKey: ["admin", "featureFlags"] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<
        Record<string, Record<string, boolean>>
      >("/admin/feature_flag");
      return data;
    },
  });
}

export function useToggleFeatureFlag() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      tenant_id: string;
      flag_key: string;
      enabled: boolean;
      reason: string;
      actor_id: string;
    }) => {
      const { data } = await apiClient.post<{
        tenant_id: string;
        flag_name: string;
        old_value: boolean | null;
        new_value: boolean;
      }>("/admin/feature_flag", input);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "featureFlags"] });
    },
  });
}
