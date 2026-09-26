"use client";

import { usePageView } from "@/lib/events/use-page-view";

import { MarketView } from "./components/market-view";

/**
 * 产品市场对照（页面容器）。
 * 视图实现见 components/market-view.tsx：页面文件的默认导出带自定义 props 会让
 * Next 静态导出校验失败，所以视图必须是普通组件。
 */
export default function MarketPage() {
  usePageView({ resource_id: "/market" });
  return <MarketView />;
}
