"use client";

/**
 * 实收记录数据层（§13.3 新增）。
 *
 * 契约：`GET /orders/{id}/receipts` → `{items,total}`；
 * `POST /orders/{id}/receipts` → 201 单条 receipt；
 * `POST /payment-receipts/{id}/files`（multipart）→ 到账截图挂到该 receipt 的 file_id。
 *
 * 失败原因由弹窗/面板自己展示（`silent: true`），不让全局 toast 抢戏。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import {
  buildReceiptCreate,
  type PaymentReceipt,
  type ReceiptCreateInput,
  type ReceiptListResponse,
} from "@/lib/orders/payment-schedules";
import { buildReceiptFileForm } from "@/lib/orders/order-attachments";

export const receiptKeys = {
  list: (orderId: number) => ["orders", orderId, "receipts"] as const,
};

export function useOrderReceipts(orderId: number | null) {
  return useQuery({
    queryKey: receiptKeys.list(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<ReceiptListResponse>(
        `/orders/${orderId}/receipts`,
      );
      return data;
    },
  });
}

function invalidateOrder(qc: ReturnType<typeof useQueryClient>, orderId: number) {
  void qc.invalidateQueries({ queryKey: ["orders", orderId] });
  void qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
  // 登记实收后应收台账的 received_amount/status 会变
  void qc.invalidateQueries({ queryKey: ["receivables"] });
}

export function useCreateReceipt(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReceiptCreateInput) => {
      const built = buildReceiptCreate(input);
      if (!built.ok) throw new Error(built.error);
      const { data } = await apiClient.post<PaymentReceipt>(
        `/orders/${orderId}/receipts`,
        built.body,
        { silent: true },
      );
      return data;
    },
    onSuccess: () => invalidateOrder(qc, orderId),
  });
}

/** 上传到账截图（登记收款时选传；失败不回滚已登记的收款，可后续补传）。 */
export function useUploadReceiptFile(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      receiptId,
      file,
    }: {
      receiptId: number;
      file: File;
    }) => {
      const { data } = await apiClient.post<{ id: number }>(
        `/payment-receipts/${receiptId}/files`,
        buildReceiptFileForm(file),
        {
          headers: { "Content-Type": "multipart/form-data" },
          silent: true,
        },
      );
      return data;
    },
    onSuccess: () => invalidateOrder(qc, orderId),
  });
}
