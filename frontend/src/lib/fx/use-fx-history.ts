"use client";

/**
 * 汇率历史（C36 下期 #5）：`GET /api/v1/fx-rates`。
 *
 * 契约（`backend/worker/src/ws_extras.py:162` `list_fx_rates`）：
 * - 返回**裸数组**（不是 `{items}`），按 `rate_date DESC`；
 * - 查询参数 `base_currency` / `quote_currency` / `limit`（1..365，默认 30，越界被后端 clamp）；
 * - 行形状与 `/fx-rates/latest` 同形：`{base_currency,quote_currency,rate,rate_date,source,is_stale}`。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type { FxRateHistoryRow } from "./use-latest-fx";

export const FX_HISTORY_MAX = 365;

export function useFxHistory({
  base = "USD",
  quote = "CNY",
  limit = 30,
}: {
  base?: string;
  quote?: string;
  limit?: number;
}) {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), FX_HISTORY_MAX);
  return useQuery({
    queryKey: ["fx", "history", base, quote, safeLimit],
    queryFn: async () => {
      const { data } = await apiClient.get<FxRateHistoryRow[]>("/fx-rates", {
        params: {
          base_currency: base,
          quote_currency: quote,
          limit: safeLimit,
        },
        silent: true,
      });
      return data;
    },
    staleTime: 60 * 1000,
  });
}
