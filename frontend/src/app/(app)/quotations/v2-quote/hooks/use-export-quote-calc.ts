"use client";

/**
 * 产品报价的算价接线。
 *
 * 三条纪律（与后端引擎的口径一致）：
 *  1. 规格空间（有哪些属性、每个属性有哪些取值）**不写死在前端**，
 *     一律从 `/export-quote/products/{key}/formulas` 读 —— 产品改规格，
 *     前端跟着变，不需要发版。
 *  2. 提交用 `spec_rows` 只算用户选中的那一组规格，不做全组合展开。
 *  3. 报价政策（税率、利润率等）**不在前端填**：不传时引擎会按
 *     税务档案的法定默认值计算，并把「退税率未核实」等提示回给前端，
 *     由业务确认 —— 前端不得替业务猜税率。
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { EXPORT_QUOTE_BASE } from "@/lib/export-quote/import-file";
import type {
  ExportQuoteRequest,
  ExportQuoteResponse,
  ProductFormulasResponse,
} from "@contracts/export-quote";

export type QuoteView = "customer" | "internal";

/**
 * 产品的规格空间定义（轴 + 变体）。
 * 轴是独立规格（如网高、竖丝间距）；变体是「一次选定、联动多个属性」的组合
 * （如丝径方案一选定，边丝/内横丝/竖丝直径与卷长、卷径同时确定）。
 */
export function useProductFormulas(productKey: string | null) {
  return useQuery({
    queryKey: ["export-quote", "formulas", productKey],
    queryFn: async () => {
      const { data } = await apiClient.get<ProductFormulasResponse>(
        `${EXPORT_QUOTE_BASE}/products/${productKey}/formulas`,
      );
      return data;
    },
    enabled: !!productKey,
    staleTime: 10 * 60 * 1000,
  });
}

/** 单笔试算。**试算不写台账** —— 台账只在报价单签发/订单成交时写入。 */
export function useCalcQuote() {
  return useMutation({
    mutationFn: async ({
      payload,
      view,
    }: {
      payload: ExportQuoteRequest;
      view: QuoteView;
    }) => {
      // 客户视图与内部视图是两个接口，避免"越权拿成本"的写法出现
      const url =
        view === "internal"
          ? `${EXPORT_QUOTE_BASE}/calculate-internal`
          : `${EXPORT_QUOTE_BASE}/calculate`;
      const { data } = await apiClient.post<ExportQuoteResponse>(url, payload, {
        timeout: 60_000,
      });
      return data;
    },
  });
}
