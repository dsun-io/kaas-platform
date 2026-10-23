"use client";

/**
 * 报价工作台 · 产品行区（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 产品行排序：拖拽（2026-10-22）。
 * 保存时 `items()` 会按数组下标重写 `sort_order: i`，所以"拖完即顺序"，
 * 不需要额外接口 —— 这也是这里用本地重排而不是 PATCH 的原因。
 * 注意 `termsByLine.terms` 也是按 lines 下标算的，重排后自动跟着对齐。
 *
 * 「添加产品」的弹窗开合是本区局部状态（拆分前在 view 里，没有别的消费方），
 * 这样控制器不必为一段纯 UI 状态承担职责。
 */
import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SortableGrip, SortableList } from "@/components/shared/sortable-list";

import { QuoteLineCard, newLineDraft } from "../components/quote-line-card";
import { WorkbenchProductAddDialog } from "./workbench-product-add-dialog";
import type { QuoteWorkbenchController } from "./use-quote-workbench";

export function WorkbenchProductSection({
  wb,
}: {
  wb: QuoteWorkbenchController;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addPick, setAddPick] = useState("");

  const products = wb.productOptions.data?.products ?? [];

  return (
    <>
      <SortableList
        items={wb.lines}
        onReorder={wb.setLines}
        className="space-y-5"
        renderItem={(line, index) => (
          <QuoteLineCard
            index={index}
            line={line}
            shared={wb.shared}
            view={wb.view}
            terms={wb.termsByLine?.terms[index] ?? null}
            lineCount={wb.lines.length}
            customerId={wb.customer?.id ?? null}
            productTaxMap={wb.productTaxMap}
            calcSignal={wb.calcSignal}
            grip={
              <SortableGrip
                className="mr-1 inline-flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded align-middle text-muted-foreground hover:bg-muted"
                label={`拖动排序 产品行 ${index + 1}`}
              />
            }
            onChange={(patch) =>
              wb.setLines((prev) =>
                prev.map((l) => (l.id === line.id ? { ...l, ...patch } : l)),
              )
            }
            onRemove={() =>
              wb.setLines((prev) => prev.filter((l) => l.id !== line.id))
            }
          />
        )}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => wb.setCalcSignal((v) => v + 1)}
          className="flex-1 sm:flex-none"
        >
          整单报价（计算全部行）
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const first = wb.productOptions.data?.products?.[0]?.key ?? "";
            setAddPick(first);
            setAddOpen(true);
          }}
        >
          <Plus className="mr-1.5 size-4" />
          添加产品
        </Button>
      </div>

      {addOpen && (
        <WorkbenchProductAddDialog
          products={products}
          value={addPick}
          onChange={setAddPick}
          onClose={() => setAddOpen(false)}
          onConfirm={() => {
            wb.setLines((prev) => [...prev, newLineDraft(addPick)]);
            setAddOpen(false);
          }}
        />
      )}
    </>
  );
}
