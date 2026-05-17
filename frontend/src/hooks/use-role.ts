"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface UserInfo {
  user_id: string;
  email: string;
  account_type: string;
  role: string | null;
  is_tenant_admin: boolean;
  tenant_id: string | null;
}

export function useRole() {
  const { data: user } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const { data } = await apiClient.get<UserInfo>("/auth/me");
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const isTenantAdmin =
    user?.is_tenant_admin === true || user?.account_type === "internal";
  const isPlatformOps =
    user?.account_type === "internal" &&
    (user?.role === "system_admin" || user?.role === "admin");

  return {
    user,
    isTenantAdmin,
    isPlatformOps,
    isViewer: !!user, // any authenticated user is at least a viewer
  };
}
