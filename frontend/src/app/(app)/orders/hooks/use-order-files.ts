"use client";

/**
 * 订单附件数据层（§13.3）。
 *
 * 契约：`GET /orders/{id}/files` → `{items}`（file_objects 行）；
 * `POST /orders/{id}/files`（multipart，file + 可选 name）→ 201 file 对象。
 * 类别（合同/PO/信用证）按后端口径编码在 name 里，见 `lib/orders/order-attachments.ts`。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import { buildOrderAttachmentForm } from "@/lib/orders/order-attachments";

export interface OrderAttachmentFile {
  id: number;
  name: string;
  kind?: string | null;
  content_type?: string | null;
  storage?: string | null;
  size?: number | null;
  created_at?: string | null;
}

export const orderFileKeys = {
  list: (orderId: number) => ["orders", orderId, "files"] as const,
};

export function useOrderFiles(orderId: number | null) {
  return useQuery({
    queryKey: orderFileKeys.list(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async () => {
      // 首选订单专属列表端点；后端尚未上线该端点时回退通用文件列表
      // （owner_type=order&owner_id=...，与 Lead 2026-10-22 的接口口径一致）。
      try {
        const { data } = await apiClient.get<{ items: OrderAttachmentFile[] }>(
          `/orders/${orderId}/files`,
        );
        return data.items;
      } catch {
        const { data } = await apiClient.get<{ items: OrderAttachmentFile[] }>(
          "/file-objects",
          {
            params: { owner_type: "order", owner_id: orderId },
            silent: true,
          },
        );
        return data.items;
      }
    },
  });
}

export function useUploadOrderFile(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, name }: { file: File; name: string }) => {
      const { data } = await apiClient.post<OrderAttachmentFile>(
        `/orders/${orderId}/files`,
        buildOrderAttachmentForm(file, name),
        {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        },
      );
      return data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: orderFileKeys.list(orderId) });
    },
  });
}
