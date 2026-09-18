"use client";

import { apiClient } from "@/lib/api/client";
import { queryKeys } from "@/lib/query/keys";
import { useSafeQuery } from "@/lib/query/safe-query";

export interface IntelShipment {
  id: number;
  tenant_id: number;
  shipper_name: string;
  shipper_country?: string;
  consignee_name: string;
  consignee_country?: string;
  product_desc: string;
  hs_code?: string;
  quantity?: number;
  quantity_unit?: string;
  gross_weight_kg?: number;
  net_weight_kg?: number;
  volume_cbm?: number;
  container_no?: string;
  bl_no?: string;
  origin_country?: string;
  dest_country?: string;
  departure_date?: string;
  arrival_date?: string;
  declared_value_usd?: number;
  marks?: string;
  remarks?: string;
  shipment_type?: string;
  incoterm?: string;
  freight_prepaid?: boolean;
  source_channel?: string;
  source_ref?: string;
  is_verified: boolean;
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
  partner_country: string;
  trade_flow: string;
  quantity?: number;
  quantity_unit?: string;
  value_usd?: number;
}

export interface IntelTradeStatListResponse {
  items: IntelTradeStat[];
  total: number;
  page: number;
  page_size: number;
}

export interface IntelTradeStatFilters {
  hs_code?: string;
  partner_country?: string;
  trade_flow?: string;
  period?: string;
  page?: number;
  page_size?: number;
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
      const { data } = await apiClient.get<IntelTradeStatListResponse>(
        `/intel/trade-stats?${params.toString()}`
      );
      return data;
    },
    staleTime: 60_000,
  });
}

export interface IntelAdapterRun {
  id: number;
  tenant_id: number;
  channel: string;
  status: string;
  items_processed: number;
  items_inserted: number;
  error_message?: string;
  run_metadata?: Record<string, unknown>;
  started_at: string;
  completed_at?: string;
  created_at: string;
}

export interface IntelAdapterRunListResponse {
  items: IntelAdapterRun[];
  total: number;
  page: number;
  page_size: number;
}

export function useIntelAdapterRuns(page = 1, pageSize = 20) {
  return useSafeQuery({
    queryKey: queryKeys.intel.adapterRuns,
    queryFn: async () => {
      const { data } = await apiClient.get<IntelAdapterRunListResponse>(
        `/intel/adapter-runs?page=${page}&page_size=${pageSize}`
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export interface IntelChannel {
  id: number;
  channel_code: string;
  channel_name: string;
  tier: "free" | "paid";
  is_enabled: boolean;
  description?: string;
}

export interface IntelChannelsResponse {
  free_channels: IntelChannel[];
  paid_channels: IntelChannel[];
  message?: string;
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
