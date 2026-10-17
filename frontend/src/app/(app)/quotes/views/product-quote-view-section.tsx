"use client";

/**
 * 报价参数区的两个共用小件（从 product-quote-view 拆出）：
 *
 * - `SectionTitle`：参数分组标题（计算顺序分组，参数多了才读得下去）；
 * - `PieceInputField`：可按件改写的参数输入框（单件米数/卷径等共用，
 *   样式与提示语一致，不会各写一份走样）。
 *
 * 两者都是纯展示组件 —— 值与换算由调用方算好传进来。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PieceInput } from "@contracts/export-quote";

/** 参数变多之后，靠「按计算顺序分组 + 分组标题」才读得下去。 */
export function SectionTitle({
  index,
  title,
  hint,
}: {
  index: number;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t pt-4">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        {index}
      </span>
      <h3 className="text-xs font-medium">{title}</h3>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * 一个「可按件改写」的参数输入框。
 *
 * 单件米数、卷径等全部共用这一个组件 —— 样式与提示语一致，
 * 不会因为各写一份而走样。单位换算与默认值都由调用方算好传进来。
 */
export function PieceInputField({
  pi,
  value,
  defaultHint,
  onChange,
}: {
  pi: PieceInput;
  value: string;
  defaultHint: string;
  onChange: (v: string) => void;
}) {
  const unit = pi.ui_unit || pi.unit;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">
        {pi.label}
        {unit ? `（${unit}）` : ""}
      </Label>
      <Input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-xs"
      />
      <p className="text-[11px] text-muted-foreground">
        默认跟随规格（{defaultHint || "—"}）
      </p>
    </div>
  );
}
