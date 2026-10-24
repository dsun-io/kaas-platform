"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  ExportProduct,
  ExportTermsTemplate,
  OrderImportPreviewResponse,
  OrderImportTemplateInfo,
} from "@contracts/export-quote";
import { buildOrderImportTemplateXlsx } from "@/lib/export-quote/import-order-template-xlsx";
import {
  EXPORT_QUOTE_BASE,
  MULTIPART_CONFIG,
  triggerBlobDownload,
} from "@/lib/export-quote/import-file";

import { useMutationWithError } from "./use-mutation-with-error";

/** 已注册的产品模型（牛栏网…）。 */
export function useExportProducts() {
  return useQuery({
    queryKey: ["export-quote", "products"],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        products: ExportProduct[];
        total: number;
      }>(`${EXPORT_QUOTE_BASE}/products`);
      // 后端（需求 16）已剔除本团队在报价工位停用的产品；这里是前端兜底 ——
      // 旧后端 / MSW 种子若带了 is_active=false 或 disabled=true 的行，也不进下拉。
      const products = data.products.filter(
        (p) =>
          (p as { is_active?: boolean }).is_active !== false &&
          (p as { disabled?: boolean }).disabled !== true,
      );
      return { products, total: products.length };
    },
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * 平台默认的出口费用结构（贸易术语阶梯 + 费用项）。
 *
 * 界面据此渲染运费/附加费输入框，并把模板**原样回传**（只填 value）——
 * 所以「FOB 包含哪些费」这类业务知识留在后端，前端不写死。
 */
export function useExportTermsTemplate() {
  return useQuery({
    queryKey: ["export-quote", "terms-template"],
    queryFn: async () => {
      const { data } = await apiClient.get<ExportTermsTemplate>(
        `${EXPORT_QUOTE_BASE}/terms/template`,
      );
      return data;
    },
    // 结构与计价方式很稳定，没必要频繁拉
    staleTime: 30 * 60 * 1000,
  });
}

const IMPORT_TEMPLATE_STALE_MS = 10 * 60 * 1000;

// ── 整单批量导入（R-D，2026-10-23）──────────────────────────────────────────
// 口径：单表 + 产品列，规格列 = 各产品模板列并集；导入结果**直接填入报价工作台**
//（不再「只算不落库」，也不在导入端点里算价——算价/落库都走工作台既有链路）。

function fetchOrderImportTemplateInfo(
  productKeys: string[],
): Promise<OrderImportTemplateInfo> {
  return apiClient
    .get<OrderImportTemplateInfo>(
      `${EXPORT_QUOTE_BASE}/import/order/template-info`,
      {
        params:
          productKeys.length > 0 ? { product_keys: productKeys.join(",") } : {},
      },
    )
    .then(({ data }) => data);
}

/** 整单模板信息的 query key（按产品集合区分缓存）。 */
export function orderImportTemplateQueryKey(productKeys: string[]) {
  return [
    "export-quote",
    "import-order-template",
    [...productKeys].sort(),
  ] as const;
}

/** 整单模板说明：并集列（含每列适用产品）。 */
export function useOrderImportTemplateInfo(productKeys: string[]) {
  return useQuery({
    queryKey: orderImportTemplateQueryKey(productKeys),
    queryFn: () => fetchOrderImportTemplateInfo(productKeys),
    staleTime: IMPORT_TEMPLATE_STALE_MS,
  });
}

/** 下载整单模板（前端 exceljs 生成；列定义来自后端）。 */
export function useDownloadOrderTemplate() {
  const queryClient = useQueryClient();
  return useMutationWithError({
    mutationFn: async ({ productKeys }: { productKeys: string[] }) => {
      const info = await queryClient.ensureQueryData({
        queryKey: orderImportTemplateQueryKey(productKeys),
        queryFn: () => fetchOrderImportTemplateInfo(productKeys),
        staleTime: IMPORT_TEMPLATE_STALE_MS,
      });
      let blob: Blob;
      try {
        blob = await buildOrderImportTemplateXlsx(info);
      } catch (err) {
        throw new Error(
          `生成 Excel 模板失败：${err instanceof Error ? err.message : "未知错误"}`,
        );
      }
      triggerBlobDownload(blob, "整单报价导入模板.xlsx");
      return "整单报价导入模板.xlsx";
    },
  });
}

/** 上传整单表：只解析 + 行级校验，不落库、不算价。 */
export function useImportOrderPreview() {
  return useMutationWithError({
    mutationFn: async ({ file, sheet }: { file: File; sheet?: string }) => {
      const fd = new FormData();
      fd.append("file", file);
      if (sheet) fd.append("sheet", sheet);
      const { data } = await apiClient.post<OrderImportPreviewResponse>(
        `${EXPORT_QUOTE_BASE}/import/order/preview`,
        fd,
        MULTIPART_CONFIG,
      );
      return data;
    },
  });
}
