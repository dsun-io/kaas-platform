"use client";

/**
 * 应收概览数据层（P0-A A3）。
 *
 * 契约：`GET /api/v1/dashboard/receivables?range=today|7d|30d|90d`
 * → `{range, since, by_currency, by_status, totals}`
 * （形状真源 = `backend/kaas_common/workstation/receivable_summary.py`，
 *  内核实现在 `backend/worker/src/main.py:dashboard_receivables`）。
 *
 * 为什么单独一条 query（而不是挂在 funnel 上）：
 *  · 应收与漏斗是两个数据源（receivables 表 vs 询盘 cohort），失败不应互相拖累；
 *  · 页面上两张卡各自 loading/error，用户能只重试坏掉的那一块。
 */
import apiClient from "@/lib/api/client";
import { normalizeDashboardRange } from "@/lib/dashboard/funnel";
import { queryKeys } from "@/lib/query/keys";
import { useSafeQuery } from "@/lib/query/safe-query";
import {
  DashboardReceivablesResponseSchema,
  type DashboardReceivablesResponse,
} from "@/lib/schemas/responses";

export function useDashboardReceivables(range: string) {
  // 请求参数只发内核认识的四个值（未知 range 后端落 today，与 normalize 一致）
  const safeRange = normalizeDashboardRange(range);

  return useSafeQuery({
    queryKey: queryKeys.dashboard.receivables(safeRange),
    queryFn: async () => {
      const { data } = await apiClient.get<DashboardReceivablesResponse>(
        "/dashboard/receivables",
        { params: { range: safeRange } },
      );
      return data;
    },
    staleTime: 60_000,
    // 切时间范围时保留上一份结果，卡片不闪成骨架屏
    placeholderData: (previous) => previous,
    schema: DashboardReceivablesResponseSchema,
  });
}
