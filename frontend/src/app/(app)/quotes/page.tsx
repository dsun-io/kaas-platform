"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { usePageView } from "@/lib/events/use-page-view";
// 工位内部视图：直接复用既有页面，避免复制业务逻辑（页面级搬迁放到 P4 统一做）
import QuoteCalcView from "../quotations/v2-quote/page";
import QuoteRecordsView from "../quotations/page";
import PricingDataView from "../pricing-data/page";

/**
 * 报价工位（一个工位 = 一个侧边栏入口）
 * ────────────────────────────────────────
 * 合并前，侧边栏有 3 个"报价"相关入口，容易混淆：
 *   · 报价      —— 算价工具
 *   · 报价记录  —— 历史台账
 *   · 报价数据  —— 实为「成本价表」（算价的输入数据）
 * 三者本来是一条线：数据 → 算价 → 记账，因此合并为一个工位、内部三个视图。
 *
 * 目标结构（P4 完成）：
 *   产品报价（产品本身价格）· 运输报价（货代运费）· 报价记录 · 定价数据
 * 其中「运输报价」依赖后端 customer_freight_rates（已有表与计算器，前端页面待建）。
 */

type QuoteTab = "calc" | "records" | "pricing";

const TABS: { key: QuoteTab; label: string; hint: string }[] = [
  { key: "calc", label: "产品报价", hint: "选产品规格 → 自动算价并生成话术" },
  { key: "records", label: "报价记录", hint: "历史报价台账" },
  { key: "pricing", label: "定价数据", hint: "成本价表（算价的输入数据）" },
];

export default function QuotesWorkstationPage() {
  const [tab, setTab] = useState<QuoteTab>("calc");
  usePageView({ resource_id: "/quotes" });

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.hint}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 px-4 pb-2 text-sm transition-colors",
              tab === t.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "calc" && <QuoteCalcView />}
      {tab === "records" && <QuoteRecordsView />}
      {tab === "pricing" && <PricingDataView />}
    </div>
  );
}
