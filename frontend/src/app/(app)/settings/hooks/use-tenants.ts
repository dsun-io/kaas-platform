"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface Tenant {
  tenant_id: string;
  // 2026-10-19 S4：与渲染侧 components/types.ts 统一为 display_name
  // （此前这里叫 name，contracts R5.1 曾作为已登记偏差挂着）
  display_name: string;
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

export function useReloadTenants(options?: {
  /** 失败回调（页内错误态用；apiClient 拦截器已 toast，这里不重复弹） */
  onError?: (error: unknown) => void;
}) {
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
    onError: (error) => {
      options?.onError?.(error);
    },
  });
}
