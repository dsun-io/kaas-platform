"use client";

/**
 * 报价工作台 · 添加产品弹窗（从 `quote-workbench-view.tsx` 抽出，行为不变）。
 *
 * 先选产品、确定后才在行内选规格 —— 规格决定成本/重量/体积，
 * 没选产品时选规格没有意义。
 */
import { Button } from "@/components/ui/button";
import type { ExportProduct } from "@contracts/export-quote";

export function WorkbenchProductAddDialog({
  products,
  value,
  onChange,
  onClose,
  onConfirm,
}: {
  products: readonly ExportProduct[];
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border bg-background p-4 shadow-xl">
        <h3 className="text-sm font-semibold">添加产品</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          先选产品，确定后再在行内选择规格（规格决定成本/重量/体积）。
        </p>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-3 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {products.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={!value} onClick={onConfirm}>
            添加
          </Button>
        </div>
      </div>
    </div>
  );
}
