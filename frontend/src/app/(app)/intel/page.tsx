"use client";

import { useState } from "react";
import { IntelSection } from "./components/intel-section";
import { MarketView } from "../market/components/market-view";
import { usePageView } from "@/lib/events/use-page-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * 情报工位（一个工位 = 一个侧边栏入口）
 * ────────────────────────────────────────
 * 合并前是两个独立菜单：「进出口情报」与「产品市场对照」。
 * 但两者本质同类 —— 都是“看市场数据”（一个是海关/贸易，一个是地区需求/当地品名/港口），
 * 所以整合为一个工位、内部两个板块。
 */

type SectionKey = "intel" | "market";

const SECTIONS: { key: SectionKey; label: string; desc: string }[] = [
  {
    key: "intel",
    label: "进出口情报",
    desc: "海关贸易数据采集与宏观市场分析",
  },
  {
    key: "market",
    label: "产品市场对照",
    desc: "什么地方卖什么、当地叫什么、走哪个港口",
  },
];

export default function IntelWorkstationPage() {
  usePageView({ resource_id: "/intel" });
  const [section, setSection] = useState<SectionKey>("intel");
  const current = SECTIONS.find((s) => s.key === section)!;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold md:text-2xl">市场情报</h1>
        <p className="mt-1 text-sm text-muted-foreground">{current.desc}</p>
      </div>

      {/* 2026-10-17 tab 收编到 ui/tabs：条件渲染（keepMounted={false}）
          行为与收编前一致；文案不变。 */}
      <Tabs value={section} onValueChange={(v) => setSection(v as SectionKey)}>
        <TabsList variant="line">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.key} variant="line" value={s.key}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="intel" keepMounted={false}>
          <IntelSection />
        </TabsContent>
        <TabsContent value="market" keepMounted={false}>
          <MarketView showHeader={false} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
