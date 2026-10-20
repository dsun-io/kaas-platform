"use client";

import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

interface AuditEntry {
  id: string;
  action: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  flag_key: string;
  enabled_before: boolean;
  enabled_after: boolean;
  reason: string;
  timestamp: string;
}

/**
 * 发布审计（灰度开关变更历史）。
 *
 * ⚠️ **`GET /admin/deployment_audit` 在生产不存在**：worker 全仓没有这条路由，
 * 生产 404 属**设计**（`docs/PROBLEM_STATUS_2026-10-11.md` 的 route-parity allowlist）。
 * 所以这里失败是**预期状态**，不是可恢复故障：
 *   · `retry: false` —— 重试 3 次只会让页面晚 3 个往返才显示"不可用"；
 *   · `silent: true`   —— 错误由页面渲染成「接口不可用」，不弹全局 toast
 *     （否则每次进灰度页都弹一条"请求失败"，用户以为系统坏了）。
 *
 * 页面必须把 `isError` 与"暂无记录"区分开：空时间线会被读成"近 7 天没有变更"，
 * 那是假结论（见 `admin/gray-release/page.tsx` 与 `components/audit-timeline.tsx`）。
 */
export function useDeploymentAudit(since: string) {
  return useQuery({
    queryKey: ["admin", "deploymentAudit", since] as const,
    retry: false,
    queryFn: async () => {
      const { data } = await apiClient.get<{
        items: AuditEntry[];
        total: number;
      }>(`/admin/deployment_audit?since=${since}&limit=200`, {
        silent: true,
      });
      return data.items;
    },
  });
}
