import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

/** 后端 `/fx-rates/latest` 的返回形状（与 worker ws_extras 对齐）。 */
export interface LatestFxRate {
  base_currency: string;
  quote_currency: string;
  rate: number;
  rate_date: string;
  source: string | null;
  is_stale: boolean;
}

/** `/fx-rates`（历史列表）的行形状 —— 与 latest 同形，后端返回**裸数组**。 */
export type FxRateHistoryRow = LatestFxRate;

/**
 * 最新汇率（带服务端缓存）。
 *
 * 后端策略（2026-10-17）：数据超过 6 小时就向公开源刷新一次并入库；
 * 外部源不可用时降级到缓存并标 `is_stale=true`。前端只负责「自动带入 + 允许手改」，
 * 不在浏览器里直接调外部汇率 API（避免 key/跨域/合规问题）。
 */
export function useLatestFxRate(base = "USD", quote = "CNY") {
  return useQuery({
    queryKey: ["fx", "latest", base, quote],
    queryFn: async () => {
      const { data } = await apiClient.get<LatestFxRate>(
        `/fx-rates/latest?base_currency=${encodeURIComponent(base)}&quote_currency=${encodeURIComponent(quote)}`,
        { silent: true },
      );
      return data;
    },
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });
}
