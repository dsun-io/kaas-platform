"use client";

import { useState } from "react";
import { ShipmentsTable } from "./shipments-table";
import { TradeStatsView } from "./trade-stats-view";
import { AdapterRunsList } from "./adapter-runs-list";
import { ChannelsView } from "./channels-view";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type TabKey = "shipments" | "trade-stats" | "channels" | "runs";

const TABS: { key: TabKey; label: string }[] = [
  { key: "shipments", label: "货运记录" },
  { key: "trade-stats", label: "贸易统计" },
  { key: "channels", label: "数据渠道" },
  { key: "runs", label: "采集任务" },
];

/**
 * 进出口情报板块（原 /intel 页面内容）。
 * 标题与描述由「市场情报」工位容器统一渲染，此处不再输出 h1，避免与板块 tab 重复。
 */
export function IntelSection() {
  const [activeTab, setActiveTab] = useState<TabKey>("shipments");

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b">
        {TABS.map((tab) => (
          <Button
            key={tab.key}
            variant="ghost"
            className={cn(
              "rounded-none border-b-2 border-transparent px-4 pb-2",
              activeTab === tab.key && "border-primary font-medium",
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
