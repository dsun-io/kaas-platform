"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import type {
  ExportProduct,
  ExportRateSet,
  ExportTermsTemplate,
  ImportCalculateResponse,
  ImportPreviewResponse,
  ImportTemplateInfo,
  ImportTemplateFormat,
} from "@contracts/export-quote";
import {
  EXPORT_QUOTE_BASE,
  MULTIPART_CONFIG,
  buildImportFormData,
  filenameFromDisposition,
  templateFilename,
  templateUrl,
  triggerBlobDownload,
} from "@/lib/export-quote/import-file";

/** 已注册的产品模型（牛栏网…）。 */
export function useExportProducts() {
  return useQuery({
    queryKey: ["export-quote", "products"],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        products: ExportProduct[];
        total: number;
      }>(`${EXPORT_QUOTE_BASE}/products`);
      return data;
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** 可用税务档案 —— 法定税率不写死在前端，从档案取。 */
export function useExportRateSets() {
  return useQuery({
    queryKey: ["export-quote", "rate-sets"],
    queryFn: async () => {
      const { data } = await apiClient.get<{
        rate_sets: ExportRateSet[];
        total: number;
      }>(`${EXPORT_QUOTE_BASE}/rate-sets`);
      return data;
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
/**
 * 模板说明：有哪些列、哪些必填、单位、可选值。
 *
 * 页面上先讲清「该填什么」再让用户下载，省去「下下来发现不会填 → 传错 → 改」
 * 这一轮来回。
 */
export function useImportTemplateInfo(productKey: string | null) {
  return useQuery({
    queryKey: ["export-quote", "import-template", productKey],
    queryFn: async () => {
      const { data } = await apiClient.get<ImportTemplateInfo>(
        `${EXPORT_QUOTE_BASE}/products/${productKey}/import-template`,
      );
      return data;
    },
    enabled: !!productKey,
    staleTime: 10 * 60 * 1000,
  });
}

/** 下载模板：直接从系统拿文件，不需要先手工造一份。 */
export function useDownloadTemplate() {
  return useMutation({
    mutationFn: async ({
      productKey,
      format,
      examples,
    }: {
      productKey: string;
      format: ImportTemplateFormat;
      examples?: number;
    }) => {
      const { data, headers } = await apiClient.get<Blob>(
        templateUrl(
          productKey,
          format,
          examples === undefined ? {} : { examples },
        ),
        { responseType: "blob", timeout: 60_000 },
      );
      const fallback = templateFilename(productKey, format);
      const name = filenameFromDisposition(
        headers["content-disposition"] as string | undefined,
        fallback,
      );
      triggerBlobDownload(data, name);
      return name;
    },
  });
}

/** 只解析不计算：先让用户确认列名认对了、哪些行会被跳过。 */
export function useImportPreview() {
  return useMutation({
    mutationFn: async ({
      file,
      productKey,
      payload,
      sheet,
    }: {
      file: File;
      productKey: string;
      payload: Record<string, unknown>;
      sheet?: string;
    }) => {
      const fd = buildImportFormData(file, payload, { productKey, sheet });
      const { data } = await apiClient.post<ImportPreviewResponse>(
        `${EXPORT_QUOTE_BASE}/import/preview`,
        fd,
        MULTIPART_CONFIG,
      );
      return data;
    },
  });
}

/** 整表一次算完。 */
export function useImportCalculate() {
  return useMutation({
    mutationFn: async ({
      file,
      productKey,
      payload,
      view,
      sheet,
    }: {
      file: File;
      productKey: string;
      payload: Record<string, unknown>;
      view: "customer" | "internal";
      sheet?: string;
    }) => {
      const fd = buildImportFormData(file, payload, {
        productKey,
        view,
        sheet,
      });
      const { data } = await apiClient.post<ImportCalculateResponse>(
        `${EXPORT_QUOTE_BASE}/import/calculate`,
        fd,
        MULTIPART_CONFIG,
      );
      return data;
    },
  });
}
