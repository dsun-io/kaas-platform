"use client";

/**
 * 已有单证（外部单证台账）数据层 —— §13.3 追加需求。
 *
 * 契约：`GET /external-docs?order_id=` 返回数组；
 * `POST /external-docs` multipart → `{id,file_name}`；
 * `GET /external-docs/{id}/download` 返回二进制（带 Content-Disposition）。
 *
 * 与订单附件（`use-order-files`）完全分开：这里进单证台账，附件只是随单文件。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import {
  buildExternalDocForm,
  normalizeExternalDocList,
  type ExternalDoc,
} from "@/lib/orders/external-docs";

export const externalDocKeys = {
  list: (orderId: number) => ["orders", orderId, "external-docs"] as const,
};

export function useExternalDocs(orderId: number | null) {
  return useQuery({
    queryKey: externalDocKeys.list(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<
        ExternalDoc[] | { items: ExternalDoc[] }
      >("/external-docs", {
        params: { order_id: orderId },
        silent: true,
      });
      return normalizeExternalDocList(data);
    },
  });
}

/** 导入已有单证（建单时导入与详情补导入共用这一条）。 */
export function useUploadExternalDoc(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      doc_type: string;
      customer_id?: number | string | null;
      notes?: string;
    }) => {
      const { data } = await apiClient.post<{ id: number; file_name: string }>(
        "/external-docs",
        buildExternalDocForm({ ...input, order_id: orderId }),
        {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: externalDocKeys.list(orderId) });
      void qc.invalidateQueries({ queryKey: ["orders", orderId] });
    },
  });
}

/**
 * 取单证字节（下载用）。
 *
 * 为什么走 axios 而不是 <a href>：`/external-docs/{id}/download` 需要 Bearer 授权，
 * 直接链接触发浏览器导航会 401；先取 blob 再触发本地下载。
 */
export async function fetchExternalDocBlob(docId: number): Promise<Blob> {
  const res = await apiClient.get<Blob>(`/external-docs/${docId}/download`, {
    responseType: "blob",
    silent: true,
  });
  return res.data as Blob;
}
