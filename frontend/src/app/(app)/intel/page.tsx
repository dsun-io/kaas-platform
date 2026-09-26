"use client";

import { useState } from "react";
import { IntelSection } from "./components/intel-section";
import { MarketView } from "../market/components/market-view";
import { usePageView } from "@/lib/events/use-page-view";
import { cn } from "@/lib/utils";

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

      <div className="flex gap-2 border-b">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSection(s.key)}
            className={cn(
              "-mb-px border-b-2 px-4 pb-2 text-sm transition-colors",
              section === s.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === "intel" && <IntelSection />}
      {section === "market" && <MarketView showHeader={false} />}
    </div>
  );
}
