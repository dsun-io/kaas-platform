"use client";

/** 顶部统计卡（从 page.tsx 拆出；4 张卡的值/图标/顺序不变）。 */
import { StatCard } from "@/components/shared";
import { CheckCircle2, Globe2, Layers, PackageSearch } from "lucide-react";

import type { ResearchStats } from "../lib/types";

export function ResearchStatsCards({ stats }: { stats?: ResearchStats }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <StatCard
        label="调研产品"
        value={stats?.total ?? 0}
        icon={PackageSearch}
      />
      <StatCard
        label="可供货"
        value={stats?.can_supply_yes ?? 0}
        icon={CheckCircle2}
        variant="gradient"
      />
      <StatCard
        label="国家数"
        value={stats?.by_country.length ?? 0}
        icon={Globe2}
      />
      <StatCard
        label="类目数"
        value={stats?.by_category.length ?? 0}
        icon={Layers}
      />
    </div>
  );
}
