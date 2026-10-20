"use client";

import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import { useSafeQuery } from "@/lib/query/safe-query";

export interface IntelShipment {
  id: number;
  tenant_id: string;
  shipper: string;
  ship_date?: string;
  carrier?: string;
  notify_party?: string;
  origin_port?: string;
  origin_country?: string;
  dest_port?: string;
  dest_country?: string;
  consignee: string;
  product_desc: string;
  product_desc_norm?: string;
  hs_code?: string;
  category_id?: number;
  qty?: number;
  qty_unit?: string;
  gross_weight_kg?: number;
  net_weight_kg?: number;
  volume_cbm?: number;
  container_no?: string;
  container_type?: string;
  bl_no?: string;
  voyage_no?: string;
  declared_value?: number;
  currency?: string;
  marks?: string;
  remarks?: string;
  shipment_type?: string;
  incoterm?: string;
  freight_prepaid?: boolean;
  source_channel: string;
  source_ref?: string;
  is_verified: boolean;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface IntelShipmentListResponse {
  items: IntelShipment[];
  total: number;
  page: number;
  page_size: number;
}

export interface IntelShipmentFilters {
  shipper?: string;
  consignee?: string;
  dest_country?: string;
  origin_country?: string;
  hs_code?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
}

export function useIntelShipments(filters: IntelShipmentFilters = {}) {
  return useSafeQuery({
    queryKey: queryKeys.intel.shipments(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          params.append(key, String(value));
        }
      });
      const { data } = await apiClient.get<IntelShipmentListResponse>(
        `/intel/shipments?${params.toString()}`
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export function useIntelShipment(id: number) {
  return useSafeQuery({
    queryKey: queryKeys.intel.shipment(id),
    queryFn: async () => {
      const { data } = await apiClient.get<IntelShipment>(
        `/intel/shipments/${id}`
      );
      return data;
    },
    staleTime: 60_000,
  });
}

export interface IntelTradeStat {
  id: number;
  hs_code: string;
  period: string;
  reporter_country?: string;
  partner_country: string;
  trade_flow: string;
  qty?: number;
  qty_unit?: string;
  value_usd?: number;
}

export interface IntelTradeStatFilters {
  hs_code?: string;
  partner_country?: string;
  trade_flow?: string;
  period?: string;
}

export function useIntelTradeStats(filters: IntelTradeStatFilters = {}) {
  return useSafeQuery({
    queryKey: queryKeys.intel.tradeStats(filters),
    queryFn: async () => {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined && value !== "") {
          params.append(key, String(value));
        }
      });
      const { data } = await apiClient.get<IntelTradeStat[]>(
        `/intel/trade-stats?${params.toString()}`
      );
      return data;
    },
    staleTime: 60_000,
  });
}

export interface IntelAdapterRun {
  id: number;
  tenant_id: string;
  status: string;
  started_at: string;
  finished_at?: string;
  items_processed: number;
  items_inserted: number;
  error_message?: string;
}

export function useIntelAdapterRuns(status?: string, limit = 50) {
  return useSafeQuery({
    queryKey: queryKeys.intel.adapterRuns,
    queryFn: async () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status) params.append("status", status);
      const { data } = await apiClient.get<IntelAdapterRun[]>(
        `/intel/adapter-runs?${params.toString()}`
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export interface IntelChannel {
  id: number;
  name: string;
  type: string;
  /**
   * 后端真源字段：`main.py:1024-1040` 原样返回 `intel_data_channels` 行，
   * 列的 DB 定义是 `is_enabled`（见 `backend ... models.py:1132`）。
   */
  is_enabled?: boolean;
  /**
   * @deprecated 后端**从未返回** `enabled`。这是前端旧接口定义写错的字段名
   * （对齐审计 2026-10-20 发现：free 通道因此永远显示"未开通"）。
   * 仅作向后兼容读取，判断请统一用 `isChannelEnabled()`。
   */
  enabled?: boolean;
  /** 后端只对 paid 通道附加（"未开通"/"已开通"），free 通道可能没有 */
  message?: string;
}

/**
 * 通道是否已开通 —— **唯一**判断口径。
 *
 * 后端字段是 `is_enabled`；`enabled` 是历史误写，只有旧 mock/中间层才可能有。
 * 用 `??` 而不是 `||`：`is_enabled: false` 必须压过 `enabled: true`（后端真源优先）。
 */
export function isChannelEnabled(
  channel: Pick<IntelChannel, "is_enabled" | "enabled">,
): boolean {
  return channel.is_enabled ?? channel.enabled ?? false;
}

export interface IntelChannelsResponse {
  free_channels: IntelChannel[];
  paid_channels: IntelChannel[];
}

export function useIntelChannels() {
  return useSafeQuery({
    queryKey: queryKeys.intel.channels,
    queryFn: async () => {
      const { data } = await apiClient.get<IntelChannelsResponse>(
        "/intel/channels"
      );
      return data;
    },
    staleTime: 60_000,
  });
}
