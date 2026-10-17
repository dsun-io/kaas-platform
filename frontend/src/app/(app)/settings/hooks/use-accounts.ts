"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/**
 * 平台账号治理 hook —— 数据源 `GET/PATCH /api/v1/admin/accounts`（两端同契约）。
 * 类型是**白名单**：绝不声明 password_hash / token 等敏感字段
 * （契约见 docs/ACCOUNT_GOVERNANCE_HANDOVER_2026-10-12.md §②）。
 */

export type AccountStatus = "active" | "disabled";

export interface AdminAccount {
  id: number;
  email: string;
  display_name: string | null;
  account_type: string;
  role: string;
  status: AccountStatus;
  team_id: number | null;
  team_name: string | null;
  console_access: boolean;
  created_at: string | null;
  updated_at: string | null;
}

interface AccountListResponse {
  accounts: AdminAccount[];
  total: number;
}

export function useAccounts(limit = 500, offset = 0) {
  return useQuery({
    queryKey: ["admin", "accounts", limit, offset] as const,
    queryFn: async () => {
      const { data } = await apiClient.get<AccountListResponse>(
        "/admin/accounts",
        { params: { limit, offset } },
      );
      return data;
    },
  });
}

export function useUpdateAccountStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      userId,
      status,
    }: {
      userId: number;
      status: AccountStatus;
    }) => {
      const { data } = await apiClient.patch<{ account: AdminAccount }>(
        `/admin/accounts/${userId}`,
        { status },
      );
      return data.account;
    },
    onSuccess: () => {
      // 列表页可能分页，直接全量失效最省事（管理员量级小）
      queryClient.invalidateQueries({ queryKey: ["admin", "accounts"] });
    },
  });
}
