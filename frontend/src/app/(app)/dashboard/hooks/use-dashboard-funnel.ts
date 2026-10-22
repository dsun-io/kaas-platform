"use client";

/**
 * 商机漏斗数据层（M3，设计 §7）。
 *
 * 契约：`GET /api/v1/dashboard/funnel?range=today|7d|30d|90d`
 * → `{range, since, funnel, channels, direct_orders, deprecated_summary}`
 * （形状见 `lib/schemas/responses.ts: DashboardFunnelResponseSchema`；
 *  内核实现在 `backend/worker/src/main.py:dashboard_funnel`）。
 *
 * 用 `useSafeQuery`（带 zod 校验）：后端形状漂移时不会静默渲染成「—」一片，
 * 而是 `console.warn` + 上报 Sentry（与全站查询同一套范式）。
 */
import apiClient from "@/lib/api/client";
import { normalizeDashboardRange } from "@/lib/dashboard/funnel";
import { queryKeys } from "@/lib/query/keys";
import { useSafeQuery } from "@/lib/query/safe-query";
import {
  DashboardFunnelResponseSchema,
  type DashboardFunnelResponse,
} from "@/lib/schemas/responses";

export function useDashboardFunnel(range: string) {
  // 请求参数只发内核认识的四个值；页面 state 是 string，脏值不会打到后端
  const safeRange = normalizeDashboardRange(range);

  return useSafeQuery({
    queryKey: queryKeys.dashboard.funnel(safeRange),
    queryFn: async () => {
      const { data } = await apiClient.get<DashboardFunnelResponse>(
        "/dashboard/funnel",
        { params: { range: safeRange } },
      );
      return data;
    },
    staleTime: 60_000,
    // 切时间范围时保留上一份结果，卡片不闪成骨架屏（v5 的 keepPreviousData 等价写法）
    placeholderData: (previous) => previous,
    schema: DashboardFunnelResponseSchema,
  });
}
