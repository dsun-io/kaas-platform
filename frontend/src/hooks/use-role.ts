"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface UserInfo {
  user_id: string;
  email: string;
  account_type: string;
  role: string | null;
  effective_role: string | null;
  is_tenant_admin: boolean;
  tenant_id: string | null;
}

/** 前端角色常量 — 与后端三层角色体系对齐 (Wave 2 · T6) */
export const ROLES = {
  SYSTEM_ADMIN: "system_admin" as const,
  CUSTOMER_OWNER: "customer_owner" as const,
  CUSTOMER_MEMBER: "customer_member" as const,
};

export function useRole() {
  const { data: user } = useQuery({
    queryKey: ["auth", "me"],
    queryFn: async () => {
      const { data } = await apiClient.get<UserInfo>("/auth/me");
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

  const effectiveRole = user?.effective_role || user?.role || null;

  // 三层角色判断 (新体系)
  const isSystemAdmin = effectiveRole === ROLES.SYSTEM_ADMIN;
  const isCustomerOwner = effectiveRole === ROLES.CUSTOMER_OWNER;
  const isCustomerMember = effectiveRole === ROLES.CUSTOMER_MEMBER;

  // 向后兼容 (旧体系，过渡期)
  const isTenantAdmin =
    user?.is_tenant_admin === true || user?.account_type === "internal";
  const isPlatformOps =
    user?.account_type === "internal" &&
    (user?.role === "system_admin" || user?.role === "admin");

  return {
    user,
    effectiveRole,
    isSystemAdmin,
    isCustomerOwner,
    isCustomerMember,
    // 兼容层 (过渡期使用)
    isTenantAdmin,
    isPlatformOps,
    isViewer: !!user,
  };
}
