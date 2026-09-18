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
  enabled: boolean;
  message?: string;
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
