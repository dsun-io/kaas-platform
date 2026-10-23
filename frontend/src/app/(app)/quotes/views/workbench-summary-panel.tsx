"use client";

/**
 * 报价工作台 · 右侧汇总区（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 汇总卡本体的口径与单证 TOTAL 同源（见 `components/quote-summary-card.tsx`）；
 * 这里只负责把控制器的派生数据与动作接上去。
 */
import { QuoteSummaryCard } from "../components/quote-summary-card";
import type { QuoteWorkbenchController } from "./use-quote-workbench";

export function WorkbenchSummaryPanel({
  wb,
}: {
  wb: QuoteWorkbenchController;
}) {
  return (
    <aside className="space-y-4 xl:sticky xl:top-4 xl:self-start">
      <QuoteSummaryCard
        summary={wb.summary}
        currency={wb.quoteCurrency}
        effectiveVolume={wb.effectiveVolume}
        missing={wb.missing}
        amortizedFees={wb.termsByLine?.amortized ?? []}
        docTypes={wb.docTypes}
        docPick={wb.docPick}
        onDocPickChange={wb.setDocPick}
        onGenerateDocs={wb.onGenerateDocs}
        onSave={wb.onSave}
        onIssued={wb.handleIssued}
        saving={wb.saving}
        generating={wb.generating}
        saved={wb.savedDoc}
        notice={wb.notice}
      />
    </aside>
  );
}
