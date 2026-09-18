"use client";

import { useState } from "react";
import { ShipmentsTable } from "./components/shipments-table";
import { TradeStatsView } from "./components/trade-stats-view";
import { AdapterRunsList } from "./components/adapter-runs-list";
import { ChannelsView } from "./components/channels-view";
import { usePageView } from "@/lib/events/use-page-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TabKey = "shipments" | "trade-stats" | "channels" | "runs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "shipments", label: "货运记录" },
  { key: "trade-stats", label: "贸易统计" },
  { key: "channels", label: "数据渠道" },
  { key: "runs", label: "采集任务" },
];

export default function IntelPage() {
  usePageView({ resource_id: "/intel" });
  const [activeTab, setActiveTab] = useState<TabKey>("shipments");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold md:text-2xl">商情雷达</h1>
          <p className="text-sm text-muted-foreground mt-1">
            进出口贸易数据监测与分析工作台
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-b">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            variant="ghost"
            className={cn(
              "rounded-none border-b-2 border-transparent px-4 pb-2",
              activeTab === tab.key && "border-primary font-medium"
            )}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <div className="mt-6">
        {activeTab === "shipments" && <ShipmentsTable />}
        {activeTab === "trade-stats" && <TradeStatsView />}
        {activeTab === "channels" && <ChannelsView />}
        {activeTab === "runs" && <AdapterRunsList />}
      </div>
    </div>
  );
}
