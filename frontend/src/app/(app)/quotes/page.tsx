"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { usePageView } from "@/lib/events/use-page-view";
import { ProductQuoteView } from "./views/product-quote-view";
import { QuotationRecordsView } from "./views/quotation-records-view";
// 复用既有组件，不复制业务逻辑：
//   · 批量导入面板已正确接线算价引擎（下载模板 → 上传 → 预览 → 一次算完）
//   · 定价数据管理器是「成本价表」的维护界面（算价的输入数据）
import { BulkImportPanel } from "../quotations/v2-quote/components/bulk-import-panel";
import { PricingDataManager } from "../pricing-data/pricing-data-manager";

/**
 * 报价工位（一个工位 = 一个侧边栏入口）
 * ─────────────────────────────────────────
 * 一条业务线：**定价数据（成本输入）→ 报价（算价）→ 报价记录（台账）**
 *
 * 本次重设计修复的三个问题：
 *  1. 旧版把「产品报价」直接嵌成**另一个完整页面**，于是出现「页面套页面、
 *     tab 套 tab」。现在改为嵌入**视图组件**，页面外壳只在本文件出现一次。
 *  2. 旧版「定价数据」在内外层**各有一个入口**（同一功能重复）。现在只保留一处。
 *  3. 旧版把「批量导入」藏在产品报价内部当子 tab。它与单笔报价是**两种并列的
 *     工作方式**，不是主从关系，因此提升为平级视图。
 *
 * 运输报价（货代运费表 + 试算）按计划在接线完成后加入，届时为第 5 个平级视图。
 */

type QuoteTab = "product" | "bulk" | "records" | "pricing";

const TABS: { key: QuoteTab; label: string; hint: string }[] = [
  {
    key: "product",
    label: "产品报价",
    hint: "选产品与规格 → 自动算价（客户视图 / 内部核算）",
  },
  { key: "bulk", label: "批量报价", hint: "表格导入 → 一次算完" },
  { key: "records", label: "报价记录", hint: "历史台账" },
  { key: "pricing", label: "定价数据", hint: "成本价表（算价的输入数据）" },
];

const isTab = (v: string | null): v is QuoteTab =>
  TABS.some((t) => t.key === v);

export default function QuotesWorkstationPage() {
  const [tab, setTab] = useState<QuoteTab>("product");
  usePageView({ resource_id: "/quotes" });

  // 支持 ?tab= 深链（工位内部引用/分享）。
  // 刻意不用 useSearchParams：静态导出下它需要 Suspense 边界，易踩坑。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (isTab(t)) setTab(t);
  }, []);

  const switchTab = (next: QuoteTab) => {
    setTab(next);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (next === "product") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url.toString());
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">报价</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          定价数据 → 算价 → 报价记录，一条线走完
        </p>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.hint}
            onClick={() => switchTab(t.key)}
            className={cn(
              "-mb-px whitespace-nowrap border-b-2 px-4 pb-2 text-sm transition-colors",
              tab === t.key
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "product" && <ProductQuoteView />}
      {tab === "bulk" && <BulkImportPanel />}
      {tab === "records" && <QuotationRecordsView />}
      {tab === "pricing" && <PricingDataManager embedded />}
    </div>
  );
}
