"use client";

import { useState } from "react";
import { ShipmentsTable } from "./shipments-table";
import { TradeStatsView } from "./trade-stats-view";
import { AdapterRunsList } from "./adapter-runs-list";
import { ChannelsView } from "./channels-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
      <TabsList variant="line">
        {TABS.map((tab) => (
          <TabsTrigger key={tab.key} variant="line" value={tab.key}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="shipments" keepMounted={false}>
        <ShipmentsTable />
      </TabsContent>
      <TabsContent value="trade-stats" keepMounted={false}>
        <TradeStatsView />
      </TabsContent>
      <TabsContent value="channels" keepMounted={false}>
        <ChannelsView />
      </TabsContent>
      <TabsContent value="runs" keepMounted={false}>
        <AdapterRunsList />
      </TabsContent>
    </Tabs>
  );
}
