"use client";

/**
 * 订单收款计划的数据层（C36 下期 #6/#10/#20）。
 *
 * 查询键统一 `["orders", orderId, "payment-schedules"]`；写成功后失效它 +
 * `["upstream","orders"]`（订单列表/下拉里的金额与状态可能联动）。
 *
 * `silent: true`：失败原因由面板自己展示（422 schedule_type 必填 / 409 已收款不可回退等），
 * 不让全局 toast 抢戏。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";
import type {
  PaymentSchedule,
  ScheduleCreateInput,
  SchedulePatchInput,
  ScheduleListResponse,
} from "@/lib/orders/payment-schedules";
import { buildScheduleCreate, buildSchedulePatch } from "@/lib/orders/payment-schedules";

export const scheduleKeys = {
  list: (orderId: number) =>
    ["orders", orderId, "payment-schedules"] as const,
};

export function useOrderSchedules(orderId: number | null) {
  return useQuery({
    queryKey: scheduleKeys.list(orderId ?? 0),
    enabled: orderId !== null,
    queryFn: async () => {
      const { data } = await apiClient.get<ScheduleListResponse>(
        `/orders/${orderId}/payment-schedules`,
      );
      return data;
    },
  });
}

export function useCreateSchedule(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ScheduleCreateInput) => {
      const built = buildScheduleCreate(input);
      if (!built.ok) throw new Error(built.error);
      const { data } = await apiClient.post<PaymentSchedule>(
        `/orders/${orderId}/payment-schedules`,
        built.body,
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduleKeys.list(orderId) });
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });
}

export function useUpdateSchedule(orderId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      scheduleId,
      input,
    }: {
      scheduleId: number;
      input: SchedulePatchInput;
    }) => {
      const built = buildSchedulePatch(input);
      if (!built.ok) throw new Error(built.error);
      const { data } = await apiClient.patch<PaymentSchedule>(
        `/payment-schedules/${scheduleId}`,
        built.body,
        { silent: true },
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: scheduleKeys.list(orderId) });
      qc.invalidateQueries({ queryKey: ["upstream", "orders"] });
    },
  });
}
