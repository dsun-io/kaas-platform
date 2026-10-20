"use client";

/**
 * 手工录入汇率（C36 #14）：`POST /api/v1/fx-rates`。
 *
 * 契约（`backend/worker/src/ws_extras.py:217` `upsert_fx_rate`）：
 * - body `{base_currency="USD", quote_currency="CNY", rate>0, rate_date?, source="manual"}`；
 * - 同 (base, quote, date) **UPSERT**：覆盖当天该币种对的汇率并把 `is_stale` 置 false；
 * - `rate <= 0` ⇒ 422（扁平错误体 `{error:"invalid_rate"}`）。
 *
 * 为什么要这个入口：外部汇率源故障时 `/fx-rates/latest` 会降级为过期缓存
 * （`is_stale=true`），业务需要有地方**人工兜底**并留痕（source=manual）。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

export interface CreateFxRateInput {
  base_currency: string;
  quote_currency: string;
  rate: number;
  /** `YYYY-MM-DD`；空 = 后端取今天 */
  rate_date?: string | null;
  source?: string;
}

export interface FxRateRow {
  base_currency: string;
  quote_currency: string;
  rate: number;
  rate_date: string;
  source: string | null;
  is_stale: boolean;
}

export function useCreateFxRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFxRateInput) => {
      const { data } = await apiClient.post<FxRateRow>(
        "/fx-rates",
        {
          base_currency: input.base_currency.trim().toUpperCase() || "USD",
          quote_currency: input.quote_currency.trim().toUpperCase() || "CNY",
          rate: input.rate,
          rate_date: input.rate_date || null,
          source: input.source?.trim() || "manual",
        },
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      // 报价/导入页的「最新汇率」全部失效，避免手工录入后仍显示旧缓存
      qc.invalidateQueries({ queryKey: ["fx", "latest"] });
    },
  });
}
