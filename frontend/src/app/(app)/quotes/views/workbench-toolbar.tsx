"use client";

/**
 * 报价工作台 · 顶部工具条（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * C19：批量导入与单条报价并列（同一层的两种工作方式），入口放在顶部，
 * 不塞进任何产品行卡片里。
 */
import { BulkImportEntry } from "../../quotations/v2-quote/components/bulk-import-dialog";

export function WorkbenchToolbar() {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-sm font-medium">单条报价</div>
        <p className="text-xs text-muted-foreground">
          逐行算价 → 汇总 →
          存成报价单；客户直接给整张表格时，用右侧「批量导入表格」一次算完。
        </p>
      </div>
      <BulkImportEntry />
    </div>
  );
}
