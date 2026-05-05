"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Tenant {
  tenant_id: string;
  name: string;
  is_active: boolean;
}

interface TenantListResponse {
  tenants: Tenant[];
}

interface ReloadResult {
  reloaded_count: number;
  active_tenants: Array<{
    tenant_id: string;
    display_name: string;
    locale: string;
    region: string;
    is_active: boolean;
  }>;
}

export function useTenants() {
  return useQuery({
    queryKey: ["admin", "tenants"] as const,
    queryFn: async () => {
      const { data } =
        await apiClient.get<TenantListResponse>("/admin/tenants");
      return data.tenants;
    },
  });
}

export function useReloadTenants() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const { data } = await apiClient.post<ReloadResult>(
        "/admin/tenants/reload",
      );
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "tenants"] });
    },
  });
}
