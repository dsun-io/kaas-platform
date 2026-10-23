"use client";

/**
 * 报价工作台 · 底部吸底动作条（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * <xl 时保存/签发按钮会被长表单推得很远 ⇒ 吸底常驻；≥xl 由右侧汇总卡接管。
 * 签发与汇总卡共用 `QuoteIssueButton`（二次确认 + 防重一致）。
 */
import { Button } from "@/components/ui/button";

import { QuoteIssueButton } from "../components/quote-issue-button";
import type { QuoteWorkbenchController } from "./use-quote-workbench";

export function WorkbenchStickyActions({
  wb,
}: {
  wb: QuoteWorkbenchController;
}) {
  return (
    <div className="fixed inset-x-3 bottom-3 z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/70 bg-white/85 py-2 pl-4 pr-16 shadow-lg backdrop-blur-xl xl:hidden">
      <div className="text-xs text-muted-foreground">
        总额{" "}
        <b className="text-foreground tabular-nums">
          {wb.summary.totalAmount.toFixed(2)}
        </b>{" "}
        {wb.quoteCurrency}
        <span className="mx-1.5">·</span>
        {wb.summary.lineCount} 个产品行
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={wb.summary.lineCount === 0 || wb.saving}
          onClick={wb.onSave}
        >
          {wb.savedDoc ? "保存修改" : "保存"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            wb.summary.lineCount === 0 ||
            wb.generating ||
            wb.docPick.length === 0
          }
          onClick={wb.onGenerateDocs}
        >
          单证（{wb.docPick.length}）
        </Button>
        {/* P0-B1/Q2：与右侧汇总卡同一个签发组件（确认 + 防重一致） */}
        <QuoteIssueButton
          quoteOrderId={wb.savedDoc?.id ?? null}
          quoteNo={wb.savedDoc?.quote_no ?? null}
          status={wb.savedDoc?.status ?? null}
          onIssued={wb.handleIssued}
          label="签发"
          className=""
        />
      </div>
    </div>
  );
}
