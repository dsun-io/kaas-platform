"use client";

/**
 * 出货工位数据层：列表（分页/状态筛选）+ **单条详情**（编辑弹窗）。
 *
 * 为什么编辑弹窗要单独查详情（而不是只用打开时的列表行）：
 * 列表行是「打开那一刻」的快照 —— 别人在这期间改了提单号/船期，弹窗还显示旧值，
 * 保存时就会把别人的修改覆盖掉；推进状态（PATCH status）后列表刷新，快照也会过期。
 * 现在：弹窗按 id 拉 `GET /shipments/{id}`（后端 `ws_shipments.get_shipment`，
 * 形状同列表行），并把它作为表单初始值；列表刷新/筛选变化不再影响弹窗取数。
 *
 * 与列表的关系：`queryKey` 共用 `["shipments"]` 前缀 ⇒ 保存/推进成功后
 * `invalidateQueries({queryKey:["shipments"]})` 会同时刷新列表与详情，不会出现
 * 「列表已变、详情还是旧值」。详情 **retry:false**：失败由弹窗内展示并可重试，
 * 不替用户自动重试（失败原因需要被看见）；`silent:true` 避免与页内错误双 toast。
 */
import { useQuery } from "@tanstack/react-query";

import apiClient from "@/lib/api/client";

import type { ShipmentRow } from "../types";

export const SHIPMENTS_PAGE_SIZE = 20;

export const shipmentKeys = {
  all: ["shipments"] as const,
  list: (status: string, page: number) =>
    ["shipments", "list", status, page] as const,
  detail: (shipmentId: number | null) =>
    ["shipments", "detail", shipmentId] as const,
};

export interface ShipmentsListResponse {
  items: ShipmentRow[];
  total: number;
  page: number;
  page_size: number;
}

/** 列表（服务端分页；筛选变化由调用方回第 1 页）。 */
export function useShipmentsList(status: string, page: number) {
  return useQuery({
    queryKey: shipmentKeys.list(status, page),
    queryFn: async () => {
      const { data } = await apiClient.get<ShipmentsListResponse>("/shipments", {
        params: {
          status: status || undefined,
          page,
          page_size: SHIPMENTS_PAGE_SIZE,
        },
      });
      return data;
    },
  });
}

/**
 * 单条出货详情（编辑弹窗的真实数据源）。
 *
 * `staleTime` 取 30s：弹窗关掉再开同一单不该每次都打接口；但超过 30s 再次打开
 * 会重新取一次，减少"拿着很旧的快照改提单号"的窗口。
 */
export function useShipmentDetail(shipmentId: number | null) {
  return useQuery({
    queryKey: shipmentKeys.detail(shipmentId),
    enabled: shipmentId !== null,
    retry: false,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const { data } = await apiClient.get<ShipmentRow>(
        `/shipments/${shipmentId}`,
        { silent: true },
      );
      return data;
    },
  });
}
